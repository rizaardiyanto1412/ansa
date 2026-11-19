import { z } from 'zod'
import { get } from '../server/db.ts'
import { publish, type AppEvent, type Viewer } from '../server/events.ts'
import type { User } from '../server/auth.ts'

const presence = z.object({ conversationId: z.number().int().positive(), state: z.enum(['viewing', 'replying']) })
const messageSchema = z.object({ type: z.literal('presence'), presence: presence.nullable() })
const attachmentSchema = z.object({
  user: z.object({ userId: z.number().int().positive(), name: z.string(), color: z.string() }),
  credential: z.object({ kind: z.enum(['session', 'token']), hash: z.string() }),
  presence: presence.nullable(),
})
type Attachment = z.infer<typeof attachmentSchema>

export class HibernatingEvents {
  constructor(private ctx: DurableObjectState) {
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private attachment(socket: WebSocket): Attachment | null {
    const result = attachmentSchema.safeParse(socket.deserializeAttachment())
    return result.success ? result.data : null
  }

  private authorized(data: Attachment): boolean {
    const { credential, user } = data
    return !!(credential.kind === 'session'
      ? get('SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND u.disabled = 0', credential.hash, user.userId, Date.now())
      : get('SELECT 1 FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.user_id = ? AND u.disabled = 0', credential.hash, user.userId))
  }

  connect(user: User, credential: Attachment['credential']): Response {
    const pair = new WebSocketPair()
    const socket = pair[1]
    socket.serializeAttachment({ user: { userId: user.id, name: user.name, color: user.color }, credential, presence: null } satisfies Attachment)
    this.ctx.acceptWebSocket(socket)
    socket.send(JSON.stringify({ type: 'hello' }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  viewers(): Record<number, Viewer[]> {
    const all: Record<number, Viewer[]> = {}
    for (const socket of this.ctx.getWebSockets()) {
      const data = this.attachment(socket)
      if (!data?.presence || socket.readyState !== 1 || !this.authorized(data)) continue
      const { conversationId, state } = data.presence
      const viewers = all[conversationId] ??= []
      const existing = viewers.find((viewer) => viewer.userId === data.user.userId)
      if (existing) {
        if (state === 'replying') existing.state = state
      } else viewers.push({ ...data.user, state })
    }
    return all
  }

  broadcast(event: AppEvent) {
    const message = JSON.stringify(event)
    for (const socket of this.ctx.getWebSockets()) {
      const data = this.attachment(socket)
      if (socket.readyState !== 1) continue
      try {
        if (!data || !this.authorized(data)) {
          socket.close(1008, 'Sign in again.')
          continue
        }
        socket.send(message)
      } catch {
        this.close(socket, 1011)
      }
    }
  }

  message(socket: WebSocket, raw: string | ArrayBuffer) {
    const data = this.attachment(socket)
    if (!data || !this.authorized(data)) return this.close(socket, 1008)
    if (typeof raw !== 'string' || raw.length > 1024) return this.close(socket, 1008)
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      return this.close(socket, 1008)
    }
    const parsed = messageSchema.safeParse(input)
    if (!parsed.success) return this.close(socket, 1008)
    const next = parsed.data.presence
    if (next && !get('SELECT 1 FROM conversations WHERE id = ?', next.conversationId)) return
    socket.serializeAttachment({ ...data, presence: next } satisfies Attachment)
    for (const conversationId of new Set([data.presence?.conversationId, next?.conversationId])) {
      if (conversationId) publish({ type: 'presence', conversationId, viewers: this.viewers()[conversationId] ?? [] })
    }
  }

  close(socket: WebSocket, code = 1000) {
    const data = this.attachment(socket)
    if (data) socket.serializeAttachment({ ...data, presence: null } satisfies Attachment)
    if (socket.readyState < 2) socket.close(code, code === 1008 ? 'Sign in again or check the message.' : 'Connection closed.')
    if (data?.presence) publish({ type: 'presence', conversationId: data.presence.conversationId, viewers: this.viewers()[data.presence.conversationId] ?? [] })
  }
}
