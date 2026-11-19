import { currentTenant } from './tenant.ts'

export interface StoredBlob {
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>
  size: number
}

export interface BlobStore {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<StoredBlob | null>
  remove(keys: string[]): Promise<void>
}

export const blobs: BlobStore = {
  put: (key, data) => currentTenant().blobs.put(key, data),
  get: (key) => currentTenant().blobs.get(key),
  remove: (keys) => currentTenant().blobs.remove(keys),
}
