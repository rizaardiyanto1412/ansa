import { EventEmitter } from 'node:events'
import { decrypt, encrypt } from '../../server/crypto.ts'
import { get, getSetting, run } from '../../server/db.ts'
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

export class ProbeStore extends AnsaStore {
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      switch (url.pathname) {
        case '/__schedule': {
          await this.inTenant(() => this.scheduleAlarm())
          return Response.json({ alarm: await this.ctx.storage.getAlarm() })
        }
        case '/__lifecycle':
          return Response.json({ constructors: this.ctx.storage.kv.get('test:constructors'), messages: this.ctx.storage.kv.get('test:messages') ?? 0, constructorTimers: this.ctx.storage.kv.get('test:constructorTimers') ?? 0, alarm: await this.ctx.storage.getAlarm() })
        case '/__notify':
          this.inTenant(() => publish({ type: 'refresh', scope: url.searchParams.get('scope') ?? 'test' }))
          return Response.json({ ok: true })

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).hostname.split('.')[0]
    try {
      return await env.ANSA.get(env.ANSA.idFromName(name)).fetch(request)
    } catch (err) {
      return failure(err)
    }
  },
}
