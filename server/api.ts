import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { all, get, run, tx, now, parseJson } from './db.ts'
import { config } from './config.ts'
import { decrypt, encrypt, hashPassword, randomToken, sha256, verifyPassword } from './crypto.ts'
import {
  allowAttempt,
  clearAttempts,
  endSession,
  requireAdmin,
  requireAuth,
  serializeUser,
  startSession,
  userFromSession,
  USER_COLORS,
  type Env,
} from './auth.ts'
import { allViewers, leavePresence, subscribe, touchPresence, viewersOf } from './events.ts'
import { explainMailError, testSmtp, type MailboxRow } from './mail/outbound.ts'
import { restartMailbox, syncMailboxNow, testImap } from './mail/imap.ts'
import { cleanHtml } from './mail/html.ts'
import {
  addNote,
  addReply,
  teammateReplyAfter,
  createConversation,
  deleteConversation,
  folderCounts,
  getConversation,
  getQuotedHtml,
  listConversations,
  mergeConversations,
  retryDelivery,
  sendScheduledNow,
  cancelScheduled,
  saveDraft,
  updateConversation,
  type Actor,
  type ConversationPatch,
  type Folder,
  type Status,
  mergeCustomers,
} from './services/conversations.ts'
import { AppError, createCustomer, getCustomer, isEmail, listCustomers, normEmail, updateCustomer } from './services/customers.ts'
import { attachmentFile, removeFiles, storeAttachment } from './services/attachments.ts'
import { buildReport } from './services/reports.ts'
import { runWorkflows } from './services/workflows.ts'
import { createApp as createIntegration, deleteApp, getApp, listApps, listDeliveries, sidebarsFor, testApp, updateApp } from './services/apps.ts'
import { APP_EVENTS } from './hooks.ts'
import { brandName, getWorkspace, publicWorkspace, saveWorkspace } from './services/workspace.ts'
import { blobs } from './blobs.ts'
import { cancelImport, connectHelpScout, importStatus, resumeImport, startImport } from './services/import-helpscout.ts'
import { publish } from './events.ts'

export const api = new Hono<Env>()

const str = (value: unknown, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const int = (value: unknown) => {
  const n = Number(value)
  return Number.isInteger(n) ? n : NaN
}
const idParam = (value: string | undefined) => {
  const n = int(value)
  if (!(n > 0)) throw new AppError('Not found.', 404)
  return n
}
const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, any>> => {
  try {
    const data = await c.req.json()
    return data && typeof data === 'object' ? (data as Record<string, any>) : {}
  } catch {
    return {}
  }
}
/** Limit the length before and after cleaning: cutting cleaned HTML could split a tag. */
const cleanSignature = (html: string) => {
  const clean = cleanHtml(html.slice(0, 20_000))
  if (clean.length > 10_000) throw new AppError('That signature is too long. Remove pasted images or shorten it.')
  return clean
}
const checkPassword = (password: unknown) => {
  if (typeof password !== 'string' || password.length < 8) throw new AppError('Use a password with at least 8 characters.')
  return password
}

// JSON bodies are small. Attachments have their own, larger limit.
api.use('*', async (c, next) => (c.req.path.endsWith('/attachments') ? next() : bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (ctx) => ctx.json({ error: 'That request is too large.' }, 413) })(c, next)))

api.onError((err, c) => {
  if (err instanceof AppError) return c.json({ error: err.message }, err.status as 400)
  console.error('[api]', err)
  return c.json({ error: 'Something went wrong on the server.' }, 500)
})

// ---------------------------------------------------------------------------------------------
// Public: bootstrap, setup, sign in
// ---------------------------------------------------------------------------------------------

const hasUsers = () => !!get('SELECT 1 FROM users LIMIT 1')

api.get('/bootstrap', (c) => c.json({ setupRequired: !hasUsers(), user: userFromSession(c), appUrl: config.appUrl, version: '1.0.0', workspace: publicWorkspace() }))

// The workspace logo. Public, because the sign-in page shows it.
api.get('/brand/logo', (c) => {
  const logo = getWorkspace().logo
  const data = logo ? blobs.get(logo.key) : null
  if (!logo || !data) throw new AppError('No logo.', 404)
  return new Response(data as Uint8Array<ArrayBuffer>, {
    headers: { 'Content-Type': logo.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' },
  })
})

// The web app manifest: what a phone needs to add the app to its home screen. Public, like the logo.
// It is built here, not a static file, so it carries the workspace's own name and logo.
api.get('/brand/manifest', (c) => {
  const w = publicWorkspace()
  const logo = getWorkspace().logo
  const name = brandName()
  const icons = [
    // An uploaded logo comes first. Phones scale it to the size they need.
    ...(w.logoUrl && logo ? [{ src: w.logoUrl, sizes: '512x512', type: logo.mime, purpose: 'any' }] : []),
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ...(w.logoUrl ? [] : [{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]),
  ]
  const manifest = { name, short_name: name, description: 'Shared inbox', id: '/', start_url: '/', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#221f5c', icons }
  return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } })
})

api.post('/setup', async (c) => {
  if (hasUsers()) throw new AppError('Setup is already complete.', 409)
  const data = await body(c)
  const name = str(data.name, 100)
  const email = str(data.email, 200)
  if (!name) throw new AppError('Enter your name.')
  if (!isEmail(email)) throw new AppError('Enter a valid email address.')
  const password = checkPassword(data.password)
  const id = tx(() => {
    if (hasUsers()) throw new AppError('Setup is already complete.', 409)
    return run('INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?, ?, ?, \'admin\', ?, ?)', name, normEmail(email), hashPassword(password), USER_COLORS[0], now()).id
  })
  startSession(c, id)
  return c.json({ user: serializeUser(get('SELECT * FROM users WHERE id = ?', id)) })
})

api.post('/login', async (c) => {
  const data = await body(c)
  const email = str(data.email, 200).toLowerCase()
  const key = `${c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local'}:${email}`
  if (!allowAttempt(key)) throw new AppError('Too many attempts. Wait 15 minutes and try again.', 429)
  const row = get<any>('SELECT * FROM users WHERE email = ? AND disabled = 0', email)
  if (!row || typeof data.password !== 'string' || !verifyPassword(data.password, row.password_hash)) {
    throw new AppError('That email and password do not match.', 401)
  }
  clearAttempts(key)
  startSession(c, row.id)
  return c.json({ user: serializeUser(row) })
})

api.post('/logout', (c) => {
  endSession(c)
  return c.json({ ok: true })
})

// Everything below needs a signed-in user or an API token.
api.use('*', requireAuth)
const actorOf = (c: { get: (key: 'user' | 'via' | 'access') => any }): Actor => ({ userId: c.get('user').id, via: c.get('via'), access: c.get('access') })

// ---------------------------------------------------------------------------------------------
// Me and team
// ---------------------------------------------------------------------------------------------

api.get('/me', (c) => c.json({ user: c.get('user') }))

api.patch('/me', async (c) => {
  const user = c.get('user')
  const data = await body(c)
  if (data.name !== undefined) {
    if (!str(data.name, 100)) throw new AppError('Enter your name.')
    run('UPDATE users SET name = ? WHERE id = ?', str(data.name, 100), user.id)
  }
  if (data.email !== undefined) {
    const email = str(data.email, 200)
    if (!isEmail(email)) throw new AppError('Enter a valid email address.')
    if (get('SELECT 1 FROM users WHERE email = ? AND id != ?', email, user.id)) throw new AppError('Another teammate already uses that email.', 409)
    run('UPDATE users SET email = ? WHERE id = ?', normEmail(email), user.id)
  }
  if (typeof data.signature === 'string') run('UPDATE users SET signature = ? WHERE id = ?', cleanSignature(data.signature), user.id)
  if (typeof data.notifyAssigned === 'boolean') run('UPDATE users SET notify_assigned = ? WHERE id = ?', data.notifyAssigned, user.id)
  if (typeof data.notifyReplies === 'boolean') run('UPDATE users SET notify_replies = ? WHERE id = ?', data.notifyReplies, user.id)
  if (typeof data.notifyMentions === 'boolean') run('UPDATE users SET notify_mentions = ? WHERE id = ?', data.notifyMentions, user.id)
  if (data.newPassword !== undefined) {
    const row = get<any>('SELECT password_hash FROM users WHERE id = ?', user.id)
    if (typeof data.currentPassword !== 'string' || !verifyPassword(data.currentPassword, row.password_hash)) throw new AppError('Your current password is not correct.')
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(checkPassword(data.newPassword)), user.id)
    signOutEverywhere(user.id, c)
  }
  return c.json({ user: serializeUser(get('SELECT * FROM users WHERE id = ?', user.id)) })
})

/** After a password change, every other browser is signed out. The current one gets a fresh session. */
function signOutEverywhere(userId: number, c: Parameters<typeof startSession>[0]) {
  run('DELETE FROM sessions WHERE user_id = ?', userId)
  if (c.get('via') === 'web') startSession(c, userId)
}

api.get('/users', (c) => c.json({ users: all('SELECT * FROM users ORDER BY disabled, name').map(serializeUser) }))

api.post('/users', requireAdmin, async (c) => {
  const data = await body(c)
  const name = str(data.name, 100)
  const email = str(data.email, 200)
  if (!name) throw new AppError('Enter a name.')
  if (!isEmail(email)) throw new AppError('Enter a valid email address.')
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw new AppError('A teammate with that email already exists.', 409)
  const password = checkPassword(data.password)
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n
  const { id } = run(
    'INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    name,
    normEmail(email),
    hashPassword(password),
    data.role === 'admin' ? 'admin' : 'agent',
    USER_COLORS[count % USER_COLORS.length],
    now(),
  )
  return c.json({ user: serializeUser(get('SELECT * FROM users WHERE id = ?', id)) }, 201)
})

api.patch('/users/:id', requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'))
  const target = get<any>('SELECT * FROM users WHERE id = ?', id)
  if (!target) throw new AppError('Teammate not found.', 404)
  const data = await body(c)
  const lastAdmin = () => target.role === 'admin' && !target.disabled && get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`)!.n <= 1
  if ((data.role === 'agent' || data.disabled === true) && lastAdmin()) throw new AppError('Keep at least one active admin.')
  if (data.name !== undefined && str(data.name, 100)) run('UPDATE users SET name = ? WHERE id = ?', str(data.name, 100), id)
  if (data.email !== undefined) {
    if (!isEmail(data.email)) throw new AppError('Enter a valid email address.')
    if (get('SELECT 1 FROM users WHERE email = ? AND id != ?', data.email, id)) throw new AppError('Another teammate already uses that email.', 409)
    run('UPDATE users SET email = ? WHERE id = ?', normEmail(data.email), id)
  }
  if (data.role === 'admin' || data.role === 'agent') run('UPDATE users SET role = ? WHERE id = ?', data.role, id)
  if (data.password) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(checkPassword(data.password)), id)
    // An admin reset is used when an account may be compromised: cut every session and token.
    run('DELETE FROM sessions WHERE user_id = ?', id)
    run('DELETE FROM api_tokens WHERE user_id = ?', id)
    if (id === c.get('user').id) startSession(c, id)
  }
  if (typeof data.disabled === 'boolean') {
    run('UPDATE users SET disabled = ? WHERE id = ?', data.disabled, id)
    if (data.disabled) {
      run('DELETE FROM sessions WHERE user_id = ?', id)
      run('DELETE FROM api_tokens WHERE user_id = ?', id)
      run('UPDATE conversations SET assignee_id = NULL WHERE assignee_id = ?', id)
    }
  }
  return c.json({ user: serializeUser(get('SELECT * FROM users WHERE id = ?', id)) })
})

// ---------------------------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------------------------

function serializeMailbox(m: MailboxRow, admin: boolean) {
  const base = {
    id: m.id,
    name: m.name,
    email: m.email,
    fromName: m.from_name,
    color: m.color,
    imapEnabled: !!m.imap_enabled,
    smtpConfigured: !!m.smtp_host,
    syncStatus: m.sync_status,
    syncError: m.sync_error,
    lastSyncAt: m.last_sync_at,
  }
  if (!admin) return base
  return {
    ...base,
    signature: m.signature,
    smtpHost: m.smtp_host,
    smtpPort: m.smtp_port,
    smtpSecurity: m.smtp_security,
    smtpUser: m.smtp_user,
    smtpPasswordSet: !!m.smtp_pass_enc,
    imapHost: m.imap_host,
    imapPort: m.imap_port,
    imapSecurity: m.imap_security,
    imapUser: m.imap_user,
    imapPasswordSet: !!m.imap_pass_enc,
    imapFolder: m.imap_folder,
    importExisting: !!m.import_existing,
    autoReplyEnabled: !!m.auto_reply_enabled,
    autoReplyBody: m.auto_reply_body,
  }
}

const SECURITY = ['ssl', 'starttls', 'none']

function applyMailboxFields(id: number, data: Record<string, any>) {
  const set = (column: string, value: string | number | boolean) => run(`UPDATE mailboxes SET ${column} = ? WHERE id = ?`, value, id)
  if (data.name !== undefined) {
    if (!str(data.name, 100)) throw new AppError('Give the mailbox a name.')
    set('name', str(data.name, 100))
  }
  if (data.email !== undefined) {
    if (!isEmail(data.email)) throw new AppError('Enter the mailbox email address.')
    set('email', normEmail(data.email))
  }
  if (data.fromName !== undefined) set('from_name', str(data.fromName, 100))
  if (typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color)) set('color', data.color)
  if (typeof data.signature === 'string') set('signature', cleanSignature(data.signature))
  if (data.smtpHost !== undefined) set('smtp_host', str(data.smtpHost, 200))
  if (data.smtpPort !== undefined && int(data.smtpPort) > 0) set('smtp_port', int(data.smtpPort))
  if (SECURITY.includes(data.smtpSecurity)) set('smtp_security', data.smtpSecurity)
  if (data.smtpUser !== undefined) set('smtp_user', str(data.smtpUser, 200))
  if (typeof data.smtpPassword === 'string' && data.smtpPassword) set('smtp_pass_enc', encrypt(cleanPassword(data.smtpPassword)))
  if (typeof data.imapEnabled === 'boolean') set('imap_enabled', data.imapEnabled)
  if (data.imapHost !== undefined) set('imap_host', str(data.imapHost, 200))
  if (data.imapPort !== undefined && int(data.imapPort) > 0) set('imap_port', int(data.imapPort))
  if (SECURITY.includes(data.imapSecurity)) set('imap_security', data.imapSecurity)
  if (data.imapUser !== undefined) set('imap_user', str(data.imapUser, 200))
  if (typeof data.imapPassword === 'string' && data.imapPassword) set('imap_pass_enc', encrypt(cleanPassword(data.imapPassword)))
  if (data.copySmtpPassword === true) {
    // "Use the same login as SMTP": mirror the SMTP credentials, including an already-saved password.
    run('UPDATE mailboxes SET imap_user = smtp_user, imap_pass_enc = smtp_pass_enc WHERE id = ?', id)
  }
  if (data.imapFolder !== undefined) set('imap_folder', str(data.imapFolder, 200) || 'INBOX')
  if (typeof data.importExisting === 'boolean') set('import_existing', data.importExisting)
  if (typeof data.autoReplyEnabled === 'boolean') set('auto_reply_enabled', data.autoReplyEnabled)
  if (typeof data.autoReplyBody === 'string') set('auto_reply_body', data.autoReplyBody.slice(0, 10_000))
}

api.get('/mailboxes', (c) => {
  const user = c.get('user')
  const counts = folderCounts(user.id)
  const mailboxes = all<MailboxRow>('SELECT * FROM mailboxes ORDER BY name').map((m) => ({
    ...serializeMailbox(m, user.role === 'admin'),
    counts: counts.find((x) => x.mailboxId === m.id) ?? { mailboxId: m.id, unassigned: 0, mine: 0, assigned: 0, snoozed: 0, spam: 0 },
  }))
  return c.json({ mailboxes })
})

api.post('/mailboxes', requireAdmin, async (c) => {
  const data = await body(c)
  if (!str(data.name, 100)) throw new AppError('Give the mailbox a name.')
  if (!isEmail(data.email)) throw new AppError('Enter the mailbox email address.')
  const id = tx(() => {
    const created = run('INSERT INTO mailboxes (name, email, created_at) VALUES (?, ?, ?)', str(data.name, 100), normEmail(data.email), now()).id
    applyMailboxFields(created, data)
    return created
  })
  void restartMailbox(id)
  return c.json({ mailbox: serializeMailbox(get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', id)!, true) }, 201)
})

api.patch('/mailboxes/:id', requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'))
  const before = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', id)
  if (!before) throw new AppError('Mailbox not found.', 404)
  const data = await body(c)
  tx(() => applyMailboxFields(id, data))
  const after = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', id)!
  const imapChanged = (['imap_enabled', 'imap_host', 'imap_port', 'imap_security', 'imap_user', 'imap_pass_enc', 'imap_folder'] as const).some((k) => before[k] !== after[k])
  if (imapChanged) {
    // A different server or folder has different message numbers: start counting again.
    if (before.imap_host !== after.imap_host || before.imap_user !== after.imap_user || before.imap_folder !== after.imap_folder) {
      run('UPDATE mailboxes SET imap_uidvalidity = NULL, imap_last_uid = NULL WHERE id = ?', id)
    }
    void restartMailbox(id)
  }
  return c.json({ mailbox: serializeMailbox(get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', id)!, true) })
})

api.delete('/mailboxes/:id', requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'))
  const files = all<{ storage_key: string }>(
    'SELECT a.storage_key FROM attachments a JOIN threads t ON t.id = a.thread_id JOIN conversations c ON c.id = t.conversation_id WHERE c.mailbox_id = ?',
    id,
  )
  tx(() => {
    run('DELETE FROM search WHERE rowid IN (SELECT id FROM conversations WHERE mailbox_id = ?)', id)
    run('DELETE FROM mailboxes WHERE id = ?', id)
  })
  removeFiles(files.map((f) => f.storage_key))
  void restartMailbox(id)
  return c.json({ ok: true })
})

/** Test mail settings before saving. A blank password falls back to the saved one. */
/**
 * Google shows app passwords as four groups ("abcd efgh ijkl mnop") but expects them without the spaces.
 * Every other password is used exactly as typed: spaces can be part of it.
 */
function cleanPassword(value: unknown): string {
  if (typeof value !== 'string') return ''
  return /^\s*([a-z]{4}\s+){3}[a-z]{4}\s*$/i.test(value) ? value.replace(/\s+/g, '') : value
}

api.post('/mailboxes/test', requireAdmin, async (c) => {
  const data = await body(c)
  const saved = data.id ? get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', int(data.id)) : undefined
  const clean = cleanPassword
  try {
    if (data.kind === 'imap') {
      const result = await testImap({
        host: str(data.imapHost, 200),
        port: int(data.imapPort) || 993,
        security: SECURITY.includes(data.imapSecurity) ? data.imapSecurity : 'ssl',
        user: str(data.imapUser, 200),
        pass: clean(data.imapPassword) || decrypt(data.copySmtpPassword === true ? saved?.smtp_pass_enc : saved?.imap_pass_enc),
        folder: str(data.imapFolder, 200) || 'INBOX',
      })
      return c.json({ ok: true, message: `Connected. The folder holds ${result.messages} message${result.messages === 1 ? '' : 's'}.` })
    }
    await testSmtp({
      host: str(data.smtpHost, 200),
      port: int(data.smtpPort) || 587,
      security: SECURITY.includes(data.smtpSecurity) ? data.smtpSecurity : 'starttls',
      user: str(data.smtpUser, 200),
      pass: clean(data.smtpPassword) || decrypt(saved?.smtp_pass_enc),
    })
    return c.json({ ok: true, message: `Connected. ${brandName()} can send mail through this server.` })
  } catch (err) {
    return c.json({ ok: false, message: explainMailError(err) })
  }
})

api.post('/mailboxes/:id/sync', async (c) => {
  await syncMailboxNow(idParam(c.req.param('id')))
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------------

// Written as a record so the compiler fails when a folder is added to the type but not here.
const FOLDERS = Object.keys({ unassigned: 1, mine: 1, mentioned: 1, assigned: 1, pending: 1, snoozed: 1, closed: 1, spam: 1, open: 1, all: 1 } satisfies Record<Folder, 1>) as Folder[]

/** A folder name from the address bar. An unknown name is an error, not "show everything". */
function knownFolder(value: string | undefined): Folder | undefined {
  if (!value) return undefined
  if (!FOLDERS.includes(value as Folder)) throw new AppError(`Unknown folder "${value.slice(0, 40)}".`, 400)
  return value as Folder
}

api.get('/conversations', (c) => {
  const q = c.req.query()
  const assignee = q.assignee === 'none' ? null : q.assignee ? int(q.assignee) : undefined
  return c.json(
    listConversations({
      mailboxId: q.mailbox ? int(q.mailbox) : undefined,
      folder: knownFolder(q.folder),
      status: q.status as Status | undefined,
      assigneeId: assignee,
      customerId: q.customer ? int(q.customer) : undefined,
      tag: q.tag || undefined,
      q: q.q,
      sort: q.sort as 'recent' | 'oldest' | 'waiting' | undefined,
      limit: q.limit ? int(q.limit) : undefined,
      offset: q.offset ? int(q.offset) : undefined,
      me: c.get('user').id,
    }),
  )
})

api.post('/conversations', async (c) => {
  const data = await body(c)
  const kind = data.kind === 'customer' || data.kind === 'note' ? data.kind : 'reply'
  if (!str(data.subject)) throw new AppError('Add a subject.')
  const actor = actorOf(c)
  const created = createConversation(
    {
      mailboxId: int(data.mailboxId),
      customerEmail: str(data.customerEmail, 200),
      customerName: str(data.customerName, 200) || null,
      subject: str(data.subject),
      bodyHtml: String(data.bodyHtml ?? ''),
      kind,
      status: data.status,
      assigneeId: data.assigneeId === undefined ? (kind === 'reply' ? actor.userId : null) : data.assigneeId,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
      cc: data.cc,
      bcc: data.bcc,
      attachmentIds: Array.isArray(data.attachmentIds) ? data.attachmentIds.map(int) : undefined,
    },
    actor,
  )
  if (kind === 'customer') {
    const conv = getConversation(created.id)
    runWorkflows(created.id, conv.mailboxId, 'new', { subject: conv.subject, body: conv.preview, from: conv.customer.email, to: '', customer_name: conv.customer.name })
  }
  return c.json({ conversation: getConversation(created.id, { userId: actor.userId ?? undefined }) }, 201)
})

api.post('/conversations/bulk', async (c) => {
  const data = await body(c)
  const ids: number[] = Array.isArray(data.ids) ? data.ids.map(int).filter((n: number) => n > 0).slice(0, 200) : []
  const actor = actorOf(c)
  if (data.delete === true) {
    for (const id of ids) removeFiles(deleteConversation(id, actor))
  } else {
    for (const id of ids) updateConversation(id, patchFrom(data.patch ?? {}), actor)
  }
  return c.json({ ok: true, count: ids.length })
})

function patchFrom(data: Record<string, any>): ConversationPatch {
  const patch: ConversationPatch = {}
  if (data.status !== undefined) patch.status = data.status
  if (data.assigneeId !== undefined) patch.assigneeId = data.assigneeId === null ? null : int(data.assigneeId)
  if (typeof data.subject === 'string') patch.subject = data.subject
  if (Array.isArray(data.tags)) patch.tags = data.tags.map(String)
  if (Array.isArray(data.addTags)) patch.addTags = data.addTags.map(String)
  if (Array.isArray(data.removeTags)) patch.removeTags = data.removeTags.map(String)
  if (data.snoozedUntil !== undefined) patch.snoozedUntil = data.snoozedUntil === null ? null : Number(data.snoozedUntil)
  if (data.mailboxId !== undefined) patch.mailboxId = int(data.mailboxId)
  if (data.customerId !== undefined) patch.customerId = int(data.customerId)
  return patch
}

api.get('/conversations/:id', (c) => {
  const id = idParam(c.req.param('id'))
  return c.json({ conversation: getConversation(id, { userId: c.get('user').id }), viewers: viewersOf(id) })
})

api.patch('/conversations/:id', async (c) => {
  const id = idParam(c.req.param('id'))
  updateConversation(id, patchFrom(await body(c)), actorOf(c))
  return c.json({ conversation: getConversation(id, { userId: c.get('user').id }) })
})

api.delete('/conversations/:id', (c) => {
  removeFiles(deleteConversation(idParam(c.req.param('id')), actorOf(c)))
  return c.json({ ok: true })
})

api.post('/conversations/:id/reply', async (c) => {
  const id = idParam(c.req.param('id'))
  const data = await body(c)
  // A teammate may have answered while this reply was written. Say so once, and let the writer decide.
  if (data.afterThreadId !== undefined && data.force !== true) {
    const collision = teammateReplyAfter(id, int(data.afterThreadId), c.get('user').id)
    if (collision) return c.json({ error: `${collision.name} replied while you wrote this.`, collision }, 409)
  }
  const threadId = addReply(
    id,
    {
      bodyHtml: String(data.bodyHtml ?? ''),
      to: data.to,
      cc: data.cc,
      bcc: data.bcc,
      status: data.status,
      attachmentIds: Array.isArray(data.attachmentIds) ? data.attachmentIds.map(int) : undefined,
      sendAt: Number.isFinite(Number(data.sendAt)) && Number(data.sendAt) > 0 ? Number(data.sendAt) : undefined,
      ifNoReply: data.ifNoReply === true,
    },
    actorOf(c),
  )
  return c.json({ threadId, conversation: getConversation(id, { userId: c.get('user').id }) }, 201)
})

api.post('/conversations/:id/note', async (c) => {
  const id = idParam(c.req.param('id'))
  const data = await body(c)
  const threadId = addNote(id, { bodyHtml: String(data.bodyHtml ?? ''), attachmentIds: Array.isArray(data.attachmentIds) ? data.attachmentIds.map(int) : undefined }, actorOf(c))
  if (data.status) updateConversation(id, { status: data.status }, actorOf(c))
  return c.json({ threadId, conversation: getConversation(id, { userId: c.get('user').id }) }, 201)
})

api.post('/conversations/:id/merge', async (c) => {
  const id = idParam(c.req.param('id'))
  const data = await body(c)
  const merged = mergeConversations(id, int(data.intoId), actorOf(c))
  return c.json({ conversation: getConversation(merged.id, { userId: c.get('user').id }) })
})

api.put('/conversations/:id/draft', async (c) => {
  const data = await body(c)
  saveDraft(idParam(c.req.param('id')), c.get('user').id, data.kind === 'note' ? 'note' : 'reply', String(data.bodyHtml ?? ''))
  return c.json({ ok: true })
})

api.post('/conversations/:id/presence', async (c) => {
  const user = c.get('user')
  const data = await body(c)
  touchPresence(idParam(c.req.param('id')), { userId: user.id, name: user.name, color: user.color, state: data.state === 'replying' ? 'replying' : 'viewing' })
  return c.json({ ok: true })
})

api.get('/presence', (c) => c.json({ viewers: allViewers() }))

api.delete('/conversations/:id/presence', (c) => {
  leavePresence(idParam(c.req.param('id')), c.get('user').id)
  return c.json({ ok: true })
})

api.get('/threads/:id/full', (c) => c.json({ html: getQuotedHtml(idParam(c.req.param('id'))) }))

api.post('/threads/:id/retry', (c) => {
  retryDelivery(idParam(c.req.param('id')), actorOf(c))
  return c.json({ ok: true })
})

// Send later: send a scheduled reply now, or take it back as a draft.
api.post('/threads/:id/send-now', (c) => {
  sendScheduledNow(idParam(c.req.param('id')), actorOf(c))
  return c.json({ ok: true })
})
api.delete('/threads/:id/scheduled', (c) => {
  cancelScheduled(idParam(c.req.param('id')), actorOf(c))
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------------------------

api.post('/attachments', bodyLimit({ maxSize: config.maxAttachmentBytes + 1024 * 1024, onError: (c) => c.json({ error: 'That file is too large.' }, 413) }), async (c) => {
  const form = await c.req.parseBody()
  const file = form.file
  if (!(file instanceof File)) throw new AppError('Choose a file to upload.')
  if (file.size > config.maxAttachmentBytes) throw new AppError(`Files can be up to ${Math.round(config.maxAttachmentBytes / 1048576)} MB.`, 413)
  const stored = storeAttachment(new Uint8Array(await file.arrayBuffer()), { filename: file.name, mime: file.type || undefined, uploadedBy: c.get('user').id })
  return c.json({ attachment: stored }, 201)
})

const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'])

api.get('/attachments/:id/:name?', (c) => {
  const file = attachmentFile(idParam(c.req.param('id')))
  if (!file) throw new AppError('File not found.', 404)
  const inline = INLINE_SAFE.has(file.mime) && c.req.query('download') === undefined
  const encoded = encodeURIComponent(file.filename).replace(/['()]/g, escape)
  return new Response(file.data as Uint8Array<ArrayBuffer>, {
    headers: {
      'Content-Type': inline ? file.mime : 'application/octet-stream',
      'Content-Length': String(file.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
    },
  })
})

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

api.get('/customers', (c) => {
  const q = c.req.query()
  return c.json(listCustomers({ q: q.q, limit: q.limit ? int(q.limit) : undefined, offset: q.offset ? int(q.offset) : undefined }))
})

api.post('/customers', async (c) => {
  const data = await body(c)
  return c.json({ customer: createCustomer({ ...data, email: str(data.email, 200) }) }, 201)
})

// Who owns an email address. The customer form uses it to offer a merge.
api.get('/customers/lookup', (c) => {
  const email = str(c.req.query('email'), 254).toLowerCase()
  const owner = isEmail(email) ? get<{ customer_id: number }>('SELECT customer_id FROM customer_emails WHERE email = ?', email) : undefined
  return c.json({ customer: owner ? getCustomer(owner.customer_id) : null })
})

api.get('/customers/:id', (c) => {
  const id = idParam(c.req.param('id'))
  return c.json({ customer: getCustomer(id), conversations: listConversations({ customerId: id, limit: 50 }).items })
})

api.patch('/customers/:id', async (c) => {
  const id = idParam(c.req.param('id'))
  const data = await body(c)
  // Merge first: afterwards the other customer's addresses belong to this one and can be saved.
  const sources = (Array.isArray(data.mergeFrom) ? data.mergeFrom : []).map(int).filter((source: number) => source > 0 && source !== id).slice(0, 20)
  return c.json({
    customer: tx(() => {
      for (const source of sources) mergeCustomers(id, source)
      return updateCustomer(id, data)
    }),
  })
})

// ---------------------------------------------------------------------------------------------
// Tags, saved replies, workflows
// ---------------------------------------------------------------------------------------------

api.get('/tags', (c) =>
  c.json({
    tags: all(`SELECT t.id, t.name, t.color, (SELECT COUNT(*) FROM conversation_tags ct WHERE ct.tag_id = t.id) AS count FROM tags t ORDER BY t.name`),
  }),
)

api.post('/tags', async (c) => {
  const data = await body(c)
  const name = str(data.name, 40).toLowerCase().replace(/\s+/g, '-')
  if (!name) throw new AppError('Enter a tag name.')
  if (get('SELECT 1 FROM tags WHERE name = ?', name)) throw new AppError('That tag already exists.', 409)
  const color = /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : '#64748b'
  const { id } = run('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)', name, color, now())
  return c.json({ tag: { id, name, color, count: 0 } }, 201)
})

api.patch('/tags/:id', async (c) => {
  const id = idParam(c.req.param('id'))
  const data = await body(c)
  if (data.name !== undefined) {
    const name = str(data.name, 40).toLowerCase().replace(/\s+/g, '-')
    if (!name) throw new AppError('Enter a tag name.')
    if (get('SELECT 1 FROM tags WHERE name = ? AND id != ?', name, id)) throw new AppError('That tag already exists.', 409)
    run('UPDATE tags SET name = ? WHERE id = ?', name, id)
  }
  if (/^#[0-9a-f]{6}$/i.test(data.color)) run('UPDATE tags SET color = ? WHERE id = ?', data.color, id)
  return c.json({ ok: true })
})

api.delete('/tags/:id', (c) => {
  run('DELETE FROM tags WHERE id = ?', idParam(c.req.param('id')))
  return c.json({ ok: true })
})

const serializeSavedReply = (r: any) => ({ id: r.id, name: r.name, bodyHtml: r.body_html, mailboxId: r.mailbox_id, updatedAt: r.updated_at })

api.get('/saved-replies', (c) => {
  const mailbox = c.req.query('mailbox')
  const rows = mailbox
    ? all('SELECT * FROM saved_replies WHERE mailbox_id IS NULL OR mailbox_id = ? ORDER BY name', int(mailbox))
    : all('SELECT * FROM saved_replies ORDER BY name')
  return c.json({ savedReplies: rows.map(serializeSavedReply) })
})

api.post('/saved-replies', async (c) => {
  const data = await body(c)
  if (!str(data.name, 100)) throw new AppError('Give the saved reply a name.')
  const html = cleanHtml(String(data.bodyHtml ?? ''))
  if (!html) throw new AppError('Write the reply text.')
  const ts = now()
  const { id } = run('INSERT INTO saved_replies (mailbox_id, name, body_html, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', data.mailboxId ? int(data.mailboxId) : null, str(data.name, 100), html, c.get('user').id, ts, ts)
  return c.json({ savedReply: serializeSavedReply(get('SELECT * FROM saved_replies WHERE id = ?', id)) }, 201)
})

api.patch('/saved-replies/:id', async (c) => {
  const id = idParam(c.req.param('id'))
  const data = await body(c)
  if (data.name !== undefined && str(data.name, 100)) run('UPDATE saved_replies SET name = ? WHERE id = ?', str(data.name, 100), id)
  if (typeof data.bodyHtml === 'string') run('UPDATE saved_replies SET body_html = ? WHERE id = ?', cleanHtml(data.bodyHtml), id)
  if (data.mailboxId !== undefined) run('UPDATE saved_replies SET mailbox_id = ? WHERE id = ?', data.mailboxId ? int(data.mailboxId) : null, id)
  run('UPDATE saved_replies SET updated_at = ? WHERE id = ?', now(), id)
  const row = get('SELECT * FROM saved_replies WHERE id = ?', id)
  if (!row) throw new AppError('Saved reply not found.', 404)
  return c.json({ savedReply: serializeSavedReply(row) })
})

api.delete('/saved-replies/:id', (c) => {
  run('DELETE FROM saved_replies WHERE id = ?', idParam(c.req.param('id')))
  return c.json({ ok: true })
})

const serializeWorkflow = (w: any) => ({
  id: w.id,
  name: w.name,
  mailboxId: w.mailbox_id,
  enabled: !!w.enabled,
  trigger: w.trigger,
  match: w.match,
  conditions: parseJson(w.conditions, []),
  actions: parseJson(w.actions, []),
  runCount: w.run_count,
})

const FIELDS = ['subject', 'body', 'from', 'to', 'customer_name']
const OPS = ['contains', 'not_contains', 'is', 'starts_with', 'ends_with']
const ACTIONS = ['add_tag', 'assign', 'set_status', 'add_note']

function workflowFields(data: Record<string, any>) {
  const conditions = (Array.isArray(data.conditions) ? data.conditions : [])
    .filter((x: any) => FIELDS.includes(x?.field) && OPS.includes(x?.op) && str(x?.value))
    .map((x: any) => ({ field: x.field, op: x.op, value: str(x.value) }))
  const actions = (Array.isArray(data.actions) ? data.actions : [])
    .filter((x: any) => ACTIONS.includes(x?.type) && str(String(x?.value ?? ''), 2000))
    .map((x: any) => ({ type: x.type, value: str(String(x.value), 2000) }))
  if (!str(data.name, 100)) throw new AppError('Give the workflow a name.')
  if (actions.length === 0) throw new AppError('Add at least one action.')
  return {
    name: str(data.name, 100),
    mailboxId: data.mailboxId ? int(data.mailboxId) : null,
    enabled: data.enabled !== false,
    trigger: ['new', 'customer_reply', 'any'].includes(data.trigger) ? data.trigger : 'new',
    match: data.match === 'any' ? 'any' : 'all',
    conditions: JSON.stringify(conditions),
    actions: JSON.stringify(actions),
  }
}

// Workspace: branding and optional features. Admins only.
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const LOGO_MAX_BYTES = 512 * 1024

api.patch('/workspace', requireAdmin, async (c) => {
  const data = await body(c)
  const patch: Parameters<typeof saveWorkspace>[0] = {}
  if (typeof data.brandName === 'string') patch.brandName = str(data.brandName, 40)
  if (typeof data.mentions === 'boolean') patch.mentions = data.mentions
  if (typeof data.fourStatuses === 'boolean') {
    patch.fourStatuses = data.fourStatuses
    // Turning the extra status off folds its conversations back into "active", so none is left without a name.
    if (!data.fourStatuses) run(`UPDATE conversations SET status = 'active' WHERE status = 'waiting'`)
  }
  saveWorkspace(patch)
  publish({ type: 'refresh', scope: 'workspace' })
  return c.json({ workspace: publicWorkspace() })
})

api.post('/workspace/logo', requireAdmin, bodyLimit({ maxSize: LOGO_MAX_BYTES + 64 * 1024, onError: (c) => c.json({ error: 'The logo can be up to 512 KB.' }, 413) }), async (c) => {
  const file = (await c.req.parseBody()).file
  if (!(file instanceof File)) throw new AppError('Choose an image.')
  if (!LOGO_TYPES.has(file.type)) throw new AppError('Use a PNG, JPG, WebP or GIF image.')
  if (file.size > LOGO_MAX_BYTES) throw new AppError('The logo can be up to 512 KB.', 413)
  const previous = getWorkspace().logo
  const key = `brand/logo-${Date.now().toString(36)}`
  blobs.put(key, new Uint8Array(await file.arrayBuffer()))
  saveWorkspace({ logo: { key, mime: file.type, version: Date.now() } })
  if (previous) blobs.remove(previous.key)
  publish({ type: 'refresh', scope: 'workspace' })
  return c.json({ workspace: publicWorkspace() })
})

api.delete('/workspace/logo', requireAdmin, (c) => {
  const previous = getWorkspace().logo
  saveWorkspace({ logo: null })
  if (previous) blobs.remove(previous.key)
  publish({ type: 'refresh', scope: 'workspace' })
  return c.json({ workspace: publicWorkspace() })
})

// Import from Help Scout. Admins only.
api.get('/import/helpscout', requireAdmin, (c) => c.json({ import: importStatus() }))
api.post('/import/helpscout/connect', requireAdmin, async (c) => {
  const data = await body(c)
  if (!str(data.appId, 200) || !str(data.appSecret, 200)) throw new AppError('Enter the App ID and the App Secret.')
  return c.json({ inboxes: await connectHelpScout(str(data.appId, 200), str(data.appSecret, 200)) })
})
api.post('/import/helpscout/start', requireAdmin, async (c) => {
  const data = await body(c)
  const inboxes = (Array.isArray(data.inboxes) ? data.inboxes : [])
    .filter((box: any) => int(box?.hsId) > 0)
    .map((box: any) => ({ hsId: int(box.hsId), name: str(box.name, 100), email: str(box.email, 200), mailboxId: box.mailboxId ? int(box.mailboxId) : null }))
  const state = await startImport({ appId: str(data.appId, 200), appSecret: str(data.appSecret, 200), attachments: data.attachments !== false, inboxes })
  publish({ type: 'mailbox', id: 0 })
  return c.json({ import: state })
})
api.post('/import/helpscout/cancel', requireAdmin, (c) => c.json({ import: cancelImport() }))
api.post('/import/helpscout/resume', requireAdmin, (c) => c.json({ import: resumeImport() }))

// Apps: sidebar content and webhooks. See docs/apps.md.
api.get('/apps', requireAdmin, (c) => c.json({ apps: listApps(), events: APP_EVENTS }))
api.post('/apps', requireAdmin, async (c) => c.json({ app: createIntegration(await body(c)) }, 201))
api.patch('/apps/:id', requireAdmin, async (c) => c.json({ app: updateApp(idParam(c.req.param('id')), await body(c)) }))
api.delete('/apps/:id', requireAdmin, (c) => {
  deleteApp(idParam(c.req.param('id')))
  return c.json({ ok: true })
})
api.post('/apps/:id/test', requireAdmin, async (c) => c.json(await testApp(idParam(c.req.param('id')))))
api.get('/apps/:id/deliveries', requireAdmin, (c) => {
  const id = idParam(c.req.param('id'))
  getApp(id)
  return c.json({ deliveries: listDeliveries(id) })
})
api.get('/conversations/:id/apps', async (c) => c.json({ apps: await sidebarsFor(idParam(c.req.param('id'))) }))

api.get('/workflows', (c) => c.json({ workflows: all('SELECT * FROM workflows ORDER BY id').map(serializeWorkflow) }))

api.post('/workflows', requireAdmin, async (c) => {
  const f = workflowFields(await body(c))
  const { id } = run(
    'INSERT INTO workflows (mailbox_id, name, enabled, trigger, match, conditions, actions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    f.mailboxId,
    f.name,
    f.enabled,
    f.trigger,
    f.match,
    f.conditions,
    f.actions,
    now(),
  )
  return c.json({ workflow: serializeWorkflow(get('SELECT * FROM workflows WHERE id = ?', id)) }, 201)
})

api.patch('/workflows/:id', requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'))
  const current = get<any>('SELECT * FROM workflows WHERE id = ?', id)
  if (!current) throw new AppError('Workflow not found.', 404)
  const data = await body(c)
  const f = workflowFields({ ...serializeWorkflow(current), ...data })
  run('UPDATE workflows SET mailbox_id = ?, name = ?, enabled = ?, trigger = ?, match = ?, conditions = ?, actions = ? WHERE id = ?', f.mailboxId, f.name, f.enabled, f.trigger, f.match, f.conditions, f.actions, id)
  return c.json({ workflow: serializeWorkflow(get('SELECT * FROM workflows WHERE id = ?', id)) })
})

api.delete('/workflows/:id', requireAdmin, (c) => {
  run('DELETE FROM workflows WHERE id = ?', idParam(c.req.param('id')))
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------------------------
// API tokens (also used by the MCP server)
// ---------------------------------------------------------------------------------------------

api.get('/tokens', (c) =>
  c.json({
    tokens: all<any>('SELECT id, name, prefix, access, last_used_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC', c.get('user').id).map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      access: t.access,
      lastUsedAt: t.last_used_at,
      createdAt: t.created_at,
    })),
  }),
)

api.post('/tokens', async (c) => {
  if (c.get('via') !== 'web') throw new AppError('Create tokens from the web app.', 403)
  const data = await body(c)
  const name = str(data.name, 100) || 'API token'
  const access = data.access === 'internal' ? 'internal' : 'full'
  const token = `ansa_${randomToken(30)}`
  const { id } = run('INSERT INTO api_tokens (user_id, name, token_hash, prefix, access, created_at) VALUES (?, ?, ?, ?, ?, ?)', c.get('user').id, name, sha256(token), token.slice(0, 10), access, now())
  return c.json({ token: { id, name, prefix: token.slice(0, 10), access, lastUsedAt: null, createdAt: now() }, secret: token }, 201)
})

api.delete('/tokens/:id', (c) => {
  run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', idParam(c.req.param('id')), c.get('user').id)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------------------------
// Reports and live updates
// ---------------------------------------------------------------------------------------------

api.get('/reports', (c) => {
  const q = c.req.query()
  const to = Number(q.to) || now()
  const from = Number(q.from) || to - 30 * 86_400_000
  if (to <= from || to - from > 400 * 86_400_000) throw new AppError('Pick a date range of up to 400 days.')
  return c.json(buildReport({ from, to, mailboxId: q.mailbox ? int(q.mailbox) : undefined, tzOffset: Number(q.tz) || 0 }))
})

api.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    let open = true
    const unsubscribe = subscribe((event) => {
      if (open) void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
    })
    stream.onAbort(() => {
      open = false
      unsubscribe()
    })
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello' }) })
    while (open) {
      await stream.sleep(25_000)
      if (open) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
    }
  }),
)

api.all('*', (c) => c.json({ error: 'Not found.' }, 404))
