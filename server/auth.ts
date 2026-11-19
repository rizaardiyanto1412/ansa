import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { get, run, now } from './db.ts'
import { config } from './config.ts'
import { randomToken, sha256 } from './crypto.ts'

export interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'agent'
  color: string
  signature: string
  notifyAssigned: boolean
  notifyReplies: boolean
  notifyMentions: boolean
  disabled: boolean
  pending: boolean
  createdAt: number
}

export type TokenAccess = 'full' | 'internal'

export type Env = { Variables: { user: User; via: 'web' | 'api'; access: TokenAccess } }

export function serializeUser(row: any): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    color: row.color,
    signature: row.signature,
    notifyAssigned: !!row.notify_assigned,
    notifyReplies: !!row.notify_replies,
    notifyMentions: row.notify_mentions === undefined ? true : !!row.notify_mentions,
    disabled: !!row.disabled,
    pending: row.password_hash === '',
    createdAt: row.created_at,
  }
}

const PLAIN_COOKIE = 'ansa_session'
// The __Host- prefix makes browsers refuse the cookie unless this exact host set it, so a sibling subdomain cannot plant one.
const HOST_COOKIE = '__Host-ansa_session'
const SESSION_DAYS = 30

const isHttps = (c: Context) => c.req.url.startsWith('https://') || config.appUrl.startsWith('https://')

function writeSessionCookie(c: Context, token: string, maxAge: number) {
  const secure = isHttps(c)
  setCookie(c, secure ? HOST_COOKIE : PLAIN_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge })
}

// Self-hosted HTTPS installs used the plain name before, so their sessions carry over. A hosted workspace never did, and there a sibling subdomain could plant one.
function readSessionCookie(c: Context): { token: string; old: boolean } | null {
  const secure = isHttps(c)
  const token = getCookie(c, secure ? HOST_COOKIE : PLAIN_COOKIE)
  if (token) return { token, old: false }
  const old = secure && !config.hosted ? getCookie(c, PLAIN_COOKIE) : undefined
  return old ? { token: old, old: true } : null
}

export function startSession(c: Context, userId: number) {
  const token = randomToken()
  const ts = now()
  run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, ts, ts + SESSION_DAYS * 86_400_000)
  writeSessionCookie(c, token, SESSION_DAYS * 86_400)
}

export function endSession(c: Context) {
  const cookie = readSessionCookie(c)
  if (cookie) run('DELETE FROM sessions WHERE id = ?', sha256(cookie.token))
  deleteCookie(c, PLAIN_COOKIE, { path: '/' })
  if (isHttps(c)) deleteCookie(c, HOST_COOKIE, { path: '/', secure: true })
}

export function userFromSession(c: Context): User | null {
  const cookie = readSessionCookie(c)
  if (!cookie) return null
  const row = get<any>(
    'SELECT u.*, s.expires_at AS session_expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0',
    sha256(cookie.token),
    now(),
  )
  if (!row) return null
  if (cookie.old) {
    writeSessionCookie(c, cookie.token, Math.floor((row.session_expires_at - now()) / 1000))
    deleteCookie(c, PLAIN_COOKIE, { path: '/' })
  }
  return serializeUser(row)
}

export function userFromBearer(header: string | undefined | null): { user: User; access: TokenAccess } | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header || '')
  if (!match) return null
  const row = get<any>(
    'SELECT u.*, t.id AS token_id, t.access AS token_access FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.disabled = 0',
    sha256(match[1]),
  )
  if (!row) return null
  run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id)
  return { user: serializeUser(row), access: row.token_access === 'internal' ? 'internal' : 'full' }
}

/** Accepts a browser session or an API token. Browser writes must carry X-Requested-With (CSRF guard). */
export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const bearer = userFromBearer(c.req.header('authorization'))
  if (bearer) {
    c.set('user', bearer.user)
    c.set('access', bearer.access)
    c.set('via', 'api')
    return next()
  }
  const user = userFromSession(c)
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-requested-with') !== 'ansa') {
    return c.json({ error: 'Request blocked.' }, 403)
  }
  c.set('user', user)
  c.set('via', 'web')
  c.set('access', 'full')
  return next()
}

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('access') === 'internal') return c.json({ error: "This token is internal only. It can't change settings." }, 403)
  if (c.get('user').role !== 'admin') return c.json({ error: 'Only admins can do that.' }, 403)
  return next()
}

/**
 * Workers have no socket: Cloudflare sets CF-Connecting-IP itself and drops a client's copy. On a server
 * that header is the client's to forge, so the socket address counts, or the hop a trusted proxy appended.
 */
export function clientAddress(c: Context): string {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
  if (!socket) return c.req.header('cf-connecting-ip') || 'unknown'
  const hop = config.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : ''
  return hop || socket.remoteAddress || 'unknown'
}

/** Returns false when this key has been tried too often in the window. */
export function allowAttempt(key: string, max = 10, windowMs = 15 * 60_000): boolean {
  const ts = now()
  const id = sha256(key)
  // Expired counters go here, not in a timer: a sleeping Durable Object may never run one.
  run('DELETE FROM attempts WHERE reset_at <= ?', ts)
  run('INSERT INTO attempts (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1', id, ts + windowMs)
  return get<{ count: number }>('SELECT count FROM attempts WHERE key = ?', id)!.count <= max
}
export const clearAttempts = (key: string) => run('DELETE FROM attempts WHERE key = ?', sha256(key))

/** Drop expired sessions and one-time links. The platform calls this about once an hour. */
export function pruneSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', now())
  run('DELETE FROM one_time_links WHERE expires_at < ?', now())
}

export const USER_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6']
