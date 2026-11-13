import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { api } from './api.ts'
import { userFromBearer, pruneSessions } from './auth.ts'
import { prunePresence } from './events.ts'
import { handleMcp } from './mcp.ts'
import { migrate, run } from './db.ts'
import { dispatchScheduled, wakeSnoozed } from './services/conversations.ts'

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

/** The HTTP app shared by every platform: /healthz, /mcp and /api. Static files are added by the platform. */
export function createApp() {
  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  })

  app.get('/healthz', (c) => c.json({ ok: true }))

  // Model Context Protocol endpoint. Authenticate with an API token from Settings → API & MCP.
  app.all('/mcp', bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
    const user = userFromBearer(c.req.header('authorization'))
    if (!user) {
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized. Send "Authorization: Bearer <Ansa API token>".' }, id: null }, 401, {
        'WWW-Authenticate': 'Bearer realm="ansa"',
      })
    }
    if (c.req.method !== 'POST') {
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless: use POST.' }, id: null }, 405, { Allow: 'POST' })
    }
    return handleMcp(c.req.raw, user.user, user.access)
  })

  app.route('/api', api)
  return app
}

/** Bring the database up to date and repair state left by an interrupted process. Call once at start. */
export function prepareData() {
  migrate()
  // Replies that were mid-send when the process stopped were never delivered. Flag them so an agent can re-send.
  const interrupted = run(`UPDATE threads SET state = 'failed', error = 'Ansa restarted before this reply was sent. Send it again.' WHERE state = 'sending'`).changes
  if (interrupted) console.log(`[mail] ${interrupted} unsent repl${interrupted === 1 ? 'y was' : 'ies were'} flagged for re-sending`)
}

/** Periodic jobs that only matter while the process is awake. */
export function startTimers() {
  const every = (ms: number, job: () => void) => {
    const timer = setInterval(() => {
      try {
        job()
      } catch (err) {
        console.error('[timer]', err)
      }
    }, ms) as unknown as { unref?: () => void }
    timer.unref?.()
  }
  every(15_000, prunePresence)
  every(30_000, wakeSnoozed)
  every(10_000, () => void dispatchScheduled().catch((err) => console.error('[send later]', err)))
  every(3_600_000, pruneSessions)
}
