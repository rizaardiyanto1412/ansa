import { currentTenant } from './tenant.ts'

/** Where attachment bytes live. Files on a server, database rows on Cloudflare. */
export interface BlobStore {
  put(key: string, data: Uint8Array): void
  get(key: string): Uint8Array | null
  remove(key: string): void
}

export const blobs: BlobStore = {
  put: (key, data) => currentTenant().blobs.put(key, data),
  get: (key) => currentTenant().blobs.get(key),
  remove: (key) => currentTenant().blobs.remove(key),
}
