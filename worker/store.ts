/**
 * One install as a Durable Object: its built-in SQLite database holds the data and the attachments,
 * and its alarm checks the mailboxes for new email. Several objects can share an isolate, so each one
 * owns a tenant and every entry point runs inside it.
 */
import { DurableObject } from 'cloudflare:workers'
import crypto from 'node:crypto'
import { readConfig } from '../server/config.ts'
import { get } from '../server/db.ts'
import type { Driver } from '../server/db.ts'
import type { BlobStore } from '../server/blobs.ts'
import { createTenant, runInTenant, type Tenant } from '../server/tenant.ts'
import { createApp, prepareData, startTimers } from '../server/app.ts'
import { pruneSessions } from '../server/auth.ts'
import type { ControlPlane, PlanState, SmtpCredential } from '../server/hosted.ts'
import { health, provision, setPlan, setSmtp, type ProvisionInput } from '../server/services/provision.ts'
import { pollAllMailboxes } from '../server/mail/imap.ts'
import { dispatchScheduled, nextScheduledAt, wakeSnoozed } from '../server/services/conversations.ts'
import { importIsRunning, importStep } from '../server/services/import-helpscout.ts'

export interface StoreEnv {
  /** Which upload of the code is running. The Worker and the Durable Object can briefly differ after a deploy. */
  CF_VERSION_METADATA?: { id: string; timestamp: string }
  CONTROL?: ControlPlane
  /** "1" when a control plane runs many workspaces. Self-hosted installs never set it. */
  ANSA_HOSTED?: string
  [name: string]: unknown
}

/** When the running code was uploaded, as a number. 0 when unknown (local development). */
export const codeStamp = (env: StoreEnv) => Date.parse(env.CF_VERSION_METADATA?.timestamp || '') || 0
export const CODE_HEADER = 'x-ansa-code'

const CHUNK = 1024 * 1024
const toBuffer = (value: unknown) => (value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value)

function sqliteDriver(ctx: DurableObjectState): Driver {
  const { sql } = ctx.storage
  return {
    all: (query, params) => sql.exec(query, ...params.map(toBuffer)).toArray(),
    run: (query, params) => {
      sql.exec(query, ...params.map(toBuffer)).toArray()
      const row = sql.exec('SELECT last_insert_rowid() AS id, changes() AS changes').one()
      return { id: Number(row.id), changes: Number(row.changes) }
    },
    exec: (query) => void sql.exec(query).toArray(),
    transaction: (fn) => ctx.storage.transactionSync(fn),
  }
}

function sqliteBlobs(ctx: DurableObjectState): BlobStore {
  const { sql } = ctx.storage
  sql.exec('CREATE TABLE IF NOT EXISTS _blobs (key TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, seq)) WITHOUT ROWID')
  return {
    put: (key, data) =>
      ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM _blobs WHERE key = ?', key)
        for (let seq = 0, at = 0; at < data.byteLength || seq === 0; seq++, at += CHUNK) {
          sql.exec('INSERT INTO _blobs (key, seq, data) VALUES (?, ?, ?)', key, seq, toBuffer(data.subarray(at, at + CHUNK)))
        }
      }),
    get: (key) => {
      const parts = sql.exec('SELECT data FROM _blobs WHERE key = ? ORDER BY seq', key).toArray().map((row) => new Uint8Array(row.data as ArrayBuffer))
      if (parts.length === 0) return null
      const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
      let at = 0
      for (const part of parts) {
        out.set(part, at)
        at += part.byteLength
      }
      return out
    },
    remove: (key) => void sql.exec('DELETE FROM _blobs WHERE key = ?', key),
  }
}

function storedSecret(ctx: DurableObjectState): string {
  const { kv } = ctx.storage
  let secret = kv.get<string>('secret')
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex')
    kv.put('secret', secret)
  }
  return secret
}

export class AnsaStore extends DurableObject<StoreEnv> {
  private tenant: Tenant
  private app: ReturnType<typeof createApp>

  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env)
    if (env.ANSA_HOSTED === '1' && env.APP_SECRET) {
      throw new Error('APP_SECRET is set in hosted mode. Remove it: every workspace must keep its own generated secret.')
    }

    const config = readConfig((name) => (typeof env[name] === 'string' ? env[name] : undefined))
    if (!config.secret) config.secret = storedSecret(ctx)
    if (!config.appUrlFixed) config.appUrl = ctx.storage.kv.get<string>('appUrl') ?? config.appUrl
    config.imapPollOnly = true

    this.tenant = createTenant({ config, db: sqliteDriver(ctx), blobs: sqliteBlobs(ctx) })
    this.app = this.inTenant(() => {
      prepareData()
      startTimers()
      return createApp()
    })
    this.tenant.control = env.CONTROL ?? null
  }

  /** Every way into this object (fetch, alarm, RPC methods) does its work through here. */
  protected inTenant<T>(fn: () => T): T {
    return runInTenant(this.tenant, fn)
  }

  async provision(input: ProvisionInput): Promise<{ signInUrl: string }> {
    return this.inTenant(() => provision(input))
  }

  async setPlan(planState: PlanState): Promise<void> {
    this.inTenant(() => setPlan(planState))
  }

  async setSmtp(smtp: SmtpCredential): Promise<void> {
    this.inTenant(() => setSmtp(smtp))
  }

  async health(): Promise<{ schemaVersion: number; coreVersion: string; mailboxes: number; users: number }> {
    return this.inTenant(health)
  }

  /** Without APP_URL, links in emails use the address people actually sign in on. */
  private learnUrl(request: Request) {
    const { config } = this.tenant
    if (config.appUrlFixed) return
    const url = new URL(request.url)
    const known = this.ctx.storage.kv.get<string>('appUrl')
    if (known && !(request.method === 'POST' && url.pathname === '/api/login')) return
    if (known !== url.origin) this.ctx.storage.kv.put('appUrl', url.origin)
    config.appUrl = url.origin
  }

  async fetch(request: Request): Promise<Response> {
    // After a deploy, Cloudflare replaces this object only once no request is in flight. An open
    // browser tab holds a live-update stream, so the old code could stay for hours. When the Worker
    // in front says it runs newer code, restart now. Only on a read, which the Worker can repeat.
    const mine = codeStamp(this.env)
    const theirs = Number(request.headers.get(CODE_HEADER) || 0)
    if (mine && theirs > mine && (request.method === 'GET' || request.method === 'HEAD')) this.ctx.abort('A newer version was deployed.')

    return this.inTenant(async () => {
      this.learnUrl(request)
      const response = await this.app.fetch(request)
      await this.scheduleAlarm()
      const out = new Response(response.body, response)
      out.headers.set(CODE_HEADER, String(mine))
      return out
    })
  }

  private lastPoll = 0

  /** The alarm is the only thing that wakes this object without a visitor, so keep one set while there is work. */
  private async scheduleAlarm() {
    const { config } = this.tenant
    // An import runs as a chain of short alarms: each one may only make a few dozen requests.
    if (importIsRunning()) {
      const current = await this.ctx.storage.getAlarm()
      if (current === null || current > Date.now() + 3000) await this.ctx.storage.setAlarm(Date.now() + 1000)
      return
    }
    // A scheduled reply goes out on time, not at the next mail check.
    const due = nextScheduledAt()
    if (due !== null) {
      const at = Math.max(Date.now() + 1000, due)
      const current = await this.ctx.storage.getAlarm()
      if (current === null || current > at) await this.ctx.storage.setAlarm(at)
    }
    const polling = !config.mailDisabled && get(`SELECT 1 FROM mailboxes WHERE imap_enabled = 1 AND imap_host != '' LIMIT 1`)
    const snoozed = get('SELECT 1 FROM conversations WHERE snoozed_until IS NOT NULL LIMIT 1')
    if (!polling && !snoozed) return
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + Math.max(10, config.imapPollSeconds) * 1000)
  }

  async alarm() {
    await this.inTenant(async () => {
      try {
        await importStep()
        await dispatchScheduled()
        // Mail is checked on its own schedule, however often the alarm fires.
        if (Date.now() - this.lastPoll >= Math.max(10, this.tenant.config.imapPollSeconds) * 1000 - 500) {
          this.lastPoll = Date.now()
          wakeSnoozed()
          pruneSessions()
          await pollAllMailboxes()
        }
      } catch (err) {
        console.error('[alarm]', err)
      } finally {
        await this.scheduleAlarm()
      }
    })
  }
}
