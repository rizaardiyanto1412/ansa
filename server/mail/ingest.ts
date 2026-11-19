import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import { get, run, getSetting, setSetting } from '../db.ts'
import { cleanHtml, fillTemplate, htmlToText, replyAboveMarker, replyAboveMarkerText, stripHelpdeskNotification, stripQuotedHtml, stripQuotedText, textToHtml } from './html.ts'
import type { MailboxRow } from './outbound.ts'
import { addCustomerMessage, addReply, createConversation } from '../services/conversations.ts'
import { findOrCreateCustomer, isEmail, normEmail } from '../services/customers.ts'
import { storeAttachment } from '../services/attachments.ts'
import { runWorkflows } from '../services/workflows.ts'
import { notifyReplyRejected, parseNotificationRef } from '../services/notify.ts'
import { brandName } from '../services/workspace.ts'
import { currentTenant } from '../tenant.ts'

export interface IngestResult {
  conversationId: number
  threadId: number
  created: boolean
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

/** Turn a teammate's emailed answer to a notification into a reply to the customer. */
async function teammateReply(mailbox: MailboxRow, mail: ParsedMail, ref: { conversationId: number; userId: number }, historical: boolean): Promise<IngestResult | null> {
  // Never act on old mail or on robots: an out-of-office answer must not reach the customer.
  if (historical || isAutomated(mail)) return null
  const seen = getSetting<string[]>(SEEN_KEY, [])
  const messageId = mail.messageId || ''
  if (messageId && seen.includes(messageId)) return null
  if (messageId) setSetting(SEEN_KEY, [...seen, messageId].slice(-300))

  const user = get<{ id: number; email: string }>('SELECT id, email FROM users WHERE id = ? AND disabled = 0', ref.userId)
  if (!user || !get('SELECT 1 FROM conversations WHERE id = ?', ref.conversationId)) return null
  const from = normEmail(mail.from?.value[0]?.address || '')
  if (from !== user.email.toLowerCase()) {
    notifyReplyRejected(mailbox, user.email, ref.conversationId, `A reply to your notification came from ${from || 'an unknown address'}. ${brandName()} only accepts replies from ${user.email}, the address on your profile.`)
    return null
  }

  const bodyHtml = mail.html ? replyAboveMarker(mail.html) : textToHtml(replyAboveMarkerText(mail.text || ''))
  const attachmentIds: number[] = []
  for (const part of mail.attachments) {
    if (part.cid && (part.related || part.contentDisposition === 'inline')) continue
    const stored = await storeAttachment(part.content, { filename: part.filename || 'attachment', mime: part.contentType, uploadedBy: user.id })
    attachmentIds.push(stored.id)
  }
  if (!htmlToText(bodyHtml).trim() && attachmentIds.length === 0) {
    notifyReplyRejected(mailbox, user.email, ref.conversationId, 'Your reply was empty. Write your answer above the quoted notification.')
    return null
  }
  try {
    const threadId = addReply(ref.conversationId, { bodyHtml, status: 'pending', attachmentIds }, { userId: user.id, via: 'email' })
    return { conversationId: ref.conversationId, threadId, created: false }
  } catch (err) {
    notifyReplyRejected(mailbox, user.email, ref.conversationId, `${brandName()} could not send your reply: ${(err as Error).message}`)
    return null
  }
}

/** Parse one raw RFC 822 message and file it under the right conversation. Returns null when the message is skipped. */
export async function ingestRaw(mailboxId: number, source: Buffer | string, opts: { historical?: boolean } = {}): Promise<IngestResult | null> {
  const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', mailboxId)
  if (!mailbox) return null
  // Keep cid: links so inline images are stored as files, not as data URIs inside the message.
  const mail = await simpleParser(source, { skipImageLinks: true })
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
  if (messageId && get('SELECT 1 FROM threads WHERE message_id = ?', messageId)) {
    return null // already imported
  }

  const references = (Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : []).filter(Boolean)
  const candidates = [mail.inReplyTo, ...[...references].reverse()].filter((id): id is string => !!id)
  let conversationId: number | null = null
  for (const id of candidates) {
    // Any mailbox: a conversation that was moved must still collect its follow-ups.
    const hit = get<{ conversation_id: number }>('SELECT conversation_id FROM threads WHERE message_id = ? LIMIT 1', id)
    if (hit) {
      conversationId = hit.conversation_id
      break
    }
  }
  // A teammate answered a notification email: send their words to the customer as a reply.
  for (const id of candidates) {
    const ref = parseNotificationRef(id)
    if (ref) return teammateReply(mailbox, mail, ref, !!opts.historical)
  }
  const created = conversationId === null

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
  const to = addresses(mail.to)
  const cc = addresses(mail.cc).filter((a) => a !== mailbox.email.toLowerCase())
  // The Date header is the sender's claim. Trust it only while importing old mail; live mail is stamped on arrival.
  const sentAt = mail.date?.getTime()
  const historical = !!opts.historical && !!sentAt && sentAt < Date.now() - 10 * 60_000 && sentAt > Date.UTC(2000, 0, 1)
  const createdAt = historical ? sentAt : undefined
  const subject = (mail.subject || '').trim()
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

  let threadId: number
  const spam = /^yes/i.test(String(mail.headers.get('x-spam-flag') ?? ''))
  if (created) {
    const result = createConversation(
      { mailboxId, customerEmail: from, customerName: sender.name, subject, bodyHtml, kind: 'customer', cc, createdAt, status: spam ? 'spam' : 'active', source: 'email', email },
      { userId: null, via: 'email' },
    )
    conversationId = result.id
    threadId = result.threadId
  } else {
    threadId = addCustomerMessage(conversationId!, { customerId: customer.id, bodyHtml, cc, createdAt, via: 'email', ...email })
  }

  // Attachments. Inline images are rewritten from cid: links to our own URLs.
  let hasFiles = false
  for (const part of mail.attachments) {
    const inline = !!part.cid && (part.related || part.contentDisposition === 'inline') && /^image\//.test(part.contentType)
    const stored = await storeAttachment(part.content, {
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
  }
  if (mail.attachments.length) {
    run('UPDATE threads SET body_html = ?, body_full_html = ? WHERE id = ?', bodyHtml, bodyFullHtml, threadId)
    if (hasFiles) run('UPDATE conversations SET has_attachments = 1 WHERE id = ?', conversationId)
  }

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
        addReply(conversationId!, { bodyHtml: /<\w+[^>]*>/.test(body) ? body : textToHtml(body) }, { userId: null, via: 'auto' })
      } catch (err) {
        console.error('[ingest] auto reply failed:', (err as Error).message)
      }
    }
  }

  runWorkflows(conversationId!, mailboxId, created ? 'new' : 'customer_reply', {
    subject,
    body: email.bodyText,
    from,
    to: to.join(', '),
    customer_name: customer.name,
  })

  return { conversationId: conversationId!, threadId, created }
}
