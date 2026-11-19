/**
 * Apps: small integrations that live outside Ansa.
 *  - Sidebar: content shown beside a conversation. Either a fixed template, or HTML fetched from the app's URL.
 *  - Webhooks: Ansa POSTs a signed JSON message to the app's URL when something happens.
 * Apps act back through the REST API or MCP with an API token.
 */
import crypto from 'node:crypto'
import { all, get, run, now, parseJson } from '../db.ts'
import { config } from '../config.ts'
import { decrypt, encrypt, randomToken } from '../crypto.ts'
import { APP_EVENTS, onAppEvent, type AppEvent, type AppEventDetail } from '../hooks.ts'
import { cleanHtml, escapeHtml, textToHtml } from '../mail/html.ts'
import { AppError } from './customers.ts'
import { getConversation, listThreads } from './conversations.ts'

export type SidebarMode = 'none' | 'static' | 'dynamic'
const SIDEBAR_MODES: SidebarMode[] = ['none', 'static', 'dynamic']
const TIMEOUT_MS = 8000
const KEEP_DELIVERIES = 50

interface AppRow {
  id: number
  name: string
  enabled: number
  sidebar_mode: SidebarMode
  sidebar_content: string
  sidebar_url: string
  webhook_url: string
  events: string
  mailbox_id: number | null
  secret_enc: string
  created_at: number
}

export const serializeApp = (row: AppRow) => ({
  id: row.id,
  name: row.name,
  enabled: !!row.enabled,
  sidebarMode: row.sidebar_mode,
  sidebarContent: row.sidebar_content,
  sidebarUrl: row.sidebar_url,
  webhookUrl: row.webhook_url,
  events: parseJson<AppEvent[]>(row.events, []),
  mailboxId: row.mailbox_id,
  secret: decrypt(row.secret_enc),
  createdAt: row.created_at,
})

const rowOf = (id: number) => {
  const row = get<AppRow>('SELECT * FROM apps WHERE id = ?', id)
  if (!row) throw new AppError('App not found.', 404)
  return row
}

export const listApps = () => all<AppRow>('SELECT * FROM apps ORDER BY name').map(serializeApp)
export const getApp = (id: number) => serializeApp(rowOf(id))

const parseUrl = (url: string) => {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

// Ports 80 and 443 are one door: the same site usually answers on both.
const door = (url: URL) => url.port || 'web'
const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, '')

function ipv4Of(name: string): number[] | null {
  const parts = name.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null
  const bytes = parts.map(Number)
  return bytes.every((byte) => byte <= 255) ? bytes : null
}

function ipv6Of(name: string): number[] | null {
  const literal = /^\[([0-9a-f:]+)\]$/.exec(name)?.[1]
  if (!literal) return null
  const words = (text: string) => (text ? text.split(':').map((word) => parseInt(word, 16)) : [])
  const [head, tail] = literal.split('::')
  if (tail === undefined) return words(head)
  const left = words(head)
  const right = words(tail)
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
}

const internalV4 = ([a, b]: number[]) =>
  a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)

function internalV6(w: number[]): boolean {
  const zeros = (from: number, to: number) => w.slice(from, to).every((word) => word === 0)
  const embedsV4 = (zeros(0, 5) && (w[5] === 0 || w[5] === 0xffff)) || (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6))
  if (embedsV4) return internalV4([w[6] >> 8, w[6] & 0xff])
  return (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0
}

function isInternalHost(name: string): boolean {
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  const v4 = ipv4Of(name)
  if (v4) return internalV4(v4)
  const v6 = ipv6Of(name)
  return v6 !== null && internalV6(v6)
}

/**
 * An app that points back at the workspace, at its private network, or at a neighbour on the hosted domain,
 * would make Ansa send requests the app's owner could not send. A self-hosted admin owns that network,
 * and docs/apps.md promises that an app on another port of the same machine works.
 */
export function targetRefusal(url: string): string | null {
  const target = parseUrl(url)
  if (!target) return null
  const name = hostOf(target)
  const own = parseUrl(config.appUrl)
  if (own && name === hostOf(own) && (config.hosted || door(target) === door(own))) return 'An app cannot use the address of this workspace.'
  if (config.hosted && isInternalHost(name)) return 'An app cannot use a private or local network address.'
  const suffix = config.appBlockedHostSuffix
  if (suffix && (name === suffix || name.endsWith(`.${suffix}`))) return `An app cannot use an address on ${suffix}.`
  return null
}

function checkUrl(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new AppError(`${label} must be a full address that starts with https://.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError(`${label} must start with https:// or http://.`)
  const refusal = targetRefusal(url.toString())
  if (refusal) throw new AppError(refusal)
  return url.toString().slice(0, 1000)
}

export interface AppInput {
  name?: unknown
  enabled?: unknown
  sidebarMode?: unknown
  sidebarContent?: unknown
  sidebarUrl?: unknown
  webhookUrl?: unknown
  events?: unknown
  mailboxId?: unknown
}

function fields(input: AppInput, current?: AppRow) {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : (current?.name ?? '')
  if (!name) throw new AppError('Give the app a name.')
  const mode = SIDEBAR_MODES.includes(input.sidebarMode as SidebarMode) ? (input.sidebarMode as SidebarMode) : (current?.sidebar_mode ?? 'none')
  const content = typeof input.sidebarContent === 'string' ? input.sidebarContent.slice(0, 20_000) : (current?.sidebar_content ?? '')
  const sidebarUrl = input.sidebarUrl !== undefined ? checkUrl(input.sidebarUrl, 'The sidebar URL') : (current?.sidebar_url ?? '')
  const webhookUrl = input.webhookUrl !== undefined ? checkUrl(input.webhookUrl, 'The webhook URL') : (current?.webhook_url ?? '')
  const events = Array.isArray(input.events) ? APP_EVENTS.filter((e) => (input.events as unknown[]).includes(e)) : parseJson<AppEvent[]>(current?.events, [])
  if (mode === 'static' && !content.trim()) throw new AppError('Write the sidebar content.')
  if (mode === 'dynamic' && !sidebarUrl) throw new AppError('Enter the sidebar URL.')
  if (webhookUrl && events.length === 0) throw new AppError('Choose at least one event for the webhook.')
  const mailboxId = input.mailboxId === undefined ? (current?.mailbox_id ?? null) : Number(input.mailboxId) || null
  if (mailboxId && !get('SELECT 1 FROM mailboxes WHERE id = ?', mailboxId)) throw new AppError('Mailbox not found.', 404)
  const enabled = input.enabled === undefined ? (current ? !!current.enabled : true) : !!input.enabled
  return { name, mode, content, sidebarUrl, webhookUrl, events: JSON.stringify(events), mailboxId, enabled }
}

export function createApp(input: AppInput) {
  const f = fields(input)
  const { id } = run(
    'INSERT INTO apps (name, enabled, sidebar_mode, sidebar_content, sidebar_url, webhook_url, events, mailbox_id, secret_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    f.name, f.enabled, f.mode, f.content, f.sidebarUrl, f.webhookUrl, f.events, f.mailboxId, encrypt(`ansa_app_${randomToken(24)}`), now(),
  )
  return getApp(id)
}

export function updateApp(id: number, input: AppInput & { rotateSecret?: unknown }) {
  const f = fields(input, rowOf(id))
  run('UPDATE apps SET name = ?, enabled = ?, sidebar_mode = ?, sidebar_content = ?, sidebar_url = ?, webhook_url = ?, events = ?, mailbox_id = ? WHERE id = ?', f.name, f.enabled, f.mode, f.content, f.sidebarUrl, f.webhookUrl, f.events, f.mailboxId, id)
  if (input.rotateSecret === true) run('UPDATE apps SET secret_enc = ? WHERE id = ?', encrypt(`ansa_app_${randomToken(24)}`), id)
  return getApp(id)
}

export function deleteApp(id: number) {
  run('DELETE FROM apps WHERE id = ?', id)
}

export const listDeliveries = (appId: number) =>
  all<any>('SELECT * FROM app_deliveries WHERE app_id = ? ORDER BY id DESC LIMIT ?', appId, KEEP_DELIVERIES).map((d) => ({
    id: d.id as number,
    kind: d.kind as 'webhook' | 'sidebar',
    event: d.event as string,
    conversationId: d.conversation_id as number | null,
    ok: !!d.ok,
    status: d.status as number | null,
    detail: d.detail as string,
    durationMs: d.duration_ms as number,
    createdAt: d.created_at as number,
  }))

function record(appId: number, kind: 'webhook' | 'sidebar', event: string, conversationId: number | null, result: { ok: boolean; status: number | null; detail: string; durationMs: number }) {
  if (!get('SELECT 1 FROM apps WHERE id = ?', appId)) return
  run('INSERT INTO app_deliveries (app_id, kind, event, conversation_id, ok, status, detail, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', appId, kind, event, conversationId, result.ok, result.status, result.detail.slice(0, 500), result.durationMs, now())
  run('DELETE FROM app_deliveries WHERE app_id = ? AND id NOT IN (SELECT id FROM app_deliveries WHERE app_id = ? ORDER BY id DESC LIMIT ?)', appId, appId, KEEP_DELIVERIES)
}

// ---------------------------------------------------------------------------------------------
// What Ansa sends to an app
// ---------------------------------------------------------------------------------------------

/** The conversation and customer, in the shape documented in docs/apps.md. Keep it stable. */
function conversationPayload(conversationId: number) {
  const c = getConversation(conversationId)
  return {
    conversation: {
      id: c.id,
      url: c.url,
      subject: c.subject,
      status: c.status,
      mailbox: { id: c.mailboxId, name: c.mailboxName },
      assignee: c.assignee ? { id: c.assignee.id, name: c.assignee.name } : null,
      tags: c.tags.map((t) => t.name),
      preview: c.preview,
      threadCount: c.threadCount,
      createdAt: new Date(c.createdAt).toISOString(),
      updatedAt: new Date(c.updatedAt).toISOString(),
    },
    customer: {
      id: c.customer.id,
      name: c.customer.name,
      email: c.customer.email,
      emails: c.customer.emails,
      company: c.customer.company,
      title: c.customer.title,
      phone: c.customer.phone,
      location: c.customer.location,
    },
  }
}

/** Made-up data for the Test button. */
const sample = (): ReturnType<typeof conversationPayload> => ({
  conversation: {
    id: 0,
    url: `${config.appUrl}/c/0`,
    subject: 'Test from Ansa',
    status: 'active',
    mailbox: { id: 0, name: 'Support' },
    assignee: null,
    tags: ['test'],
    preview: 'This is a test message from Ansa.',
    threadCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  customer: { id: 0, name: 'Jane Doe', email: 'jane@example.com', emails: ['jane@example.com'], company: 'Acme', title: '', phone: '', location: '' },
})

const sign = (secret: string, body: string) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`

async function post(url: string, secret: string, event: string, payload: unknown): Promise<{ ok: boolean; status: number | null; detail: string; durationMs: number; text: string; contentType: string; retry: boolean }> {
  const refusal = targetRefusal(url)
  if (refusal) return { ok: false, status: null, detail: refusal, durationMs: 0, text: '', contentType: '', retry: false }
  const body = JSON.stringify(payload)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Ansa-Apps/1', 'X-Ansa-Event': event, 'X-Ansa-Signature': sign(secret, body) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = (await res.text()).slice(0, 200_000)
    return { ok: res.ok, status: res.status, detail: res.ok ? 'OK' : `The app answered ${res.status}. ${text.slice(0, 200)}`.trim(), durationMs: Date.now() - started, text, contentType: res.headers.get('content-type') || '', retry: res.status >= 500 }
  } catch (err) {
    const e = err as Error
    const detail = e.name === 'TimeoutError' || e.name === 'AbortError' ? `No answer within ${TIMEOUT_MS / 1000} seconds.` : `Could not reach the app: ${e.message}`
    return { ok: false, status: null, detail, durationMs: Date.now() - started, text: '', contentType: '', retry: true }
  }
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

async function deliver(app: ReturnType<typeof serializeApp>, event: string, conversationId: number | null, payload: unknown) {
  let result = await post(app.webhookUrl, app.secret, event, payload)
  // One more try for a hiccup on the app's side. Answers like 400 or 404 are final.
  if (result.retry) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    result = await post(app.webhookUrl, app.secret, event, payload)
  }
  record(app.id, 'webhook', event, conversationId, result)
  return result
}

onAppEvent((event: AppEvent, conversationId: number, detail: AppEventDetail) => {
  const apps = listApps().filter((app) => app.enabled && app.webhookUrl && app.events.includes(event))
  if (apps.length === 0) return
  const base = conversationPayload(conversationId)
  const thread = detail.threadId ? listThreads(conversationId).find((t) => t.id === detail.threadId) : undefined
  const payload = {
    event,
    sentAt: new Date().toISOString(),
    ...base,
    ...(thread
      ? {
          message: {
            id: thread.id,
            type: thread.type,
            author: thread.author.kind === 'system' ? { kind: 'system', name: thread.author.name } : { kind: thread.author.kind, id: thread.author.id, name: thread.author.name },
            html: thread.bodyHtml,
            attachments: thread.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size })),
            createdAt: new Date(thread.createdAt).toISOString(),
          },
        }
      : {}),
    ...(detail.change ? { change: detail.change } : {}),
  }
  for (const app of apps) {
    if (app.mailboxId && app.mailboxId !== base.conversation.mailbox.id) continue
    void deliver(app, event, conversationId, payload).catch((err) => console.error('[apps]', err))
  }
})

// ---------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------

/** Fill {{customer.email}} style placeholders. Add "|url" to make a value safe inside a link: {{customer.email|url}}. */
function fillSidebar(template: string, data: ReturnType<typeof conversationPayload>): string {
  const firstName = data.customer.name.trim().split(/\s+/)[0] || ''
  const values: Record<string, string> = {
    'customer.id': String(data.customer.id),
    'customer.name': data.customer.name,
    'customer.firstName': firstName,
    'customer.email': data.customer.email,
    'customer.company': data.customer.company,
    'customer.phone': data.customer.phone,
    'customer.location': data.customer.location,
    'conversation.id': String(data.conversation.id),
    'conversation.subject': data.conversation.subject,
    'conversation.status': data.conversation.status,
    'conversation.url': data.conversation.url,
    'mailbox.name': data.conversation.mailbox.name,
  }
  return template.replace(/\{\{\s*([a-zA-Z.]+)\s*(\|\s*url\s*)?\}\}/g, (_match, key: string, asUrl?: string) => {
    const value = values[key] ?? ''
    return asUrl ? encodeURIComponent(value) : escapeHtml(value)
  })
}

/** Template text without tags is treated as plain text: paragraphs, clickable links, and [label](https://…) links. */
function templateToHtml(filled: string): string {
  if (/<[a-z][^>]*>/i.test(filled)) return cleanHtml(filled)
  const plain = filled.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  const html = textToHtml(plain).replace(/\[([^\]\n]{1,200})\]\(<a href="([^"]+)"[^>]*>[^<]*<\/a>\)/g, '<a href="$2">$1</a>')
  return cleanHtml(html)
}

async function renderOne(app: ReturnType<typeof serializeApp>, data: ReturnType<typeof conversationPayload>, conversationId: number | null): Promise<{ html: string; error: string | null }> {
  if (app.sidebarMode === 'static') return { html: templateToHtml(fillSidebar(app.sidebarContent, data)), error: null }
  const result = await post(app.sidebarUrl, app.secret, 'sidebar', { event: 'sidebar', sentAt: new Date().toISOString(), ...data })
  if (!result.ok) {
    record(app.id, 'sidebar', 'sidebar', conversationId, result)
    return { html: '', error: result.detail }
  }
  let html = result.text
  if (result.contentType.includes('json') || /^\s*\{/.test(result.text)) {
    try {
      const parsed = JSON.parse(result.text) as { html?: unknown }
      if (typeof parsed.html !== 'string') throw new Error('missing')
      html = parsed.html
    } catch {
      const failure = { ...result, ok: false, detail: 'The app must answer with JSON like {"html": "..."} or with plain HTML.' }
      record(app.id, 'sidebar', 'sidebar', conversationId, failure)
      return { html: '', error: failure.detail }
    }
  }
  return { html: cleanHtml(html.slice(0, 100_000)), error: null }
}

/** Sidebar content of every enabled app for one conversation. Apps load side by side; one slow app does not block the others. */
export async function sidebarsFor(conversationId: number) {
  const data = conversationPayload(conversationId)
  const apps = listApps().filter((app) => app.enabled && app.sidebarMode !== 'none' && (!app.mailboxId || app.mailboxId === data.conversation.mailbox.id))
  return Promise.all(apps.map(async (app) => ({ id: app.id, name: app.name, ...(await renderOne(app, data, conversationId)) })))
}

/** Try an app with sample data, so its owner sees right away if the URL and the answer are right. */
export async function testApp(id: number) {
  const app = getApp(id)
  const out: { sidebar?: { ok: boolean; message: string; html?: string }; webhook?: { ok: boolean; message: string } } = {}
  if (app.sidebarMode !== 'none') {
    const result = await renderOne(app, sample(), null)
    out.sidebar = result.error ? { ok: false, message: result.error } : { ok: true, message: result.html ? 'The sidebar content loaded.' : 'The app answered, but the content is empty.', html: result.html }
  }
  if (app.webhookUrl) {
    const result = await deliver(app, 'ping', null, { event: 'ping', sentAt: new Date().toISOString(), ...sample() })
    out.webhook = { ok: result.ok, message: result.ok ? `The webhook answered ${result.status} in ${result.durationMs} ms.` : result.detail }
  }
  return out
}
