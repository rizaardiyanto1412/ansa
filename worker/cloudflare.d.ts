// Minimal types for the Workers runtime pieces this project uses.
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
  export class WorkerEntrypoint<Env = unknown> {
    protected env: Env
  }
}

interface SqlCursor {
  toArray(): Record<string, unknown>[]
  one(): Record<string, unknown>
}
interface DurableObjectState {
  /** Stop this object now. The next request starts a fresh one with the latest code. Always throws. */
  abort(reason?: string): never
  waitUntil(promise: Promise<unknown>): void
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): WebSocket[]
  getWebSocketAutoResponseTimestamp(socket: WebSocket): Date | null
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor }
    kv: { get<T = unknown>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean }
    transactionSync<T>(fn: () => T): T
    deleteAlarm(): Promise<void>
    getAlarm(): Promise<number | null>
    setAlarm(time: number): Promise<void>
    deleteAll(): Promise<void>
    getBookmarkForTime(timestamp: number | Date): Promise<string>
    onNextSessionRestoreBookmark(bookmark: string): Promise<string>
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
interface R2UploadedPart {
  partNumber: number
  etag: string
}
interface R2Bucket {
  put(key: string, value: Uint8Array): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>
  delete(keys: string | string[]): Promise<void>
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string }>
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<{
    uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPart>
    complete(parts: R2UploadedPart[]): Promise<unknown>
    abort(): Promise<void>
  }>
}
