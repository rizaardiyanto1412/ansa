import crypto from 'node:crypto'
import { currentTenant } from './tenant.ts'

function key(): Buffer {
  const tenant = currentTenant()
  const { secret } = tenant.config
  if (!secret) throw new Error('The encryption secret is not set.')
  if (tenant.keyCache?.secret !== secret) tenant.keyCache = { secret, key: crypto.createHash('sha256').update(`ansa:${secret}`).digest() }
  return tenant.keyCache.key
}

/** Encrypt a secret (mail passwords) for storage. Format: v1:iv:tag:data (base64). */
export function encrypt(plain: string): string {
  if (!plain) return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
}

export function decrypt(stored: string | null | undefined): string {
  if (!stored) return ''
  const [v, iv, tag, data] = stored.split(':')
  if (v !== 'v1') return ''
  const secretKey = key()
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length)
  return crypto.timingSafeEqual(expected, actual)
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
