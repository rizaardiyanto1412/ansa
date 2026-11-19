// Minimal types for the Workers runtime pieces this project uses.
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
}

interface SqlCursor {
  toArray(): Record<string, unknown>[]
  one(): Record<string, unknown>
}
interface DurableObjectState {
  /** Stop this object now. The next request starts a fresh one with the latest code. Always throws. */
  abort(reason?: string): never
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): WebSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor }
    kv: { get<T = unknown>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean }
    transactionSync<T>(fn: () => T): T
    deleteAlarm(): Promise<void>
    getAlarm(): Promise<number | null>
    setAlarm(time: number): Promise<void>
  }
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

interface WebSocket {
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}
declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}
declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string)
}
interface ResponseInit {
  webSocket?: WebSocket
}
