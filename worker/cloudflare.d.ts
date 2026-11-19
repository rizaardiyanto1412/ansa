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
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor }
    kv: { get<T = unknown>(key: string): T | undefined; put(key: string, value: unknown): void }
    transactionSync<T>(fn: () => T): T
    getAlarm(): Promise<number | null>
    setAlarm(time: number): Promise<void>
  }
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}
