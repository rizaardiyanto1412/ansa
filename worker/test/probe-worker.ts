import { logged } from './log-capture.ts'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { EventEmitter } from 'node:events'
import { currentTenant } from '../../server/tenant.ts'
import { checkBlobStore } from '../../server/test/blob-probe.ts'
import { decrypt, encrypt } from '../../server/crypto.ts'
import { all, get, getSetting, run } from '../../server/db.ts'
import type { BillingLinks, DomainResult, Health, SystemEmail } from '../../server/hosted.ts'
import { addReply, createConversation } from '../../server/services/conversations.ts'
import { interleavings, openSealed, probe } from '../../server/test/tenant-probe.ts'
import { publish } from '../../server/events.ts'
import { AnsaStore, type StoreEnv } from '../store.ts'

interface Env extends StoreEnv {
  ANSA: DurableObjectNamespace
}

function scheduleDueReply(): number {
  const mailboxId = run(`INSERT INTO mailboxes (name, email, created_at) VALUES ('Support', 'support@shared.test', 1)`).id
  const agentId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Agent', 'agent@shared.test', 'x', 'admin', 1)`).id
  const conversation = createConversation({ mailboxId, customerEmail: 'customer@shared.test', subject: 'Later', bodyHtml: '<p>Help</p>', kind: 'customer' }, { userId: null, via: 'email' })
  const threadId = addReply(conversation.id, { bodyHtml: '<p>Tomorrow</p>', sendAt: Date.now() + 3_600_000 }, { userId: agentId, via: 'web' })
  run('UPDATE threads SET send_at = ? WHERE id = ?', Date.now() - 1000, threadId)
  return threadId
}

const failure = (err: unknown) => new Response(err instanceof Error ? err.stack || err.message : String(err), { status: 500 })

const RPC_METHODS = ['provision', 'setPlan', 'setSmtp', 'health', 'ingestInbound', 'setSendingDomain', 'noteBounce', 'exportWorkspace', 'deleteWorkspace']
type RpcStub = Record<string, (...input: unknown[]) => Promise<unknown>>

interface ControlScript {
  fallback: 'ok' | 'rate-limited'
  retryAt: number
  domain: DomainResult['status']
}

const DNS_RECORDS: DomainResult['records'] = [
  { type: 'CNAME', host: 'ps1._domainkey.acme.test', value: 'dkim.postshiba.test' },
  { type: 'CNAME', host: 'bounce.acme.test', value: 'return.postshiba.test' },
]

export class ProbeStore extends AnsaStore {
  private sent: unknown[] = []
  private controlCalls: { method: string; args: unknown[] }[] = []
  private script: ControlScript = { fallback: 'ok', retryAt: 0, domain: 'pending' }

  async keepMail(mail: unknown) {
    this.sent.push(mail)
  }

  constructor(ctx: DurableObjectState, env: StoreEnv) {
    const interval = globalThis.setInterval
    const timeout = globalThis.setTimeout
    let timers = 0
    globalThis.setInterval = Object.assign((...args: Parameters<typeof interval>) => {
      timers++
      return interval(...args)
    }, interval)
    globalThis.setTimeout = Object.assign((...args: Parameters<typeof timeout>) => {
      timers++
      return timeout(...args)
    }, timeout)
    try {
      super(ctx, env)
    } finally {
      globalThis.setInterval = interval
      globalThis.setTimeout = timeout
    }
    ctx.storage.kv.put('test:constructorTimers', (ctx.storage.kv.get<number>('test:constructorTimers') ?? 0) + timers)
    ctx.storage.kv.put('test:constructors', (ctx.storage.kv.get<number>('test:constructors') ?? 0) + 1)
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    this.ctx.storage.kv.put('test:messages', (this.ctx.storage.kv.get<number>('test:messages') ?? 0) + 1)
    return super.webSocketMessage(socket, message)
  }

  async controlCall(method: string, args: unknown[]): Promise<ControlScript> {
    this.controlCalls.push({ method, args })
    return this.script
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      switch (url.pathname) {
        case '/__presence-at': {
          const now = Date.now
          const at = Number(url.searchParams.get('at'))
          Date.now = () => at
          try {
            return Response.json(this.inTenant(() => {
              const live = currentTenant().liveEvents
              if (live.kind !== 'websocket') throw new Error('Expected WebSocket transport')
              return live.viewers()
            }))
          } finally {
            Date.now = now
          }
        }
        case '/__run-alarm':
          await this.alarm()
          return Response.json({ alarm: await this.ctx.storage.getAlarm() })
        case '/__schedule': {
          await this.inTenant(() => this.scheduleAlarm())
          return Response.json({ alarm: await this.ctx.storage.getAlarm() })
        }
        case '/__lifecycle':
          return Response.json({ sockets: this.ctx.getWebSockets().length, constructors: this.ctx.storage.kv.get('test:constructors'), messages: this.ctx.storage.kv.get('test:messages') ?? 0, constructorTimers: this.ctx.storage.kv.get('test:constructorTimers') ?? 0, alarm: await this.ctx.storage.getAlarm() })
        case '/__notify':
          this.inTenant(() => publish({ type: 'refresh', scope: url.searchParams.get('scope') ?? 'test' }))
          return Response.json({ ok: true })

        case '/__workspace':
          this.ctx.storage.kv.put('workspaceId', url.searchParams.get('id') ?? url.hostname.split('.')[0])
          return Response.json({ ok: true })
        case '/__blobs':
          await this.inTenant(() => checkBlobStore(currentTenant().blobs, !!this.env.ATTACHMENTS))
          return Response.json({ ok: true })
        case '/__remove-batch':
          await this.inTenant(() => currentTenant().blobs.remove(Array.from({ length: 1001 }, (_, i) => `batch/${i}`)))
          return Response.json({ ok: true })
        case '/__blob':
          return this.inTenant(async () => {
            const store = currentTenant().blobs
            const key = 'same/key.txt'
            if (request.method === 'PUT') await store.put(key, new TextEncoder().encode(await request.text()))
            if (request.method === 'DELETE') await store.remove([key])
            const blob = await store.get(key)
            return new Response(blob?.body ?? null, { status: blob ? 200 : 404 })
          })
        case '/__probe': {
          const bus = new EventEmitter()
          const pump = setInterval(() => bus.emit('tick'), 1)
          try {
            const name = url.hostname.split('.')[0]
            return Response.json(await this.inTenant(() => probe({ name, appUrl: url.origin, bus, rounds: Number(url.searchParams.get('rounds')) })))
          } finally {
            clearInterval(pump)
          }
        }
        case '/__open':
          return Response.json({ opened: this.inTenant(() => openSealed(url.searchParams.get('sealed') || '')) })
        case '/__interleavings':
          return Response.json({ interleavings: interleavings() })
        case '/__alarm': {
          const threadId = this.inTenant(scheduleDueReply)
          await this.alarm()
          return Response.json(this.inTenant(() => get('SELECT state, error FROM threads WHERE id = ?', threadId)))
        }
        case '/__sent':
          return Response.json(this.sent)
        case '/__reset-outbox':
          return Response.json({ rows: this.inTenant(() => all('SELECT email, tries FROM reset_outbox')), alarm: await this.ctx.storage.getAlarm() })
        case '/__logs':
          return Response.json(logged)
        case '/__control':
          if (request.method === 'POST') Object.assign(this.script, await request.json())
          return Response.json(this.controlCalls)
        case '/__sql': {
          const { sql, params = [] } = (await request.json()) as { sql: string; params?: (string | number | null)[] }
          return Response.json(this.inTenant(() => all(sql, ...params)))
        }
        case '/__tick':
          await this.alarm()
          return Response.json({ alarm: await this.ctx.storage.getAlarm() })
        case '/__next-alarm':
          return Response.json({ alarm: await this.ctx.storage.getAlarm() })
        case '/__decrypt-outside':
          return Response.json({ opened: decrypt(this.inTenant(() => encrypt('hunter2'))) })
        case '/__decrypt-invalid':
          return Response.json({ opened: this.inTenant(() => decrypt('v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA')) })
        case '/__outside':
          return Response.json({ setting: getSetting('probe', '') })
      }
    } catch (err) {
      return failure(err)
    }
    return super.fetch(request)
  }
}

export class ControlPlane extends WorkerEntrypoint<Env> {
  private store(workspaceId: string) {
    return this.env.ANSA.get(this.env.ANSA.idFromName(workspaceId)) as unknown as RpcStub
  }

  private note(workspaceId: string, method: string, ...args: unknown[]) {
    return this.store(workspaceId).controlCall(method, args) as Promise<ControlScript>
  }

  async sendSystemEmail(workspaceId: string, message: SystemEmail) {
    await this.store(workspaceId).keepMail({ workspaceId, ...message })
  }

  async createInboundAddress(workspaceId: string, mailboxId: number) {
    await this.note(workspaceId, 'createInboundAddress', mailboxId)
    return { address: `${workspaceId}-m${mailboxId}@in.hosted.test` }
  }

  async deleteInboundAddress(workspaceId: string, mailboxId: number) {
    await this.note(workspaceId, 'deleteInboundAddress', mailboxId)
  }

  async addSendingDomain(workspaceId: string, mailboxId: number, domain: string): Promise<DomainResult> {
    await this.note(workspaceId, 'addSendingDomain', mailboxId, domain)
    return { status: 'pending', records: DNS_RECORDS }
  }

  async checkSendingDomain(workspaceId: string, mailboxId: number): Promise<DomainResult> {
    const script = await this.note(workspaceId, 'checkSendingDomain', mailboxId)
    return { status: script.domain, records: DNS_RECORDS }
  }

  async sendFallback(workspaceId: string, message: { mailboxId: number; raw: ArrayBuffer; from: string; to: string[] }) {
    const script = await this.note(workspaceId, 'sendFallback', { mailboxId: message.mailboxId, from: message.from, to: message.to, raw: new TextDecoder().decode(message.raw) })
    if (script.fallback === 'rate-limited') throw Object.assign(new Error('The fallback cap for this hour is used up.'), { name: 'RateLimited', retryAt: script.retryAt })
    return { messageId: `fallback-${crypto.randomUUID()}` }
  }

  async billingLinks(workspaceId: string): Promise<BillingLinks> {
    await this.note(workspaceId, 'billingLinks')
    return { checkout: { starter_monthly: 'https://pay.hosted.test/starter', team_annual: 'https://pay.hosted.test/team-annual' }, portal: 'https://pay.hosted.test/portal' }
  }

  async reportHealth(workspaceId: string, health: Health) {
    await this.note(workspaceId, 'reportHealth', health)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const name = url.hostname.split('.')[0]
    const method = /^\/__rpc\/(\w+)$/.exec(url.pathname)?.[1]
    if (method && RPC_METHODS.includes(method)) {
      const store = env.ANSA.get(env.ANSA.idFromName(name)) as unknown as RpcStub
      try {
        const input = (await request.json()) as { raw?: unknown } | null
        if (input && typeof input.raw === 'string') input.raw = new TextEncoder().encode(input.raw).buffer
        return Response.json({ result: (await store[method](input)) ?? null })
      } catch (err) {
        return Response.json({ error: { name: (err as Error).name, message: (err as Error).message } })
      }
    }
    try {
      return await env.ANSA.get(env.ANSA.idFromName(name)).fetch(request)
    } catch (err) {
      return failure(err)
    }
  },
}
