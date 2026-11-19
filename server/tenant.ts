/**
 * Everything one install keeps in memory. A server has one tenant; on Cloudflare each Durable Object
 * has its own, and several objects can share an isolate, so nothing here may live in a module global.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { BlobStore } from './blobs.ts'
import type { Config } from './config.ts'
import type { Driver } from './db.ts'
import type { Listener, PresenceEntry } from './events.ts'
import type { MailboxWorker } from './mail/imap.ts'

export interface Tenant {
  config: Config
  db: Driver
  blobs: BlobStore
  txDepth: number
  keyCache: { secret: string; key: Buffer } | null
  listeners: Set<Listener>
  presence: Map<number, Map<number, PresenceEntry>>
  autoReplyLog: Map<string, number>
  signInAttempts: Map<string, { count: number; resetAt: number }>
  importing: { stepping: boolean; looping: boolean }
  imapWorkers: Map<number, MailboxWorker>
}

export function createTenant(init: Pick<Tenant, 'config' | 'db' | 'blobs'>): Tenant {
  return {
    ...init,
    txDepth: 0,
    keyCache: null,
    listeners: new Set(),
    presence: new Map(),
    autoReplyLog: new Map(),
    signInAttempts: new Map(),
    importing: { stepping: false, looping: false },
    imapWorkers: new Map(),
  }
}

const active = new AsyncLocalStorage<Tenant>()
let fallback: Tenant | null = null

export function runInTenant<T>(tenant: Tenant, fn: () => T): T {
  return active.run(tenant, fn)
}

export function currentTenant(): Tenant {
  const tenant = active.getStore() ?? fallback
  if (!tenant) throw new Error('No workspace is active here. Every entry point must run inside runInTenant().')
  return tenant
}

/** For a callback that a library or timer may call outside the async context it was created in. */
export function bindTenant<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const tenant = currentTenant()
  return (...args) => active.run(tenant, () => fn(...args))
}

/** A server process holds exactly one install. Only platform-node.ts may call this. */
export function installFallbackTenant(tenant: Tenant) {
  fallback = tenant
}
