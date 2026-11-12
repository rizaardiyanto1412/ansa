import { all, allNamed, get, run, tx, now, parseJson } from '../db.ts'
import { publish } from '../events.ts'
import { emitAppEvent, type AppEvent } from '../hooks.ts'
import { cleanHtml, htmlToText, previewOf } from '../mail/html.ts'
import { deliverThread, newMessageId, queueDelivery, type MailboxRow } from '../mail/outbound.ts'
import { config } from '../config.ts'
import { AppError, findOrCreateCustomer, getCustomer, isEmail, normEmail } from './customers.ts'
import { notifyAssigned, notifyCustomerReply, notifyMentioned } from './notify.ts'
import { brandName, getWorkspace } from './workspace.ts'

/**
 * 'waiting' is only used when the workspace turns on four statuses. It means "waiting on us":
 * the customer answered and it is our turn. 'pending' means waiting on the customer.
 */
export type Status = 'active' | 'waiting' | 'pending' | 'closed' | 'spam'
export const STATUSES: Status[] = ['active', 'waiting', 'pending', 'closed', 'spam']
export type Folder = 'unassigned' | 'mine' | 'mentioned' | 'assigned' | 'pending' | 'snoozed' | 'closed' | 'spam' | 'all' | 'open'

export interface Actor {
  userId: number | null
  via: 'web' | 'api' | 'mcp' | 'workflow' | 'email' | 'system' | 'auto'
}

const OPEN = `c.status IN ('active', 'waiting', 'pending')`
/** Open and our turn to act. */
const NEEDS_US = `c.status IN ('active', 'waiting')`
/**
 * Which conversations each folder holds. With four statuses, "waiting on customer" is not our
 * work, so it leaves Unassigned, Mine and Assigned and gets a folder of its own.
 */
function folderSql(folder: Folder): string | undefined {
  const working = getWorkspace().fourStatuses ? NEEDS_US : OPEN
  const folders: Record<Folder, string> = {
    unassigned: `${working} AND c.assignee_id IS NULL AND c.snoozed_until IS NULL`,
    mine: `${working} AND c.assignee_id = :me AND c.snoozed_until IS NULL`,
    mentioned: `${OPEN} AND c.id IN (SELECT conversation_id FROM mentions WHERE user_id = :me)`,
    assigned: `${working} AND c.assignee_id IS NOT NULL AND c.snoozed_until IS NULL`,
    pending: `c.status = 'pending' AND c.snoozed_until IS NULL`,
    snoozed: `${OPEN} AND c.snoozed_until IS NOT NULL`,
    closed: `c.status = 'closed'`,
    spam: `c.status = 'spam'`,
    open: OPEN,
    all: `c.status != 'spam'`,
  }
  return folders[folder]
}

const BASE_SELECT = `
  SELECT c.*, cu.name AS customer_name, cu.email AS customer_email, cu.company AS customer_company,
         u.name AS assignee_name, u.color AS assignee_color, m.name AS mailbox_name
  FROM conversations c
  JOIN customers cu ON cu.id = c.customer_id
  JOIN mailboxes m ON m.id = c.mailbox_id
  LEFT JOIN users u ON u.id = c.assignee_id`

function tagsFor(ids: number[]): Map<number, { id: number; name: string; color: string }[]> {
  const map = new Map<number, { id: number; name: string; color: string }[]>()
  if (ids.length === 0) return map
  const rows = all<any>(
    `SELECT ct.conversation_id, t.id, t.name, t.color FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id
     WHERE ct.conversation_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.name`,
    ...ids,
  )
  for (const row of rows) {
    const list = map.get(row.conversation_id) ?? []
    list.push({ id: row.id, name: row.name, color: row.color })
    map.set(row.conversation_id, list)
  }
  return map
}

function serialize(row: any, tags: { id: number; name: string; color: string }[] = []) {
  return {
    id: row.id as number,
    mailboxId: row.mailbox_id as number,
    mailboxName: row.mailbox_name as string,
    subject: (row.subject as string) || '(no subject)',
    status: row.status as Status,
    preview: row.preview as string,
    source: row.source as string,
    customer: { id: row.customer_id as number, name: row.customer_name as string, email: row.customer_email as string, company: row.customer_company as string },
    assignee: row.assignee_id ? { id: row.assignee_id as number, name: row.assignee_name as string, color: row.assignee_color as string } : null,
    tags,
    cc: parseJson<string[]>(row.cc, []),
    threadCount: row.thread_count as number,
    hasAttachments: !!row.has_attachments,
    snoozedUntil: row.snoozed_until as number | null,
    waitingSince: row.waiting_since as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastCustomerAt: row.last_customer_at as number | null,
    lastAgentAt: row.last_agent_at as number | null,
    closedAt: row.closed_at as number | null,
  }
}
export type ConversationSummary = ReturnType<typeof serialize>

/** Build an FTS5 query from free text: every word must match, the last one as a prefix. */
export function ftsQuery(q: string): string | null {
  const tokens = q.match(/[\p{L}\p{N}@._+-]+/gu)
  if (!tokens?.length) return null
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ')
}

export interface ListOptions {
  mailboxId?: number
  folder?: Folder
  status?: Status
  assigneeId?: number | null
  customerId?: number
  tag?: string
  q?: string
  sort?: 'recent' | 'oldest' | 'waiting'
  limit?: number
  offset?: number
  me?: number
}

export function listConversations(opts: ListOptions) {
  const where: string[] = []
  const params: Record<string, string | number | null> = {}
  if (opts.mailboxId) {
    where.push('c.mailbox_id = :mailbox')
    params.mailbox = opts.mailboxId
  }
  const inFolder = opts.folder ? folderSql(opts.folder) : undefined
  if (inFolder) {
    where.push(`(${inFolder})`)
    if (opts.folder === 'mine' || opts.folder === 'mentioned') params.me = opts.me ?? 0
  }
  if (opts.status) {
    where.push('c.status = :status')
    params.status = opts.status
  }
  if (opts.assigneeId === null) where.push('c.assignee_id IS NULL')
  else if (opts.assigneeId !== undefined) {
    where.push('c.assignee_id = :assignee')
    params.assignee = opts.assigneeId
  }
  if (opts.customerId) {
    where.push('c.customer_id = :customer')
    params.customer = opts.customerId
  }
  if (opts.tag) {
    where.push('c.id IN (SELECT ct.conversation_id FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.name = :tag)')
    params.tag = opts.tag
  }
  const q = opts.q?.trim()
  if (q) {
    const idMatch = /^#?(\d+)$/.exec(q)
    const fts = ftsQuery(q)
    if (idMatch) {
      where.push('c.id = :qid')
      params.qid = Number(idMatch[1])
    } else if (fts) {
      where.push('c.id IN (SELECT rowid FROM search WHERE search MATCH :fts)')
      params.fts = fts
    } else {
      where.push('0')
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const order =
    opts.sort === 'oldest' ? 'c.updated_at ASC' : opts.sort === 'waiting' ? 'c.waiting_since IS NULL, c.waiting_since ASC, c.updated_at DESC' : 'c.updated_at DESC'
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const rows = allNamed(`${BASE_SELECT} ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params)
  const total = (allNamed(`SELECT COUNT(*) AS n FROM conversations c ${whereSql}`, params)[0]?.n as number) ?? 0
  const tags = tagsFor(rows.map((r) => r.id))
  return { items: rows.map((r) => serialize(r, tags.get(r.id))), total, limit, offset }
}

export function folderCounts(userId: number) {
  const rows = all<any>(
    `SELECT c.mailbox_id AS mailboxId,
       SUM(CASE WHEN ${NEEDS_US} AND c.assignee_id IS NULL AND c.snoozed_until IS NULL THEN 1 ELSE 0 END) AS unassigned,
       SUM(CASE WHEN ${NEEDS_US} AND c.assignee_id = ?1 AND c.snoozed_until IS NULL THEN 1 ELSE 0 END) AS mine,
       SUM(CASE WHEN ${NEEDS_US} AND c.assignee_id IS NOT NULL AND c.snoozed_until IS NULL THEN 1 ELSE 0 END) AS assigned,
       SUM(CASE WHEN ${OPEN} AND c.snoozed_until IS NOT NULL THEN 1 ELSE 0 END) AS snoozed,
       SUM(CASE WHEN c.status = 'spam' THEN 1 ELSE 0 END) AS spam,
       SUM(CASE WHEN ${OPEN} AND c.id IN (SELECT conversation_id FROM mentions WHERE user_id = ?1) THEN 1 ELSE 0 END) AS mentioned
     FROM conversations c GROUP BY c.mailbox_id`,
    userId,
  )
  return rows as { mailboxId: number; unassigned: number; mine: number; assigned: number; snoozed: number; spam: number; mentioned: number }[]
}

function row(id: number): any {
  const r = get<any>(`${BASE_SELECT} WHERE c.id = ?`, id)
  if (!r) throw new AppError('Conversation not found.', 404)
  return r
}

export function getSummary(id: number): ConversationSummary {
  return serialize(row(id), tagsFor([id]).get(id))
}

function serializeThread(t: any, attachments: any[]) {
  return {
    id: t.id as number,
    type: t.type as 'customer' | 'reply' | 'note' | 'event',
    author:
      t.type === 'customer'
        ? { kind: 'customer' as const, id: t.customer_id as number, name: (t.customer_name as string) || t.from_addr, email: (t.customer_email as string) || t.from_addr }
        : t.user_id
          ? { kind: 'user' as const, id: t.user_id as number, name: t.user_name as string, color: t.user_color as string }
          : { kind: 'system' as const, name: t.via === 'auto' ? 'Auto reply' : t.via === 'workflow' ? 'Workflow' : brandName() },
    bodyHtml: t.body_html as string,
    hasQuoted: !!t.body_full_html,
    from: t.from_addr as string,
    to: parseJson<string[]>(t.to_addrs, []),
    cc: parseJson<string[]>(t.cc, []),
    bcc: parseJson<string[]>(t.bcc, []),
    state: t.state as 'sent' | 'sending' | 'failed' | 'scheduled',
    /** When a scheduled reply goes out. Null once it is sent, or while it is held back. */
    sendAt: (t.send_at as number | null) ?? null,
    error: t.error as string | null,
    event: parseJson<Record<string, any> | null>(t.event, null),
    via: t.via as string,
    createdAt: t.created_at as number,
    attachments: attachments.map((a) => ({
      id: a.id as number,
      filename: a.filename as string,
      mime: a.mime as string,
      size: a.size as number,
      inline: !!a.inline,
      url: `/api/attachments/${a.id}/${encodeURIComponent(a.filename)}`,
    })),
  }
}
export type ThreadView = ReturnType<typeof serializeThread>

export function listThreads(conversationId: number): ThreadView[] {
  const threads = all<any>(
    `SELECT t.*, u.name AS user_name, u.color AS user_color, c.name AS customer_name, c.email AS customer_email
     FROM threads t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.conversation_id = ? ORDER BY t.created_at, t.id`,
    conversationId,
  )
  const attachments = all<any>(
    'SELECT a.* FROM attachments a JOIN threads t ON t.id = a.thread_id WHERE t.conversation_id = ? ORDER BY a.id',
    conversationId,
  )
  return threads.map((t) => serializeThread(t, attachments.filter((a) => a.thread_id === t.id)))
}

export function getConversation(id: number, opts: { userId?: number } = {}) {
  const summary = getSummary(id)
  const customer = getCustomer(summary.customer.id)
  const previous = listConversations({ customerId: customer.id, limit: 8 }).items.filter((c) => c.id !== id)
  const draft = opts.userId ? get<any>('SELECT kind, body_html FROM drafts WHERE conversation_id = ? AND user_id = ?', id, opts.userId) : undefined
  return {
    ...summary,
    customer,
    threads: listThreads(id),
    previousConversations: previous.map((c) => ({ id: c.id, subject: c.subject, status: c.status, updatedAt: c.updatedAt })),
    draft: draft ? { kind: draft.kind as 'reply' | 'note', bodyHtml: draft.body_html as string } : null,
    url: `${config.appUrl}/c/${id}`,
  }
}

export function getQuotedHtml(threadId: number): string {
  const t = get<{ body_full_html: string | null; body_html: string }>('SELECT body_full_html, body_html FROM threads WHERE id = ?', threadId)
  if (!t) throw new AppError('Message not found.', 404)
  return t.body_full_html || t.body_html
}

export function reindex(conversationId: number) {
  const c = get<any>('SELECT c.subject, cu.name, cu.email, cu.company FROM conversations c JOIN customers cu ON cu.id = c.customer_id WHERE c.id = ?', conversationId)
  run('DELETE FROM search WHERE rowid = ?', conversationId)
  if (!c) return
  const body = all<{ body_text: string }>(`SELECT body_text FROM threads WHERE conversation_id = ? AND type != 'event' ORDER BY id`, conversationId)
    .map((t) => t.body_text)
    .join('\n')
    .slice(0, 200_000)
  run('INSERT INTO search (rowid, subject, body, customer) VALUES (?, ?, ?, ?)', conversationId, c.subject, body, `${c.name} ${c.email} ${c.company}`)
}

function touch(conversationId: number, mailboxId: number, reason: string, actor: Actor) {
  publish({ type: 'conversation', id: conversationId, mailboxId, reason, actorId: actor.userId })
}

/** Tell apps about a reply or note. A conversation that starts with one also counts as created. */
function announceAgentThread(event: 'conversation.agent_replied' | 'conversation.note_added', conversationId: number, threadId: number, historical: boolean) {
  const first = (get<{ n: number }>('SELECT thread_count AS n FROM conversations WHERE id = ?', conversationId)?.n ?? 0) <= 1
  if (first) emitAppEvent('conversation.created', conversationId, { threadId, historical })
  emitAppEvent(event, conversationId, { threadId, historical })
}

function addEvent(conversationId: number, actor: Actor, event: Record<string, unknown>, at = now()) {
  run(
    `INSERT INTO threads (conversation_id, type, user_id, event, via, created_at) VALUES (?, 'event', ?, ?, ?, ?)`,
    conversationId,
    actor.userId,
    JSON.stringify(event),
    actor.via,
    at,
  )
}

function attach(threadId: number, conversationId: number, attachmentIds: number[] | undefined) {
  if (!attachmentIds?.length) return
  for (const id of attachmentIds) run('UPDATE attachments SET thread_id = ? WHERE id = ? AND thread_id IS NULL', threadId, id)
  run('UPDATE conversations SET has_attachments = 1 WHERE id = ?', conversationId)
}

const cleanList = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list.map((e) => String(e)).filter(isEmail).map(normEmail))] : []

// ---------------------------------------------------------------------------------------------
// Writing threads
// ---------------------------------------------------------------------------------------------

export interface CustomerMessageInput {
  customerId: number
  bodyHtml: string
  bodyFullHtml?: string | null
  bodyText?: string
  from?: string
  to?: string[]
  cc?: string[]
  messageId?: string | null
  inReplyTo?: string | null
  refs?: string | null
  createdAt?: number
  /** Imported old mail: keep its date and do not notify anyone. */
  historical?: boolean
  via?: Actor['via']
}

/** A message from the customer. Reopens the conversation. Returns the new thread id. */
export function addCustomerMessage(conversationId: number, input: CustomerMessageInput): number {
  const at = input.createdAt ?? now()
  const text = input.bodyText ?? htmlToText(input.bodyHtml)
  const threadId = tx(() => {
    const conv = get<any>('SELECT * FROM conversations WHERE id = ?', conversationId)
    if (!conv) throw new AppError('Conversation not found.', 404)
    const { id } = run(
      `INSERT INTO threads (conversation_id, type, customer_id, body_html, body_full_html, body_text, from_addr, to_addrs, cc, message_id, in_reply_to, refs, via, created_at)
       VALUES (?, 'customer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      input.customerId,
      input.bodyHtml,
      input.bodyFullHtml ?? null,
      text,
      input.from ?? '',
      JSON.stringify(input.to ?? []),
      JSON.stringify(input.cc ?? []),
      input.messageId ?? null,
      input.inReplyTo ?? null,
      input.refs ?? null,
      input.via ?? 'email',
      at,
    )
    // A teammate who left must not keep conversations that come back to life.
    const assigneeGone = conv.assignee_id && !get('SELECT 1 FROM users WHERE id = ? AND disabled = 0', conv.assignee_id)
    if (assigneeGone) run('UPDATE conversations SET assignee_id = NULL WHERE id = ?', conversationId)
    run(
      `UPDATE conversations SET status = CASE WHEN status = 'spam' THEN 'spam' ELSE ? END, snoozed_until = NULL, closed_at = NULL, closed_by = NULL,
         preview = ?, thread_count = thread_count + 1, last_customer_at = ?, waiting_since = COALESCE(waiting_since, ?), updated_at = ? WHERE id = ?`,
      // With four statuses, an answer from the customer puts the conversation on our side. A first message stays "active".
      getWorkspace().fourStatuses && conv.thread_count > 0 ? 'waiting' : 'active',
      previewOf(text),
      at,
      at,
      at,
      conversationId,
    )
    holdScheduled(conversationId)
    reindex(conversationId)
    return id
  })
  const conv = get<any>('SELECT mailbox_id, thread_count, assignee_id FROM conversations WHERE id = ?', conversationId)
  touch(conversationId, conv.mailbox_id, conv.thread_count <= 1 ? 'created' : 'customer_reply', { userId: null, via: 'email' })
  emitAppEvent(conv.thread_count <= 1 ? 'conversation.created' : 'conversation.customer_replied', conversationId, { threadId, historical: input.historical })
  if (conv.thread_count > 1 && conv.assignee_id && !input.historical) notifyCustomerReply(conversationId)
  return threadId
}

export interface ReplyInput {
  bodyHtml: string
  to?: string[]
  cc?: string[]
  bcc?: string[]
  status?: Status
  attachmentIds?: number[]
  createdAt?: number
  /** Skip SMTP delivery (imports and demo data). */
  skipDelivery?: boolean
  /** Send later: hold the reply until this time. */
  sendAt?: number
  /** With sendAt: do not send if the customer writes first. */
  ifNoReply?: boolean
}

/** What a sent reply does to its conversation: status, assignee and the timers reports use. */
function markReplied(conversationId: number, r: { status: Status; assignee: number | null; cc: string[]; text: string; at: number; closedBy: number | null }) {
  run(
    `UPDATE conversations SET status = ?, assignee_id = ?, snoozed_until = NULL, cc = ?, preview = ?, thread_count = thread_count + 1,
       last_agent_at = ?, first_reply_at = COALESCE(first_reply_at, ?), waiting_since = NULL, updated_at = ?,
       closed_at = CASE WHEN ? = 'closed' THEN ? ELSE NULL END, closed_by = CASE WHEN ? = 'closed' THEN ? ELSE NULL END
     WHERE id = ?`,
    r.status,
    r.assignee,
    JSON.stringify(r.cc),
    previewOf(r.text),
    r.at,
    r.at,
    r.at,
    r.status,
    r.at,
    r.status,
    r.closedBy,
    conversationId,
  )
}

/** The newest message that really went out or came in: what the next reply answers. */
const lastMailOf = (conversationId: number) =>
  get<any>(`SELECT message_id, refs FROM threads WHERE conversation_id = ? AND message_id IS NOT NULL AND state != 'scheduled' ORDER BY id DESC LIMIT 1`, conversationId)
const refsAfter = (last: any) => (last ? [...String(last.refs || '').split(/\s+/).filter(Boolean), last.message_id].slice(-20).join(' ') : null)

/** A reply from an agent to the customer. Sends the email in the background. */
/** The newest reply a teammate sent after the given thread. The composer asks before it sends a second answer. */
export function teammateReplyAfter(conversationId: number, afterThreadId: number, userId: number): { name: string; at: number } | null {
  const row = get<{ name: string; at: number }>(
    `SELECT u.name AS name, t.created_at AS at FROM threads t JOIN users u ON u.id = t.user_id
     WHERE t.conversation_id = ? AND t.type = 'reply' AND t.id > ? AND t.user_id != ? AND t.state != 'scheduled'
     ORDER BY t.id DESC LIMIT 1`,
    conversationId,
    afterThreadId,
    userId,
  )
  return row ?? null
}

export function addReply(conversationId: number, input: ReplyInput, actor: Actor): number {
  const bodyHtml = cleanHtml(input.bodyHtml)
  const text = htmlToText(bodyHtml)
  if (!text.trim() && !input.attachmentIds?.length) throw new AppError('Write a reply before sending.')
  const at = input.createdAt ?? now()
  // A time that has passed, or is seconds away, means "send now".
  const sendAt = input.sendAt && input.sendAt > now() + 30_000 && actor.via !== 'auto' ? input.sendAt : null
  if (sendAt && sendAt > now() + 366 * 86_400_000) throw new AppError('Choose a time within the next year.')
  let mailboxId = 0
  const threadId = tx(() => {
    const conv = get<any>('SELECT c.*, cu.email AS customer_email FROM conversations c JOIN customers cu ON cu.id = c.customer_id WHERE c.id = ?', conversationId)
    if (!conv) throw new AppError('Conversation not found.', 404)
    const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', conv.mailbox_id)!
    mailboxId = mailbox.id
    const to = cleanList(input.to)
    if (to.length === 0) to.push(conv.customer_email)
    const cc = input.cc ? cleanList(input.cc) : parseJson<string[]>(conv.cc, [])
    const last = lastMailOf(conversationId)
    const refs = refsAfter(last)
    const status: Status = input.status && STATUSES.includes(input.status) ? input.status : 'closed'
    const assignee = conv.assignee_id ?? actor.userId
    const { id } = run(
      `INSERT INTO threads (conversation_id, type, user_id, body_html, body_text, from_addr, to_addrs, cc, bcc, message_id, in_reply_to, refs, state, event, via, created_at, send_at)
       VALUES (?, 'reply', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      actor.userId,
      bodyHtml,
      text,
      mailbox.email,
      JSON.stringify(to),
      JSON.stringify(cc),
      JSON.stringify(cleanList(input.bcc)),
      newMessageId(mailbox.email),
      last?.message_id ?? null,
      refs,
      sendAt ? 'scheduled' : input.skipDelivery || config.mailDisabled ? 'sent' : 'sending',
      JSON.stringify(sendAt ? { status, ifNoReply: !!input.ifNoReply } : { status }),
      actor.via,
      at,
      sendAt,
    )
    attach(id, conversationId, input.attachmentIds)
    if (sendAt) {
      // Nothing went to the customer yet, so the status and the timers stay as they are until it does.
      run('UPDATE conversations SET thread_count = thread_count + 1, assignee_id = ?, updated_at = ? WHERE id = ?', assignee, at, conversationId)
      if (actor.userId) run('DELETE FROM drafts WHERE conversation_id = ? AND user_id = ?', conversationId, actor.userId)
      reindex(conversationId)
      return id
    }
    if (actor.via === 'auto') {
      // An automatic acknowledgement is not a real answer: leave status, assignee and timers alone.
      run('UPDATE conversations SET thread_count = thread_count + 1 WHERE id = ?', conversationId)
      return id
    }
    markReplied(conversationId, { status, assignee, cc, text, at, closedBy: actor.userId })
    if (actor.userId) run('DELETE FROM drafts WHERE conversation_id = ? AND user_id = ?', conversationId, actor.userId)
    reindex(conversationId)
    return id
  })
  if (sendAt) {
    touch(conversationId, mailboxId, 'updated', actor)
    return threadId
  }
  touch(conversationId, mailboxId, 'reply', actor)
  announceAgentThread('conversation.agent_replied', conversationId, threadId, input.createdAt !== undefined)
  if (!input.skipDelivery && !config.mailDisabled) queueDelivery(threadId)
  return threadId
}

const scheduledThread = (threadId: number) => {
  const t = get<any>(`SELECT * FROM threads WHERE id = ? AND type = 'reply' AND state = 'scheduled'`, threadId)
  if (!t) throw new AppError('That reply is not waiting to be sent.')
  return t
}

/**
 * Release a scheduled reply: from now on it is an ordinary reply, written at this moment.
 * The caller delivers it. Returns false when mail is off and there is nothing to deliver.
 */
function releaseScheduled(threadId: number, actor: Actor): boolean {
  let mailboxId = 0
  let conversationId = 0
  tx(() => {
    const t = scheduledThread(threadId)
    const conv = get<any>('SELECT * FROM conversations WHERE id = ?', t.conversation_id)
    conversationId = conv.id
    mailboxId = conv.mailbox_id
    const at = now()
    const event = parseJson<{ status?: Status }>(t.event, {})
    const status: Status = event.status && STATUSES.includes(event.status) ? event.status : 'closed'
    // Answer the newest message, which may have arrived after this reply was written.
    const last = lastMailOf(conv.id)
    run(
      `UPDATE threads SET state = ?, send_at = NULL, created_at = ?, in_reply_to = ?, refs = ?, event = ? WHERE id = ?`,
      config.mailDisabled ? 'sent' : 'sending',
      at,
      last?.message_id ?? null,
      refsAfter(last),
      JSON.stringify({ status }),
      threadId,
    )
    // The thread was counted when it was scheduled.
    run('UPDATE conversations SET thread_count = thread_count - 1 WHERE id = ?', conv.id)
    markReplied(conv.id, { status, assignee: conv.assignee_id ?? t.user_id, cc: parseJson<string[]>(t.cc, []), text: t.body_text, at, closedBy: t.user_id })
    reindex(conv.id)
  })
  touch(conversationId, mailboxId, 'reply', actor)
  announceAgentThread('conversation.agent_replied', conversationId, threadId, false)
  return !config.mailDisabled
}

/** Send a scheduled reply now, without waiting for its time. */
export function sendScheduledNow(threadId: number, actor: Actor) {
  if (releaseScheduled(threadId, actor)) queueDelivery(threadId)
}

/** Take a scheduled reply back. Its text returns to the writer as a draft; its attachments are removed. */
export function cancelScheduled(threadId: number, actor: Actor) {
  const t = scheduledThread(threadId)
  const conv = get<any>('SELECT mailbox_id FROM conversations WHERE id = ?', t.conversation_id)
  tx(() => {
    if (t.user_id) {
      run(
        `INSERT INTO drafts (conversation_id, user_id, kind, body_html, updated_at) VALUES (?, ?, 'reply', ?, ?) ON CONFLICT(conversation_id, user_id) DO NOTHING`,
        t.conversation_id,
        t.user_id,
        t.body_html,
        now(),
      )
    }
    run('DELETE FROM threads WHERE id = ?', threadId)
    run('UPDATE conversations SET thread_count = MAX(0, thread_count - 1), updated_at = ? WHERE id = ?', now(), t.conversation_id)
    reindex(t.conversation_id)
  })
  touch(t.conversation_id, conv.mailbox_id, 'updated', actor)
}

/** The customer wrote: hold back replies that were to go out only if they stayed quiet. */
function holdScheduled(conversationId: number) {
  for (const t of all<any>(`SELECT id, event FROM threads WHERE conversation_id = ? AND state = 'scheduled' AND send_at IS NOT NULL`, conversationId)) {
    const event = parseJson<Record<string, unknown>>(t.event, {})
    if (event.ifNoReply) run('UPDATE threads SET send_at = NULL, event = ? WHERE id = ?', JSON.stringify({ ...event, held: true }), t.id)
  }
}

/** Send every scheduled reply whose time has come. Runs on a timer, and waits for the deliveries. */
export async function dispatchScheduled() {
  const due = all<{ id: number }>(`SELECT id FROM threads WHERE state = 'scheduled' AND send_at IS NOT NULL AND send_at <= ? ORDER BY send_at LIMIT 20`, now())
  for (const { id } of due) {
    try {
      if (releaseScheduled(id, { userId: null, via: 'system' })) await deliverThread(id)
    } catch (err) {
      console.error(`[send later] thread ${id}:`, (err as Error).message)
    }
  }
}

/** When the next scheduled reply is due, for platforms that must set an alarm. */
export const nextScheduledAt = () => get<{ at: number | null }>(`SELECT MIN(send_at) AS at FROM threads WHERE state = 'scheduled' AND send_at IS NOT NULL`)?.at ?? null

export interface NoteInput {
  bodyHtml: string
  attachmentIds?: number[]
  createdAt?: number
}

/** An internal note. Customers never see it. */
export function addNote(conversationId: number, input: NoteInput, actor: Actor): number {
  const bodyHtml = cleanHtml(input.bodyHtml)
  const text = htmlToText(bodyHtml)
  if (!text.trim() && !input.attachmentIds?.length) throw new AppError('Write a note before saving.')
  const at = input.createdAt ?? now()
  let mailboxId = 0
  const threadId = tx(() => {
    const conv = get<any>('SELECT mailbox_id FROM conversations WHERE id = ?', conversationId)
    if (!conv) throw new AppError('Conversation not found.', 404)
    mailboxId = conv.mailbox_id
    const { id } = run(
      `INSERT INTO threads (conversation_id, type, user_id, body_html, body_text, via, created_at) VALUES (?, 'note', ?, ?, ?, ?, ?)`,
      conversationId,
      actor.userId,
      bodyHtml,
      text,
      actor.via,
      at,
    )
    attach(id, conversationId, input.attachmentIds)
    run('UPDATE conversations SET thread_count = thread_count + 1, updated_at = ? WHERE id = ?', at, conversationId)
    if (actor.userId) run(`DELETE FROM drafts WHERE conversation_id = ? AND user_id = ? AND kind = 'note'`, conversationId, actor.userId)
    reindex(conversationId)
    return id
  })
  const mentioned = input.createdAt === undefined ? recordMentions(conversationId, threadId, text, actor.userId) : []
  touch(conversationId, mailboxId, 'note', actor)
  for (const userId of mentioned) notifyMentioned(conversationId, userId, actor.userId)
  announceAgentThread('conversation.note_added', conversationId, threadId, input.createdAt !== undefined)
  return threadId
}

/**
 * Fold one customer into another: the same person wrote from two addresses.
 * Conversations, messages and addresses move to the target. Empty profile fields are filled from the source.
 */
export function mergeCustomers(targetId: number, sourceId: number) {
  if (targetId === sourceId) return
  const target = getCustomer(targetId)
  const source = getCustomer(sourceId)
  tx(() => {
    const moved = all<{ id: number }>('SELECT id FROM conversations WHERE customer_id = ?', sourceId)
    run('UPDATE conversations SET customer_id = ? WHERE customer_id = ?', targetId, sourceId)
    run('UPDATE threads SET customer_id = ? WHERE customer_id = ?', targetId, sourceId)
    run('UPDATE customer_emails SET customer_id = ? WHERE customer_id = ?', targetId, sourceId)
    for (const field of ['company', 'title', 'phone', 'location'] as const) {
      if (!target[field] && source[field]) run(`UPDATE customers SET ${field} = ? WHERE id = ?`, source[field], targetId)
    }
    if (source.notes.trim()) run('UPDATE customers SET notes = ? WHERE id = ?', [target.notes.trim(), source.notes.trim()].filter(Boolean).join('\n\n').slice(0, 5000), targetId)
    run('DELETE FROM customers WHERE id = ?', sourceId)
    // The customer's name is part of the search index.
    for (const { id } of moved) reindex(id)
  })
  publish({ type: 'refresh', scope: 'customers' })
}

/**
 * Find "@Full Name" in a note and remember who was mentioned. Returns the teammates to tell.
 * This always works. The workspace setting only decides if the Mentioned folder is shown.
 */
function recordMentions(conversationId: number, threadId: number, text: string, authorId: number | null): number[] {
  if (!text.includes('@')) return []
  const lower = text.toLowerCase()
  const users = all<{ id: number; name: string }>('SELECT id, name FROM users WHERE disabled = 0')
  // Longest names first, so "@Ann Lee" is not also counted for a teammate called "Ann".
  const found = new Set<number>()
  let rest = lower
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const user of [...users].sort((a, b) => b.name.length - a.name.length)) {
    if (!user.name.trim()) continue
    // "@" must start a word and the name must end one: "team@riza.com" and "@Rizal" do not mention "Riza".
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}._%+-])@${escape(user.name.toLowerCase())}(?![\\p{L}\\p{N}_.-]*[\\p{L}\\p{N}_])`, 'gu')
    if (pattern.test(rest)) {
      found.add(user.id)
      rest = rest.replace(pattern, '$1 ')
    }
  }
  found.delete(authorId ?? -1)
  for (const userId of found) run('INSERT INTO mentions (thread_id, conversation_id, user_id, created_at) VALUES (?, ?, ?, ?)', threadId, conversationId, userId, now())
  return [...found]
}

// ---------------------------------------------------------------------------------------------
// Creating and changing conversations
// ---------------------------------------------------------------------------------------------

export interface CreateInput {
  mailboxId: number
  customerEmail: string
  customerName?: string | null
  subject: string
  bodyHtml: string
  /** customer: the customer wrote in. reply: an agent emails the customer. note: log a call or chat. */
  kind: 'customer' | 'reply' | 'note'
  status?: Status
  assigneeId?: number | null
  tags?: string[]
  cc?: string[]
  bcc?: string[]
  attachmentIds?: number[]
  source?: string
  createdAt?: number
  skipDelivery?: boolean
  email?: Pick<CustomerMessageInput, 'bodyFullHtml' | 'bodyText' | 'from' | 'to' | 'messageId' | 'inReplyTo' | 'refs' | 'historical'>
}

export function createConversation(input: CreateInput, actor: Actor): { id: number; threadId: number } {
  const mailbox = get<{ id: number }>('SELECT id FROM mailboxes WHERE id = ?', input.mailboxId)
  if (!mailbox) throw new AppError('Mailbox not found.', 404)
  if (input.status !== undefined && !STATUSES.includes(input.status)) throw new AppError(`Status must be one of: ${STATUSES.join(', ')}.`)
  if (input.assigneeId != null && !get('SELECT 1 FROM users WHERE id = ? AND disabled = 0', input.assigneeId)) throw new AppError('That teammate does not exist.', 404)
  const at = input.createdAt ?? now()
  return tx(() => {
    const customer = findOrCreateCustomer(input.customerEmail, input.customerName)
    const cc = cleanList(input.cc)
    const { id } = run(
      `INSERT INTO conversations (mailbox_id, customer_id, subject, status, assignee_id, cc, source, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      input.mailboxId,
      customer.id,
      (input.subject || '').trim().slice(0, 500),
      input.assigneeId ?? null,
      JSON.stringify(cc),
      input.source ?? (input.kind === 'customer' ? 'email' : actor.via),
      at,
      at,
    )
    let threadId: number
    if (input.kind === 'customer') {
      threadId = addCustomerMessage(id, { customerId: customer.id, bodyHtml: cleanHtml(input.bodyHtml), cc, createdAt: input.createdAt, via: actor.via, ...input.email })
      attach(threadId, id, input.attachmentIds)
      if (input.status && input.status !== 'active') run('UPDATE conversations SET status = ? WHERE id = ?', input.status, id)
    } else if (input.kind === 'reply') {
      threadId = addReply(
        id,
        { bodyHtml: input.bodyHtml, cc, bcc: input.bcc, status: input.status ?? 'pending', attachmentIds: input.attachmentIds, createdAt: input.createdAt, skipDelivery: input.skipDelivery },
        actor,
      )
    } else {
      threadId = addNote(id, { bodyHtml: input.bodyHtml, attachmentIds: input.attachmentIds, createdAt: input.createdAt }, actor)
      run('UPDATE conversations SET preview = ?, status = ? WHERE id = ?', previewOf(htmlToText(input.bodyHtml)), input.status ?? 'active', id)
    }
    if (input.tags?.length) setTags(id, input.tags)
    return { id, threadId }
  })
}

export function ensureTag(name: string): number {
  const clean = name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40)
  if (!clean) throw new AppError('Tag name is empty.')
  const existing = get<{ id: number }>('SELECT id FROM tags WHERE name = ?', clean)
  if (existing) return existing.id
  const palette = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b']
  const color = palette[[...clean].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % palette.length]
  return run('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)', clean, color, now()).id
}

function setTags(conversationId: number, names: string[]) {
  run('DELETE FROM conversation_tags WHERE conversation_id = ?', conversationId)
  for (const name of new Set(names.map((n) => n.trim()).filter(Boolean))) {
    run('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)', conversationId, ensureTag(name))
  }
}

export interface ConversationPatch {
  status?: Status
  assigneeId?: number | null
  subject?: string
  tags?: string[]
  addTags?: string[]
  removeTags?: string[]
  snoozedUntil?: number | null
  mailboxId?: number
  customerId?: number
}

export function updateConversation(id: number, patch: ConversationPatch, actor: Actor): ConversationSummary {
  let notify: number | null = null
  const mailboxIds = new Set<number>()
  const changes: [AppEvent, Record<string, unknown>][] = []
  const tagNames = () => all<{ name: string }>('SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.conversation_id = ? ORDER BY t.name', id).map((t) => t.name)
  tx(() => {
    const conv = get<any>('SELECT * FROM conversations WHERE id = ?', id)
    if (!conv) throw new AppError('Conversation not found.', 404)
    mailboxIds.add(conv.mailbox_id)
    const at = now()

    if (patch.status !== undefined && patch.status !== conv.status) {
      if (!STATUSES.includes(patch.status)) throw new AppError(`Status must be one of: ${STATUSES.join(', ')}.`)
      const closing = patch.status === 'closed'
      run(
        'UPDATE conversations SET status = ?, closed_at = ?, closed_by = ?, snoozed_until = CASE WHEN ? THEN NULL ELSE snoozed_until END WHERE id = ?',
        patch.status,
        closing ? at : null,
        closing ? actor.userId : null,
        patch.status === 'closed' || patch.status === 'spam',
        id,
      )
      addEvent(id, actor, { kind: 'status', from: conv.status, to: patch.status }, at)
      changes.push(['conversation.status_changed', { from: conv.status, to: patch.status }])
    }

    if (patch.assigneeId !== undefined && patch.assigneeId !== conv.assignee_id) {
      let name: string | null = null
      if (patch.assigneeId !== null) {
        const user = get<{ name: string }>('SELECT name FROM users WHERE id = ? AND disabled = 0', patch.assigneeId)
        if (!user) throw new AppError('That teammate does not exist.', 404)
        name = user.name
        if (patch.assigneeId !== actor.userId) notify = patch.assigneeId
      }
      run('UPDATE conversations SET assignee_id = ? WHERE id = ?', patch.assigneeId, id)
      addEvent(id, actor, { kind: 'assigned', to: patch.assigneeId, toName: name }, at)
      changes.push(['conversation.assigned', { from: conv.assignee_id, to: patch.assigneeId, toName: name }])
    }

    if (typeof patch.subject === 'string' && patch.subject.trim() && patch.subject.trim() !== conv.subject) {
      run('UPDATE conversations SET subject = ? WHERE id = ?', patch.subject.trim().slice(0, 500), id)
    }

    if (patch.snoozedUntil !== undefined && patch.snoozedUntil !== conv.snoozed_until) {
      if (patch.snoozedUntil !== null && patch.snoozedUntil <= at) throw new AppError('Pick a snooze time in the future.')
      run(`UPDATE conversations SET snoozed_until = ?, status = CASE WHEN ? IS NOT NULL AND status IN ('closed', 'spam') THEN 'active' ELSE status END WHERE id = ?`, patch.snoozedUntil, patch.snoozedUntil, id)
      addEvent(id, actor, patch.snoozedUntil ? { kind: 'snoozed', until: patch.snoozedUntil } : { kind: 'unsnoozed' }, at)
    }

    if (patch.mailboxId !== undefined && patch.mailboxId !== conv.mailbox_id) {
      const target = get<{ name: string }>('SELECT name FROM mailboxes WHERE id = ?', patch.mailboxId)
      if (!target) throw new AppError('Mailbox not found.', 404)
      run('UPDATE conversations SET mailbox_id = ? WHERE id = ?', patch.mailboxId, id)
      mailboxIds.add(patch.mailboxId)
      addEvent(id, actor, { kind: 'moved', toName: target.name }, at)
    }

    if (patch.customerId !== undefined && patch.customerId !== conv.customer_id) {
      const customer = getCustomer(patch.customerId)
      run('UPDATE conversations SET customer_id = ? WHERE id = ?', patch.customerId, id)
      addEvent(id, actor, { kind: 'customer', toName: customer.name || customer.email }, at)
    }

    const tagsBefore = patch.tags || patch.addTags?.length || patch.removeTags?.length ? tagNames() : null
    if (patch.tags) setTags(id, patch.tags)
    for (const name of patch.addTags ?? []) {
      if (name.trim()) run('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)', id, ensureTag(name))
    }
    for (const name of patch.removeTags ?? []) {
      run('DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ?)', id, name.trim())
    }
    if (tagsBefore) {
      const tagsAfter = tagNames()
      if (tagsBefore.join('\n') !== tagsAfter.join('\n')) changes.push(['conversation.tags_changed', { from: tagsBefore, to: tagsAfter }])
    }
    reindex(id)
  })
  for (const mailboxId of mailboxIds) touch(id, mailboxId, 'updated', actor)
  for (const [event, change] of changes) emitAppEvent(event, id, { change: { ...change, by: actor.via } })
  if (notify) notifyAssigned(id, notify, actor.userId)
  return getSummary(id)
}

export function deleteConversation(id: number, actor: Actor) {
  const conv = get<any>('SELECT mailbox_id FROM conversations WHERE id = ?', id)
  if (!conv) throw new AppError('Conversation not found.', 404)
  const files = all<{ storage_key: string }>('SELECT a.storage_key FROM attachments a JOIN threads t ON t.id = a.thread_id WHERE t.conversation_id = ?', id)
  tx(() => {
    run('DELETE FROM conversations WHERE id = ?', id)
    run('DELETE FROM search WHERE rowid = ?', id)
  })
  touch(id, conv.mailbox_id, 'deleted', actor)
  return files.map((f) => f.storage_key)
}

/** Fold `sourceId` into `targetId`: every message moves over and the source is removed. */
export function mergeConversations(sourceId: number, targetId: number, actor: Actor): ConversationSummary {
  if (sourceId === targetId) throw new AppError('Pick a different conversation to merge into.')
  const source = get<any>('SELECT * FROM conversations WHERE id = ?', sourceId)
  const target = get<any>('SELECT * FROM conversations WHERE id = ?', targetId)
  if (!source || !target) throw new AppError('Conversation not found.', 404)
  tx(() => {
    run('UPDATE threads SET conversation_id = ? WHERE conversation_id = ?', targetId, sourceId)
    run('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) SELECT ?, tag_id FROM conversation_tags WHERE conversation_id = ?', targetId, sourceId)
    addEvent(targetId, actor, { kind: 'merged', fromId: sourceId, fromSubject: source.subject })
    run(
      `UPDATE conversations SET thread_count = (SELECT COUNT(*) FROM threads WHERE conversation_id = ?1 AND type != 'event'),
         has_attachments = MAX(has_attachments, ?2), updated_at = MAX(updated_at, ?3),
         last_customer_at = NULLIF(MAX(COALESCE(last_customer_at, 0), ?4), 0), waiting_since = COALESCE(waiting_since, ?5),
         status = CASE WHEN ?6 = 'active' THEN 'active' ELSE status END
       WHERE id = ?1`,
      targetId,
      source.has_attachments,
      source.updated_at,
      source.last_customer_at ?? 0,
      source.waiting_since,
      source.status,
    )
    run('DELETE FROM conversations WHERE id = ?', sourceId)
    run('DELETE FROM search WHERE rowid = ?', sourceId)
    reindex(targetId)
  })
  touch(sourceId, source.mailbox_id, 'deleted', actor)
  touch(targetId, target.mailbox_id, 'updated', actor)
  return getSummary(targetId)
}

/** Retry a reply that failed to send. */
export function retryDelivery(threadId: number) {
  const t = get<any>(`SELECT id, conversation_id FROM threads WHERE id = ? AND type = 'reply' AND state = 'failed'`, threadId)
  if (!t) throw new AppError('That message is not waiting to be re-sent.')
  run(`UPDATE threads SET state = 'sending', error = NULL WHERE id = ?`, threadId)
  queueDelivery(threadId)
}

/** Wake conversations whose snooze time has passed. Runs on a timer. */
export function wakeSnoozed() {
  const due = all<{ id: number; mailbox_id: number }>('SELECT id, mailbox_id FROM conversations WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?', now())
  for (const conv of due) {
    tx(() => {
      run(`UPDATE conversations SET snoozed_until = NULL, status = 'active', updated_at = ? WHERE id = ?`, now(), conv.id)
      addEvent(conv.id, { userId: null, via: 'system' }, { kind: 'unsnoozed', auto: true })
    })
    touch(conv.id, conv.mailbox_id, 'updated', { userId: null, via: 'system' })
  }
}

export function saveDraft(conversationId: number, userId: number, kind: 'reply' | 'note', bodyHtml: string) {
  const clean = cleanHtml(bodyHtml)
  if (!htmlToText(clean).trim()) {
    run('DELETE FROM drafts WHERE conversation_id = ? AND user_id = ?', conversationId, userId)
    return
  }
  run(
    `INSERT INTO drafts (conversation_id, user_id, kind, body_html, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET kind = excluded.kind, body_html = excluded.body_html, updated_at = excluded.updated_at`,
    conversationId,
    userId,
    kind,
    clean,
    now(),
  )
}
