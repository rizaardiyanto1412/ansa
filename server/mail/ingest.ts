import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser'
import { blobs } from '../blobs.ts'
import { get, run, tx, getSetting, setSetting } from '../db.ts'
import { cleanHtml, fillTemplate, htmlToText, replyAboveMarker, replyAboveMarkerText, stripHelpdeskNotification, stripQuotedHtml, stripQuotedText, textToHtml } from './html.ts'
import type { MailboxRow } from './outbound.ts'
import { addCustomerMessage, addReply, createConversation } from '../services/conversations.ts'
import { findOrCreateCustomer, isEmail, normEmail } from '../services/customers.ts'
import { attachmentKey, recordAttachment } from '../services/attachments.ts'
import { runWorkflows } from '../services/workflows.ts'
import { notifyReplyRejected, parseNotificationRef } from '../services/notify.ts'
import { brandName } from '../services/workspace.ts'
import { currentTenant } from '../tenant.ts'

export interface IngestResult {
  conversationId: number
  threadId: number
  created: boolean
}

export interface IngestOptions {
  historical?: boolean
  delivery?: { fileKey: (index: number) => string; claim: () => boolean }
}

const addresses = (field: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(field) ? field : field ? [field] : [])
    .flatMap((group) => group.value)
    .map((a) => a.address || '')
    .filter(isEmail)
    .map(normEmail)

function isAutomated(mail: ParsedMail): boolean {
  const h = (name: string) => String(mail.headers.get(name) ?? '').toLowerCase()
  if (h('auto-submitted') && !h('auto-submitted').startsWith('no')) return true
  if (/bulk|junk|list|auto_reply/.test(h('precedence'))) return true
  if (mail.headers.has('x-autoreply') || mail.headers.has('x-autorespond') || mail.headers.has('list-unsubscribe')) return true
  const from = mail.from?.value[0]?.address?.toLowerCase() || ''
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)@/.test(from)
}

const SEEN_KEY = 'notification_replies_seen'

interface StoredFiles {
  keys: string[]
  discard: () => Promise<void>
}

async function storeFiles(parts: Attachment[], delivery: IngestOptions['delivery']): Promise<StoredFiles> {
  const keys: string[] = []
  // A delivery's files stay: its next try writes the same names, and a parallel try may already point at them.
  const discard = async () => {
    if (delivery || keys.length === 0) return
    await blobs.remove(keys).catch((err) => console.error('[ingest] could not remove unused files:', (err as Error).message))
  }
  try {
    for (const [index, part] of parts.entries()) {
      const key = delivery ? delivery.fileKey(index) : attachmentKey()
      await blobs.put(key, part.content)
      keys.push(key)
    }
  } catch (err) {
    await discard()
    throw err
  }
  return { keys, discard }
}

/** Turn a teammate's emailed answer to a notification into a reply to the customer. */
async function teammateReply(mailbox: MailboxRow, mail: ParsedMail, ref: { conversationId: number; userId: number }, opts: IngestOptions): Promise<IngestResult | null> {
  // Never act on old mail or on robots: an out-of-office answer must not reach the customer.
  if (opts.historical || isAutomated(mail)) return null
  const messageId = mail.messageId || ''
  const seen = () => !!messageId && getSetting<string[]>(SEEN_KEY, []).includes(messageId)
  const markSeen = () => {
    if (messageId && !seen()) setSetting(SEEN_KEY, [...getSetting<string[]>(SEEN_KEY, []), messageId].slice(-300))
  }
  if (seen()) return null

  const user = get<{ id: number; email: string }>('SELECT id, email FROM users WHERE id = ? AND disabled = 0', ref.userId)
  if (!user || !get('SELECT 1 FROM conversations WHERE id = ?', ref.conversationId)) {
    markSeen()
    return null
  }
  const reject = (reason: string) => {
    markSeen()
    notifyReplyRejected(mailbox, user.email, ref.conversationId, reason)
    return null
  }
  const from = normEmail(mail.from?.value[0]?.address || '')
  if (from !== user.email.toLowerCase()) {
    return reject(`A reply to your notification came from ${from || 'an unknown address'}. ${brandName()} only accepts replies from ${user.email}, the address on your profile.`)
  }

  const bodyHtml = mail.html ? replyAboveMarker(mail.html) : textToHtml(replyAboveMarkerText(mail.text || ''))
  const parts = mail.attachments.filter((part) => !(part.cid && (part.related || part.contentDisposition === 'inline')))
  if (!htmlToText(bodyHtml).trim() && parts.length === 0) return reject('Your reply was empty. Write your answer above the quoted notification.')

  const files = await storeFiles(parts, opts.delivery)
  let threadId: number | null
  try {
    threadId = tx(() => {
      if (seen() || (opts.delivery && !opts.delivery.claim())) return null
      markSeen()
      const attachmentIds = parts.map((part, index) => recordAttachment(files.keys[index], part.content.byteLength, { filename: part.filename || 'attachment', mime: part.contentType, uploadedBy: user.id }).id)
      return addReply(ref.conversationId, { bodyHtml, status: 'pending', attachmentIds }, { userId: user.id, via: 'email' })
    })
  } catch (err) {
    await files.discard()
    if (opts.delivery) throw err
    return reject(`${brandName()} could not send your reply: ${(err as Error).message}`)
  }
  if (threadId === null) {
    await files.discard()
    return null
  }
  return { conversationId: ref.conversationId, threadId, created: false }
}

/** Parse one raw RFC 822 message and file it under the right conversation. Returns null when the message is skipped. */
export async function ingestRaw(mailboxId: number, source: Buffer | string, opts: IngestOptions = {}): Promise<IngestResult | null> {
  const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', mailboxId)
  if (!mailbox) return null
  return ingestParsed(mailbox, await parseRaw(source), opts)
}

// Keep cid: links so inline images are stored as files, not as data URIs inside the message.
export const parseRaw = (source: Buffer | string) => simpleParser(source, { skipImageLinks: true })

export async function ingestParsed(mailbox: MailboxRow, mail: ParsedMail, opts: IngestOptions = {}): Promise<IngestResult | null> {
  const mailboxId = mailbox.id
  // Contact forms send from their own address and put the person in Reply-To, so prefer that.
  const fromHeader = mail.from?.value[0]
  const replyTo = mail.replyTo?.value[0]
  const useReplyTo = !!replyTo?.address && isEmail(replyTo.address) && normEmail(replyTo.address) !== mailbox.email.toLowerCase()
  const sender = useReplyTo ? { address: replyTo!.address, name: replyTo!.name || fromHeader?.name || '' } : fromHeader
  if (!sender?.address || !isEmail(sender.address)) return null
  const from = normEmail(sender.address)
  if (from === mailbox.email.toLowerCase()) return null // our own outgoing mail
  if (mail.headers.has('x-ansa-notification')) return null

  const messageId = mail.messageId || null
  const alreadyFiled = () => !!messageId && !!get('SELECT 1 FROM threads WHERE message_id = ?', messageId)
  if (alreadyFiled()) return null

  const references = (Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : []).filter(Boolean)
  const candidates = [mail.inReplyTo, ...[...references].reverse()].filter((id): id is string => !!id)
  // A teammate answered a notification email: send their words to the customer as a reply.
  for (const id of candidates) {
    const ref = parseNotificationRef(id)
    if (ref) return teammateReply(mailbox, mail, ref, opts)
  }

  const subject = (mail.subject || '').trim()
  const spam = /^yes/i.test(String(mail.headers.get('x-spam-flag') ?? ''))
  // The Date header is the sender's claim. Trust it only while importing old mail; live mail is stamped on arrival.
  const sentAt = mail.date?.getTime()
  const historical = !!opts.historical && !!sentAt && sentAt < Date.now() - 10 * 60_000 && sentAt > Date.UTC(2000, 0, 1)
  const to = addresses(mail.to)

  const files = await storeFiles(mail.attachments, opts.delivery)
  const file = () => {
    if (alreadyFiled() || (opts.delivery && !opts.delivery.claim())) return null

    // Any mailbox: a conversation that was moved must still collect its follow-ups.
    let existing: { conversation_id: number } | undefined
    for (const id of candidates) {
      existing = get<{ conversation_id: number }>('SELECT conversation_id FROM threads WHERE message_id = ? LIMIT 1', id)
      if (existing) break
    }
    const created = !existing

    let full: string
    let stripped: string | null = null
    if (mail.html) {
      full = cleanHtml(mail.html)
      stripped = stripHelpdeskNotification(mail.html) ?? (created ? null : stripQuotedHtml(mail.html))
    } else {
      const text = mail.text || ''
      full = textToHtml(text)
      const head = created ? null : stripQuotedText(text)
      if (head) stripped = textToHtml(head)
    }
    if (!htmlToText(full).trim() && mail.attachments.length === 0) full = '<p>(empty message)</p>'
    let bodyHtml = stripped ?? full
    let bodyFullHtml = stripped ? full : null

    const customer = findOrCreateCustomer(from, sender.name)
    const cc = addresses(mail.cc).filter((a) => a !== mailbox.email.toLowerCase())
    const createdAt = historical ? sentAt : undefined
    const email = {
      bodyFullHtml,
      bodyText: htmlToText(bodyHtml),
      from,
      to,
      messageId,
      inReplyTo: mail.inReplyTo || null,
      refs: references.join(' ') || null,
      historical,
    }

    let conversationId: number
    let threadId: number
    if (existing) {
      conversationId = existing.conversation_id
      threadId = addCustomerMessage(conversationId, { customerId: customer.id, bodyHtml, cc, createdAt, via: 'email', ...email })
    } else {
      const result = createConversation(
        { mailboxId, customerEmail: from, customerName: sender.name, subject, bodyHtml, kind: 'customer', cc, createdAt, status: spam ? 'spam' : 'active', source: 'email', email },
        { userId: null, via: 'email' },
      )
      conversationId = result.id
      threadId = result.threadId
    }

    let hasFiles = false
    mail.attachments.forEach((part, index) => {
      const inline = !!part.cid && (part.related || part.contentDisposition === 'inline') && /^image\//.test(part.contentType)
      const stored = recordAttachment(files.keys[index], part.content.byteLength, {
        filename: part.filename || (inline ? 'image' : 'attachment'),
        mime: part.contentType,
        threadId,
        contentId: part.cid || null,
        inline,
      })
      if (inline && part.cid) {
        // Match the whole reference so "cid:img1" does not also rewrite "cid:img10".
        const ref = new RegExp(`cid:${part.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["'\\s>])`, 'g')
        if (ref.test(bodyHtml) || (bodyFullHtml && ref.test(bodyFullHtml))) {
          bodyHtml = bodyHtml.replace(ref, stored.url)
          bodyFullHtml = bodyFullHtml ? bodyFullHtml.replace(ref, stored.url) : null
        } else {
          run('UPDATE attachments SET inline = 0 WHERE id = ?', stored.id)
          hasFiles = true
        }
      } else hasFiles = true
    })
    if (mail.attachments.length) {
      run('UPDATE threads SET body_html = ?, body_full_html = ? WHERE id = ?', bodyHtml, bodyFullHtml, threadId)
      if (hasFiles) run('UPDATE conversations SET has_attachments = 1 WHERE id = ?', conversationId)
    }
    return { conversationId, threadId, created, customer, bodyText: email.bodyText }
  }

  let filed: ReturnType<typeof file>
  try {
    filed = tx(file)
  } catch (err) {
    await files.discard()
    throw err
  }
  if (!filed) {
    await files.discard()
    return null
  }
  const { conversationId, threadId, created, customer } = filed

  const automated = isAutomated(mail)
  if (created && !automated && !historical && !opts.historical && !spam && mailbox.auto_reply_enabled && mailbox.auto_reply_body.trim()) {
    const { autoReplyLog } = currentTenant()
    for (const [address, at] of autoReplyLog) if (Date.now() - at > 10 * 60_000) autoReplyLog.delete(address)
    const last = autoReplyLog.get(from) ?? 0
    if (Date.now() - last > 10 * 60_000) {
      autoReplyLog.set(from, Date.now())
      const firstName = (customer.name || '').split(' ')[0] || 'there'
      const body = fillTemplate(mailbox.auto_reply_body, { 'customer.firstName': firstName, 'customer.name': customer.name, 'mailbox.name': mailbox.name, 'conversation.id': String(conversationId) })
      try {
        addReply(conversationId, { bodyHtml: /<\w+[^>]*>/.test(body) ? body : textToHtml(body) }, { userId: null, via: 'auto' })
      } catch (err) {
        console.error('[ingest] auto reply failed:', (err as Error).message)
      }
    }
  }

  runWorkflows(conversationId, mailboxId, created ? 'new' : 'customer_reply', {
    subject,
    body: filed.bodyText,
    from,
    to: to.join(', '),
    customer_name: customer.name,
  })

  return { conversationId, threadId, created }
}
