import { WorkerEntrypoint } from 'cloudflare:workers'
import { EventEmitter } from 'node:events'
import { get, getSetting, run } from '../../server/db.ts'
import type { SystemEmail } from '../../server/hosted.ts'
import { addReply, createConversation } from '../../server/services/conversations.ts'
import { interleavings, openSealed, probe } from '../../server/test/tenant-probe.ts'
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

const RPC_METHODS = ['provision', 'setPlan', 'setSmtp', 'health']
type RpcStub = Record<string, (input: unknown) => Promise<unknown>>

export class ProbeStore extends AnsaStore {
  private outbox: unknown[] = []

  async keepMail(mail: unknown) {
    this.outbox.push(mail)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      switch (url.pathname) {
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
        case '/__outbox':
          return Response.json(this.outbox)
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
  async sendSystemEmail(workspaceId: string, message: SystemEmail) {
    const store = this.env.ANSA.get(this.env.ANSA.idFromName(workspaceId)) as unknown as RpcStub
    await store.keepMail({ workspaceId, ...message })
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
        return Response.json({ result: (await store[method](await request.json())) ?? null })
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
