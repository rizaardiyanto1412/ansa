/**
 * Import conversations from Help Scout through its Inbox API (Help Scout calls it "Mailbox API 2.0").
 * Help Scout has no file export for conversations, so the API is the only way to get them out.
 *
 * The import runs in small steps. Each step makes a limited number of requests, saves its place,
 * and can be repeated safely: a conversation that is already here is skipped. This matters on
 * Cloudflare, where one invocation may only make a few dozen requests, and it makes the import
 * survive a restart anywhere.
 */
import { all, get, run, tx, now, getSetting, setSetting } from '../db.ts'
import { decrypt, encrypt, hashPassword, randomToken } from '../crypto.ts'
import { config } from '../config.ts'
import { publish } from '../events.ts'
import { currentTenant } from '../tenant.ts'
import { cleanHtml, htmlToText, previewOf } from '../mail/html.ts'
import { USER_COLORS } from '../auth.ts'
import { storeAttachment } from './attachments.ts'
import { ensureTag, reindex } from './conversations.ts'
import { AppError, findOrCreateCustomer, isEmail, normEmail } from './customers.ts'

const API = () => (typeof process !== 'undefined' && process.env?.HELPSCOUT_API ? process.env.HELPSCOUT_API : 'https://api.helpscout.net').replace(/\/+$/, '')
const KEY = 'import_helpscout'
/** Requests one step may make. Cloudflare's free plan allows 50 per invocation. */
const STEP_BUDGET = 40
/** Conversations one step may store, so a step stays well inside Cloudflare's CPU time limit. */
const STEP_CONVERSATIONS = 200
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface ImportInbox {
  hsId: number
  name: string
  email: string
  /** The Ansa mailbox that receives the conversations. */
  mailboxId: number
  page: number
  totalPages: number
  total: number
  done: boolean
}

export interface ImportState {
  status: 'idle' | 'running' | 'paused' | 'done' | 'cancelled'
  startedAt: number | null
  finishedAt: number | null
  /** Why the import paused, in words a person can act on. */
  message: string | null
  attachments: boolean
  inboxes: ImportInbox[]
  imported: number
  skipped: number
  files: number
  filesSkipped: number
  /** Not before this time: Help Scout asked us to slow down. */
  waitUntil: number
  // Kept only while an import exists. Encrypted.
  appId?: string
  secretEnc?: string
  token?: string
}

const EMPTY: ImportState = { status: 'idle', startedAt: null, finishedAt: null, message: null, attachments: true, inboxes: [], imported: 0, skipped: 0, files: 0, filesSkipped: 0, waitUntil: 0 }
const load = (): ImportState => ({ ...EMPTY, ...getSetting<Partial<ImportState>>(KEY, {}) })
const save = (state: ImportState) => setSetting(KEY, state)

/** What the settings page shows. Never includes the credentials. */
export function importStatus() {
  const { appId: _a, secretEnc: _s, token: _t, ...rest } = load()
  return rest
}

export const importIsRunning = () => load().status === 'running'

// ---------------------------------------------------------------------------------------------
// Talking to Help Scout
// ---------------------------------------------------------------------------------------------

class SlowDown extends Error {
  constructor(readonly seconds: number) {
    super('Help Scout asked to slow down.')
  }
}

async function fetchToken(appId: string, appSecret: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${API()}/v2/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new AppError(`Could not reach Help Scout: ${(err as Error).message}`, 502)
  }
  if (res.status === 400 || res.status === 401) throw new AppError('Help Scout did not accept the App ID and App Secret. Copy both again from Your Profile → My Apps.', 400)
  if (!res.ok) throw new AppError(`Help Scout answered ${res.status}. Try again in a minute.`, 502)
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new AppError('Help Scout did not return an access token.', 502)
  return data.access_token
}

interface Session {
  token: string
  /** Counts requests so a step can stop before it runs out. */
  used: number
  refresh: () => Promise<string>
}

async function hs<T>(session: Session, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    session.used++
    const res = await fetch(path.startsWith('http') ? path : `${API()}${path}`, { headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    if (res.status === 401 && attempt === 0) {
      session.token = await session.refresh()
      continue
    }
    if (res.status === 429) throw new SlowDown(Math.min(120, Number(res.headers.get('x-ratelimit-retry-after')) || 15))
    if (res.status >= 500 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      continue
    }
    if (!res.ok) throw new Error(`Help Scout answered ${res.status} for ${path.replace(/\?.*/, '')}`)
    return (await res.json()) as T
  }
}

interface HsPage<K extends string, T> {
  _embedded?: Record<K, T[]>
  page: { number: number; size: number; totalElements: number; totalPages: number }
}
interface HsPerson {
  id: number
  type?: 'customer' | 'user' | 'team'
  first?: string
  last?: string
  email?: string
}
interface HsAttachment {
  id: number
  filename?: string
  mimeType?: string
  size?: number
  state?: string
}
interface HsThread {
  id: number
  type: 'beaconchat' | 'chat' | 'customer' | 'forwardchild' | 'forwardparent' | 'lineitem' | 'message' | 'note' | 'phone'
  status?: string
  state?: string
  body?: string
  createdBy?: HsPerson
  customer?: HsPerson
  to?: string[]
  cc?: string[]
  bcc?: string[]
  createdAt: string
  _embedded?: { attachments?: HsAttachment[] }
}
interface HsConversation {
  id: number
  number: number
  threads: number
  status: 'active' | 'pending' | 'closed' | 'spam' | 'open'
  state?: string
  subject?: string
  preview?: string
  createdAt: string
  closedAt?: string
  userUpdatedAt?: string
  cc?: string[]
  assignee?: HsPerson
  primaryCustomer?: HsPerson
  tags?: { tag: string }[]
  _embedded?: { threads?: HsThread[] }
}

/** Check the credentials and list the Help Scout inboxes with how many conversations each one holds. */
export async function connectHelpScout(appId: string, appSecret: string) {
  const session: Session = { token: await fetchToken(appId, appSecret), used: 0, refresh: () => fetchToken(appId, appSecret) }
  const inboxes: { id: number; name: string; email: string; conversations: number }[] = []
  for (let page = 1; page <= 10; page++) {
    const data = await hs<HsPage<'mailboxes', { id: number; name: string; email: string }>>(session, `/v2/mailboxes?page=${page}`)
    for (const box of data._embedded?.mailboxes ?? []) inboxes.push({ id: box.id, name: box.name, email: box.email, conversations: 0 })
    if (page >= data.page.totalPages) break
  }
  await Promise.all(
    inboxes.slice(0, 30).map(async (box) => {
      const data = await hs<HsPage<'conversations', HsConversation>>(session, `/v2/conversations?mailbox=${box.id}&status=all&page=1`).catch(() => null)
      box.conversations = data?.page.totalElements ?? 0
    }),
  )
  return inboxes
}

// ---------------------------------------------------------------------------------------------
// Starting, stopping
// ---------------------------------------------------------------------------------------------

export interface StartInput {
  appId: string
  appSecret: string
  attachments: boolean
  /** mailboxId null means: create a new Ansa mailbox with the Help Scout inbox's name and address. */
  inboxes: { hsId: number; name: string; email: string; mailboxId: number | null }[]
}

export async function startImport(input: StartInput) {
  if (load().status === 'running') throw new AppError('An import is already running.', 409)
  if (input.inboxes.length === 0) throw new AppError('Choose at least one inbox to import.')
  const token = await fetchToken(input.appId, input.appSecret)
  const inboxes: ImportInbox[] = input.inboxes.map((box) => {
    let mailboxId = box.mailboxId
    if (mailboxId) {
      if (!get('SELECT 1 FROM mailboxes WHERE id = ?', mailboxId)) throw new AppError('Mailbox not found.', 404)
    } else {
      const email = isEmail(box.email) ? normEmail(box.email) : `inbox-${box.hsId}@imported.invalid`
      mailboxId = run('INSERT INTO mailboxes (name, email, created_at) VALUES (?, ?, ?)', (box.name || 'Imported').slice(0, 100), email, now()).id
    }
    return { hsId: box.hsId, name: box.name, email: box.email, mailboxId, page: 1, totalPages: 0, total: 0, done: false }
  })
  save({ ...EMPTY, status: 'running', startedAt: now(), attachments: input.attachments, inboxes, appId: input.appId, secretEnc: encrypt(input.appSecret), token })
  publish({ type: 'refresh', scope: 'import' })
  kick()
  return importStatus()
}

export function cancelImport() {
  const state = load()
  if (state.status !== 'running' && state.status !== 'paused') return importStatus()
  save({ ...state, status: 'cancelled', finishedAt: now(), message: null, appId: undefined, secretEnc: undefined, token: undefined })
  return importStatus()
}

export function resumeImport() {
  const state = load()
  if (state.status !== 'paused') return importStatus()
  save({ ...state, status: 'running', message: null, waitUntil: 0 })
  kick()
  return importStatus()
}

// ---------------------------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------------------------

/**
 * Do a bounded amount of work. Returns true when another step should follow.
 * Safe to call at any time and from several places: only one step runs at once.
 */
export async function importStep(): Promise<boolean> {
  const flags = currentTenant().importing
  if (flags.stepping) return true
  let state = load()
  if (state.status !== 'running') return false
  if (state.waitUntil > Date.now()) return true
  flags.stepping = true
  try {
    const appId = state.appId ?? ''
    const secret = decrypt(state.secretEnc)
    const session: Session = {
      token: state.token ?? '',
      used: 0,
      refresh: async () => {
        const token = await fetchToken(appId, secret)
        save({ ...load(), token })
        return token
      },
    }
    let stored = 0
    while (session.used < STEP_BUDGET && stored < STEP_CONVERSATIONS) {
      state = load()
      if (state.status !== 'running') return false
      const inbox = state.inboxes.find((box) => !box.done)
      if (!inbox) {
        save({ ...state, status: 'done', finishedAt: now(), message: null, appId: undefined, secretEnc: undefined, token: undefined })
        publish({ type: 'refresh', scope: 'import' })
        return false
      }
      // Oldest first, so numbers in Ansa follow the order conversations were created in.
      const data = await hs<HsPage<'conversations', HsConversation>>(session, `/v2/conversations?mailbox=${inbox.hsId}&status=all&embed=threads&sortField=createdAt&sortOrder=asc&page=${inbox.page}`)
      const conversations = data._embedded?.conversations ?? []
      let finishedPage = true
      // Counted here and saved once per page: every save is a database write, and those are metered on Cloudflare.
      const tally = { imported: 0, skipped: 0, files: 0, filesSkipped: 0 }
      try {
        for (const conversation of conversations) {
          if (get('SELECT 1 FROM import_map WHERE source = ? AND external_id = ?', 'helpscout', String(conversation.id))) continue
          if (session.used >= STEP_BUDGET) {
            finishedPage = false
            break
          }
          const result = await importConversation(session, conversation, inbox.mailboxId, state.attachments)
          stored++
          tally.imported += result.imported ? 1 : 0
          tally.skipped += result.imported ? 0 : 1
          tally.files += result.files
          tally.filesSkipped += result.filesSkipped
        }
      } finally {
        const counted = load()
        save({ ...counted, imported: counted.imported + tally.imported, skipped: counted.skipped + tally.skipped, files: counted.files + tally.files, filesSkipped: counted.filesSkipped + tally.filesSkipped })
      }
      const fresh = load()
      const boxes = fresh.inboxes.map((box) =>
        box.hsId !== inbox.hsId ? box : { ...box, total: data.page.totalElements, totalPages: data.page.totalPages, page: finishedPage ? box.page + 1 : box.page, done: finishedPage && box.page >= data.page.totalPages },
      )
      save({ ...fresh, inboxes: boxes })
      if (!finishedPage) break
    }
    publish({ type: 'refresh', scope: 'import' })
    return true
  } catch (err) {
    const current = load()
    if (err instanceof SlowDown) {
      save({ ...current, waitUntil: Date.now() + err.seconds * 1000 })
      return true
    }
    const text = (err as Error).message || String(err)
    console.error('[import]', text)
    // Stop and say why. Nothing is lost: Resume continues where it stopped.
    const message = /exceeded|limit|quota|SQLITE_FULL|storage/i.test(text)
      ? `The import paused because a storage or usage limit was reached (${text}). On Cloudflare's free plan this resets every day. Press Resume to continue.`
      : `The import paused: ${text}. Press Resume to continue.`
    if (current.status === 'running') save({ ...current, status: 'paused', message })
    publish({ type: 'refresh', scope: 'import' })
    return false
  } finally {
    flags.stepping = false
  }
}

/** Keep stepping until there is nothing left. Used where the process stays alive (a server). On Cloudflare the alarm calls importStep instead. */
export function kick() {
  const flags = currentTenant().importing
  if (config.imapPollOnly || flags.looping) return
  flags.looping = true
  void (async () => {
    try {
      while (await importStep()) await new Promise((resolve) => setTimeout(resolve, load().waitUntil > Date.now() ? 2000 : 150))
    } finally {
      flags.looping = false
    }
  })()
}

// ---------------------------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------------------------

const fullName = (person?: HsPerson) => [person?.first, person?.last].filter(Boolean).join(' ').trim()
const ts = (iso?: string) => (iso ? Date.parse(iso) || 0 : 0)
const emails = (list?: string[]) => JSON.stringify((list ?? []).filter(isEmail).map(normEmail))

/** The Ansa teammate for a Help Scout user. People who never joined Ansa become disabled teammates, so their name stays on what they wrote. */
function teammateFor(person: HsPerson | undefined): number | null {
  if (!person || !person.email || !isEmail(person.email)) return null
  const email = normEmail(person.email)
  const existing = get<{ id: number }>('SELECT id FROM users WHERE email = ?', email)
  if (existing) return existing.id
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0
  return run(
    `INSERT INTO users (name, email, password_hash, role, color, disabled, notify_assigned, notify_replies, created_at) VALUES (?, ?, ?, 'agent', ?, 1, 0, 0, ?)`,
    fullName(person) || email.split('@')[0],
    email,
    hashPassword(randomToken()),
    USER_COLORS[count % USER_COLORS.length],
    now(),
  ).id
}

async function importConversation(session: Session, c: HsConversation, mailboxId: number, withFiles: boolean): Promise<{ imported: boolean; files: number; filesSkipped: number }> {
  const none = { imported: false, files: 0, filesSkipped: 0 }
  const mark = (conversationId: number | null) => run('INSERT OR IGNORE INTO import_map (source, external_id, conversation_id, external_number) VALUES (?, ?, ?, ?)', 'helpscout', String(c.id), conversationId, c.number ?? null)
  if (c.status === 'spam' || (c.state && c.state !== 'published')) {
    mark(null)
    return none
  }

  // The list call includes the threads. Long conversations are cut off there, so fetch the rest.
  let threads = c._embedded?.threads ?? []
  if (threads.length < (c.threads ?? 0)) {
    threads = []
    for (let page = 1; page <= 20; page++) {
      const data = await hs<HsPage<'threads', HsThread>>(session, `/v2/conversations/${c.id}/threads?page=${page}`)
      threads.push(...(data._embedded?.threads ?? []))
      if (page >= data.page.totalPages) break
    }
  }
  const kept = threads
    .filter((t) => t.type !== 'lineitem' && (!t.state || t.state === 'published') && (t.body ?? '').trim() !== '')
    .sort((a, b) => ts(a.createdAt) - ts(b.createdAt) || a.id - b.id)
  if (kept.length === 0) {
    mark(null)
    return none
  }

  const person = c.primaryCustomer
  const customerEmail = person?.email && isEmail(person.email) ? person.email : `customer-${person?.id ?? c.id}@no-email.invalid`
  const createdAt = ts(c.createdAt) || ts(kept[0].createdAt) || now()
  const filesWanted: { threadId: number; file: HsAttachment }[] = []

  const conversationId = tx(() => {
    const customer = findOrCreateCustomer(customerEmail, fullName(person))
    const status = c.status === 'closed' ? 'closed' : c.status === 'pending' ? 'pending' : 'active'
    // Only someone who can sign in may own an open conversation.
    const assigneeId = c.assignee?.email ? (get<{ id: number }>('SELECT id FROM users WHERE email = ? AND disabled = 0', normEmail(c.assignee.email))?.id ?? null) : null
    const { id } = run(
      `INSERT INTO conversations (mailbox_id, customer_id, subject, status, assignee_id, cc, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'helpscout', ?, ?)`,
      mailboxId,
      customer.id,
      (c.subject || '').trim().slice(0, 500),
      status,
      assigneeId,
      emails(c.cc),
      createdAt,
      createdAt,
    )
    let lastCustomerAt: number | null = null
    let lastAgentAt: number | null = null
    let firstReplyAt: number | null = null
    let lastType = ''
    let lastText = ''
    let lastAt = createdAt
    for (const t of kept) {
      const at = ts(t.createdAt) || lastAt
      const fromCustomer = t.createdBy?.type === 'customer' || t.type === 'customer'
      const type = t.type === 'note' || t.type === 'phone' || t.type === 'forwardparent' || t.type === 'forwardchild' ? (fromCustomer && t.type !== 'note' ? 'customer' : 'note') : fromCustomer ? 'customer' : 'reply'
      const html = cleanHtml(t.body ?? '')
      const text = htmlToText(html)
      const userId = type === 'customer' ? null : teammateFor(t.createdBy)
      const thread = run(
        `INSERT INTO threads (conversation_id, type, user_id, customer_id, body_html, body_text, from_addr, to_addrs, cc, bcc, state, event, via, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, 'import', ?)`,
        id,
        type,
        userId,
        type === 'customer' ? customer.id : null,
        html,
        text,
        type === 'customer' ? (t.createdBy?.email ?? customer.email) : '',
        emails(t.to),
        emails(t.cc),
        emails(t.bcc),
        type === 'reply' && ['active', 'pending', 'closed'].includes(t.status ?? '') ? JSON.stringify({ status: t.status }) : null,
        at,
      )
      for (const file of t._embedded?.attachments ?? []) if (file.state !== 'virus') filesWanted.push({ threadId: thread.id, file })
      if (type === 'customer') lastCustomerAt = at
      if (type === 'reply') {
        lastAgentAt = at
        firstReplyAt ??= at
      }
      if (type !== 'note') {
        lastType = type
        lastText = text
      }
      lastAt = Math.max(lastAt, at)
    }
    const closedAt = status === 'closed' ? ts(c.closedAt) || lastAt : null
    run(
      `UPDATE conversations SET preview = ?, thread_count = ?, updated_at = ?, last_customer_at = ?, last_agent_at = ?, first_reply_at = ?, waiting_since = ?, closed_at = ? WHERE id = ?`,
      previewOf(lastText || htmlToText(cleanHtml(kept[kept.length - 1].body ?? ''))),
      kept.length,
      Math.max(lastAt, ts(c.userUpdatedAt)),
      lastCustomerAt,
      lastAgentAt,
      firstReplyAt,
      status === 'active' && lastType === 'customer' ? lastCustomerAt : null,
      closedAt,
      id,
    )
    for (const tag of c.tags ?? []) {
      const name = (tag.tag || '').trim()
      if (name) run('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)', id, ensureTag(name))
    }
    reindex(id)
    mark(id)
    return id
  })

  // Files come one request each, after the conversation is safely stored.
  let files = 0
  let filesSkipped = 0
  for (const { threadId, file } of filesWanted) {
    if (!withFiles || (file.size ?? 0) > MAX_ATTACHMENT_BYTES || session.used >= STEP_BUDGET + 20) {
      filesSkipped++
      continue
    }
    try {
      const data = await hs<{ data?: string }>(session, `/v2/conversations/${c.id}/attachments/${file.id}/data`)
      if (!data.data) throw new Error('empty')
      storeAttachment(Buffer.from(data.data, 'base64'), { filename: file.filename || 'attachment', mime: file.mimeType, threadId })
      files++
    } catch (err) {
      if (err instanceof SlowDown) throw err
      filesSkipped++
    }
  }
  if (files > 0) run('UPDATE conversations SET has_attachments = 1 WHERE id = ?', conversationId)
  return { imported: true, files, filesSkipped }
}

/** How many conversations each import brought in, for the settings page. */
export const importedCount = () => all<{ n: number }>(`SELECT COUNT(*) AS n FROM import_map WHERE source = 'helpscout' AND conversation_id IS NOT NULL`)[0]?.n ?? 0
