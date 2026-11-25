/**
 * One install as a Durable Object: SQLite holds the data, and an optional R2 bucket holds attachments,
 * and its alarm checks the mailboxes for new email. Several objects can share an isolate, so each one
 * owns a tenant and every entry point runs inside it.
 */
import { DurableObject } from 'cloudflare:workers'
import crypto from 'node:crypto'
import { z } from 'zod'
import { readConfig } from '../server/config.ts'
import { get } from '../server/db.ts'
import type { Driver } from '../server/db.ts'
import type { BlobStore } from '../server/blobs.ts'
import { activeTenant, createTenant, runInTenant, type Tenant } from '../server/tenant.ts'
import { createApp, prepareData } from '../server/app.ts'
import { HibernatingEvents } from './live.ts'
import { subscribe } from '../server/events.ts'
import { pruneSessions } from '../server/auth.ts'
import { rpcError, RESTORE_WINDOW_MS, type WorkspaceRestoreRpc, type ControlPlane, type Health, type PlanState, type SmtpCredential } from '../server/hosted.ts'
import { health, provision, setPlan, setSmtp, setWorkspaceName, type ProvisionInput } from '../server/services/provision.ts'
import { ingestInbound, nextIngestCleanupAt, pruneInboundIngests, noteBounce, setSendingDomain } from '../server/services/managed.ts'
import { exportArchive } from '../server/services/export.ts'
import { pollAllMailboxes, stopAllMailboxes } from '../server/mail/imap.ts'
import { dispatchQueued, nextRetryAt } from '../server/mail/outbound.ts'
import { deliverResetOutbox, nextResetAt } from '../server/services/accounts.ts'
import { dispatchScheduled, nextScheduledAt, wakeSnoozed } from '../server/services/conversations.ts'
import { importStatus, importStep } from '../server/services/import-helpscout.ts'

export interface StoreEnv {
  /** Which upload of the code is running. The Worker and the Durable Object can briefly differ after a deploy. */
  CF_VERSION_METADATA?: { id: string; timestamp: string }
  CONTROL?: ControlPlane
  /** "1" when a control plane runs many workspaces. Self-hosted installs never set it. */
  ANSA_HOSTED?: string
  ATTACHMENTS?: R2Bucket
  [name: string]: unknown
}

export const codeStamp = (env: StoreEnv) => Date.parse(env.CF_VERSION_METADATA?.timestamp || '') || 0
export const CODE_HEADER = 'x-ansa-code'

const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}(?![\s\S])/).brand<'WorkspaceId'>()

export function readWorkspaceId(ctx: DurableObjectState, env: StoreEnv) {
  const stored = ctx.storage.kv.get<unknown>('workspaceId')
  if (stored == null && env.ANSA_HOSTED === '1') {
    throw Object.assign(new Error('Workspace has not been provisioned.'), { name: 'NotProvisioned' })
  }
  const parsed = workspaceIdSchema.safeParse(stored ?? 'main')
  if (!parsed.success) throw Object.assign(new Error('Invalid workspace ID.'), { name: 'Invalid' })
  return parsed.data
}

// Several workspaces share an isolate and its console, so each line names the workspace that wrote it.
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const write = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    const workspaceId = activeTenant()?.workspaceId
    if (workspaceId) write(`[ws ${workspaceId}]`, ...args)
    else write(...args)
  }
}

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
    put: async (key, data) =>
      ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM _blobs WHERE key = ?', key)
        for (let seq = 0, at = 0; at < data.byteLength || seq === 0; seq++, at += CHUNK) {
          sql.exec('INSERT INTO _blobs (key, seq, data) VALUES (?, ?, ?)', key, seq, toBuffer(data.subarray(at, at + CHUNK)))
        }
      }),
    get: async (key) => {
      const parts = sql.exec('SELECT data FROM _blobs WHERE key = ? ORDER BY seq', key).toArray().map((row) => new Uint8Array(row.data as ArrayBuffer))
      if (parts.length === 0) return null
      const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
      let at = 0
      for (const part of parts) {
        out.set(part, at)
        at += part.byteLength
      }
      return { body: out, size: out.byteLength }
    },
    remove: async (keys) => {
      for (const key of keys) sql.exec('DELETE FROM _blobs WHERE key = ?', key)
    },
  }
}

function r2Blobs(bucket: R2Bucket, workspaceId: () => string): BlobStore {
  const objectKey = (key: string) => `ws/${workspaceId()}/${key}`
  return {
    put: async (key, data) => { await bucket.put(objectKey(key), data) },
    get: async (key) => {
      const object = await bucket.get(objectKey(key))
      return object ? { body: object.body, size: object.size } : null
    },
    remove: async (keys) => {
      const prefix = `ws/${workspaceId()}/`
      for (let at = 0; at < keys.length; at += 1000) {
        await bucket.delete(keys.slice(at, at + 1000).map((key) => prefix + key))
      }
    },
  }
}

// R2 wants every part but the last to have the same size.
const EXPORT_PART = 8 * 1024 * 1024
const EXPORTS_KEPT_FOR = 7 * 86_400_000

async function* inParts(chunks: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let part = new Uint8Array(size)
  let filled = 0
  for await (const chunk of chunks) {
    for (let at = 0; at < chunk.length; ) {
      const take = Math.min(size - filled, chunk.length - at)
      part.set(chunk.subarray(at, at + take), filled)
      filled += take
      at += take
      if (filled === size) {
        yield part
        part = new Uint8Array(size)
        filled = 0
      }
    }
  }
  yield part.subarray(0, filled)
}

async function removePrefix(bucket: R2Bucket, prefix: string, olderThan = Infinity) {
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 })
    const keys = page.objects.filter((object) => object.uploaded.getTime() < olderThan).map((object) => object.key)
    if (keys.length) await bucket.delete(keys)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
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

export class AnsaStore extends DurableObject<StoreEnv> implements WorkspaceRestoreRpc {
  private tenant: Tenant
  private app: ReturnType<typeof createApp>
  private live: HibernatingEvents

  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env)
    const config = readConfig((name) => (typeof env[name] === 'string' ? env[name] : undefined))
    if (config.hosted && !env.ATTACHMENTS) throw new Error('ATTACHMENTS is required in hosted mode.')

    if (!config.secret) config.secret = storedSecret(ctx)
    if (!config.appUrlFixed) config.appUrl = ctx.storage.kv.get<string>('appUrl') ?? config.appUrl
    config.imapPollOnly = true

    this.tenant = createTenant({ config, db: sqliteDriver(ctx), blobs: env.ATTACHMENTS ? r2Blobs(env.ATTACHMENTS, () => readWorkspaceId(ctx, env)) : sqliteBlobs(ctx) })
    this.tenant.control = env.CONTROL ?? null
    this.tenant.workspaceId = config.hosted ? (ctx.storage.kv.get<string>('workspaceId') ?? null) : null
    this.tenant.deadlineChanged = () => void this.inTenant(() => this.scheduleAlarm()).catch((err) => console.error('[alarm]', err))
    this.live = new HibernatingEvents(ctx)
    this.tenant.liveEvents = {
      kind: 'websocket',
      connect: (user, credential) => this.live.connect(user, credential),
      viewers: () => this.live.viewers(),
    }
    this.app = this.inTenant(() => {
      prepareData()
      subscribe((event) => this.live.broadcast(event))
      return createApp()
    })
    this.inTenant(() => this.reportHealth())
  }

  private hostedWorkspaceId(): string {
    const workspaceId = this.tenant.config.hosted ? this.ctx.storage.kv.get<string>('workspaceId') : undefined
    if (!workspaceId) throw rpcError('NotProvisioned', 'This workspace is not provisioned yet.')
    return workspaceId
  }

  private reportHealth() {
    const control = this.env.CONTROL
    const workspaceId = this.tenant.workspaceId
    if (!control || !workspaceId) return
    const report: Health = health()
    const stamp = JSON.stringify(report)
    if (this.ctx.storage.kv.get<string>('healthReported') === stamp) return
    this.ctx.waitUntil(
      control.reportHealth(workspaceId, report).then(
        () => this.ctx.storage.kv.put('healthReported', stamp),
        (err) => this.inTenant(() => console.error('[health] report failed:', (err as Error).message)),
      ),
    )
  }

  protected inTenant<T>(fn: () => T): T {
    return runInTenant(this.tenant, fn)
  }

  async provision(input: ProvisionInput): Promise<{ signInUrl: string }> {
    return this.inTenant(() => {
      const result = provision(input)
      this.ctx.storage.kv.put('workspaceId', input.workspaceId)
      this.reportHealth()
      return result
    })
  }

  async setPlan(planState: PlanState): Promise<void> {
    this.inTenant(() => setPlan(planState))
  }

  async setSmtp(smtp: SmtpCredential): Promise<void> {
    this.inTenant(() => setSmtp(smtp))
  }

  async setWorkspaceName(name: string): Promise<void> {
    this.inTenant(() => setWorkspaceName(name))
  }

  async health(): Promise<Health> {
    return this.inTenant(health)
  }

  async ingestInbound(input: { mailboxId: number; raw?: ArrayBuffer; r2Key?: string }): Promise<'accepted' | 'duplicate'> {
    return this.inTenant(async () => {
      this.hostedWorkspaceId()
      try {
        return await ingestInbound(input.mailboxId, await this.inboundBytes(input))
      } finally {
        await this.scheduleAlarm()
      }
    })
  }

  private async inboundBytes(input: { raw?: ArrayBuffer; r2Key?: string }): Promise<Uint8Array> {
    if (input.raw instanceof ArrayBuffer) return new Uint8Array(input.raw)
    if (typeof input.r2Key !== 'string' || !this.env.ATTACHMENTS) throw rpcError('Invalid', 'Pass the message as raw bytes or as an R2 key.')
    const workspaceId = this.hostedWorkspaceId()
    if (!input.r2Key.startsWith(`inbound/${workspaceId}/`) && !input.r2Key.startsWith(`ws/${workspaceId}/`)) throw rpcError('Invalid', 'That R2 key is not inbound mail for this workspace.')
    const object = await this.env.ATTACHMENTS.get(input.r2Key)
    if (!object) throw rpcError('NotFound', 'No message is stored under that R2 key.')
    return new Uint8Array(await object.arrayBuffer())
  }

  async setSendingDomain(input: Parameters<typeof setSendingDomain>[0]): Promise<void> {
    this.inTenant(() => {
      this.hostedWorkspaceId()
      setSendingDomain(input)
    })
  }

  async noteBounce(input: Parameters<typeof noteBounce>[0]): Promise<void> {
    this.inTenant(() => {
      this.hostedWorkspaceId()
      noteBounce(input)
    })
  }

  async exportWorkspace(): Promise<{ r2Key: string }> {
    return this.inTenant(async () => {
      const bucket = this.env.ATTACHMENTS
      if (!bucket) throw rpcError('Invalid', 'Exports need the ATTACHMENTS bucket.')
      const prefix = `ws/${this.hostedWorkspaceId()}/exports/`
      await removePrefix(bucket, prefix, Date.now() - EXPORTS_KEPT_FOR)
      const r2Key = `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(8).toString('hex')}.zip`
      const upload = await bucket.createMultipartUpload(r2Key, { httpMetadata: { contentType: 'application/zip' } })
      try {
        const parts: R2UploadedPart[] = []
        for await (const part of inParts(exportArchive(), EXPORT_PART)) parts.push(await upload.uploadPart(parts.length + 1, part))
        await upload.complete(parts)
      } catch (err) {
        await upload.abort().catch(() => {})
        throw err
      }
      return { r2Key }
    })
  }

  private restoreTime(atMs: unknown): number {
    const now = Date.now()
    const parsed = z.number().int().safeParse(atMs)
    if (!parsed.success) throw rpcError('Invalid', 'The restore time must be a whole number of epoch milliseconds.')
    if (parsed.data > now) throw rpcError('Invalid', 'The restore time is in the future.')
    if (parsed.data < now - RESTORE_WINDOW_MS) throw rpcError('Invalid', 'The restore time is more than 30 days ago.')
    return parsed.data
  }

  async restoreBookmark(atMs: number): Promise<string> {
    this.hostedWorkspaceId()
    return this.ctx.storage.getBookmarkForTime(this.restoreTime(atMs))
  }

  async restoreTo(atMs: number, confirm: string): Promise<void> {
    const workspaceId = this.hostedWorkspaceId()
    if (confirm !== workspaceId) throw rpcError('Invalid', 'The confirmation does not match this workspace ID.')
    const bookmark = await this.ctx.storage.getBookmarkForTime(this.restoreTime(atMs))
    const undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark)
    console.warn(`[restore] restoring to ${new Date(atMs).toISOString()}. Undo bookmark: ${undo}`)
    this.ctx.abort('Restoring to an earlier point in time.')
  }

  async deleteWorkspace(): Promise<void> {
    if (!this.tenant.config.hosted) throw rpcError('Invalid', 'This install is not in hosted mode.')
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'This workspace was deleted.')
    await this.inTenant(stopAllMailboxes)
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    // The object lives on in memory. Give it the empty state a fresh one starts with, under a new secret.
    const { tenant } = this
    tenant.config.secret = storedSecret(this.ctx)
    tenant.workspaceId = null
    tenant.listeners.clear()
    tenant.presence.clear()
    tenant.autoReplyLog.clear()
    this.inTenant(prepareData)
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
    const mine = codeStamp(this.env)
    const theirs = Number(request.headers.get(CODE_HEADER) || 0)
    if (mine && theirs > mine && (request.method === 'GET' || request.method === 'HEAD')) this.ctx.abort('A newer version was deployed.')

    return this.inTenant(async () => {
      this.learnUrl(request)
      const response = await this.app.fetch(request)
      await this.scheduleAlarm()
      if (request.method !== 'GET' && request.method !== 'HEAD') this.reportHealth()
      const out = response.status === 101 ? response : new Response(response.body, response)
      out.headers.set(CODE_HEADER, String(mine))
      return out
    })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    return this.inTenant(() => this.live.message(socket, message))
  }

  webSocketClose(socket: WebSocket) {
    return this.inTenant(() => this.live.close(socket))
  }

  webSocketError(socket: WebSocket) {
    return this.inTenant(() => this.live.close(socket, 1011))
  }

  private pollDeadline(): number | null {
    if (this.tenant.config.mailDisabled || !get(`SELECT 1 FROM mailboxes WHERE imap_enabled = 1 AND imap_host != '' LIMIT 1`)) return null
    const stored = this.ctx.storage.kv.get<number>('nextPollAt')
    if (stored !== undefined) return stored
    const at = Date.now() + Math.max(10, this.tenant.config.imapPollSeconds) * 1000
    this.ctx.storage.kv.put('nextPollAt', at)
    return at
  }

  private importDeadline(): number | null {
    const state = importStatus()
    if (state.status !== 'running') {
      this.ctx.storage.kv.delete('nextImportStepAt')
      return null
    }
    let at = this.ctx.storage.kv.get<number>('nextImportStepAt')
    if (at === undefined) {
      at = Date.now() + 1000
      this.ctx.storage.kv.put('nextImportStepAt', at)
    }
    return Math.max(at, state.waitUntil)
  }

  protected async scheduleAlarm() {
    const snoozed = get<{ at: number | null }>('SELECT MIN(snoozed_until) AS at FROM conversations WHERE snoozed_until IS NOT NULL')?.at ?? null
    const deadlines = [nextScheduledAt(), nextRetryAt(), nextResetAt(), nextIngestCleanupAt(), snoozed, this.pollDeadline(), this.importDeadline()].filter((at): at is number => at !== null)
    const current = await this.ctx.storage.getAlarm()
    if (deadlines.length === 0) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    const floor = Date.now() + 1000
    if (current !== null && current <= floor) return
    const at = Math.max(floor, Math.min(...deadlines))
    if (current !== at) await this.ctx.storage.setAlarm(at)
  }

  async alarm() {
    await this.inTenant(async () => {
      const jobs = [
        ['wakeSnoozed', () => wakeSnoozed()],
        ['deliverResetOutbox', () => deliverResetOutbox()],
        ['pruneSessions', () => pruneSessions()],
        ['pruneInboundIngests', () => pruneInboundIngests()],
        ['importStep', async () => {
          try {
            await importStep()
          } finally {
            this.ctx.storage.kv.put('nextImportStepAt', Date.now() + 1000)
          }
        }],
        ['dispatchScheduled', () => dispatchScheduled()],
        ['dispatchQueued', () => dispatchQueued()],
        ['pollAllMailboxes', async () => {
          const pollAt = this.pollDeadline()
          if (pollAt !== null && pollAt <= Date.now()) {
            try {
              await pollAllMailboxes()
            } finally {
              this.ctx.storage.kv.put('nextPollAt', Date.now() + Math.max(10, this.tenant.config.imapPollSeconds) * 1000)
            }
          }
        }],
      ] satisfies [string, () => unknown][]
      try {
        for (const [job, run] of jobs) {
          try {
            await run()
          } catch (err) {
            console.error('[alarm]', { workspaceId: readWorkspaceId(this.ctx, this.env), job }, err)
          }
        }
      } finally {
        await this.scheduleAlarm()
      }
    })
  }
}
