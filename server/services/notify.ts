import crypto from 'node:crypto'
import { get } from '../db.ts'
import { config } from '../config.ts'
import { escapeHtml, htmlToText, REPLY_MARKER } from '../mail/html.ts'
import { sendMail, wrapEmailHtml, type MailboxRow } from '../mail/outbound.ts'
import { sendSystemEmail } from '../mail/system.ts'
import { getConversation, type ThreadView } from './conversations.ts'
import { brandName, statusLabel } from './workspace.ts'

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MAX_ITEMS = 12
const STATUS_COLOR: Record<string, string> = { active: '#2f8a4c', waiting: '#4336c9', pending: '#b7791f', closed: '#6b7280', spam: '#b42318' }

const when = (ts: number) => {
  const d = new Date(ts)
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${month} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

function eventText(thread: ThreadView, viewerId: number): string {
  const e = thread.event ?? {}
  const who = thread.author.name
  switch (e.kind) {
    case 'status':
      return `${who} marked as ${statusLabel(String(e.to))}`
    case 'assigned':
      return e.to ? `${who} assigned to ${e.to === viewerId ? 'you' : e.toName}` : `${who} removed the assignee`
    case 'snoozed':
      return `${who} snoozed this until ${when(e.until)}`
    case 'unsnoozed':
      return e.auto ? 'Snooze ended' : `${who} ended the snooze`
    case 'moved':
      return `${who} moved this to ${e.toName}`
    case 'merged':
      return `${who} merged in #${e.fromId}`
    case 'customer':
      return `${who} changed the customer to ${e.toName}`
    default:
      return `${who} updated this conversation`
  }
}

// ---------------------------------------------------------------------------------------------
// Reply by email: the notification's Message-ID names the conversation and the teammate, signed
// with the install's secret. A reply carries it back in In-Reply-To, which proves it answers a
// notification this install sent to that teammate.
// ---------------------------------------------------------------------------------------------

const REF_MAX_AGE = 90 * 86_400_000
const refSignature = (conversationId: number, userId: number, stamp: string) =>
  crypto.createHmac('sha256', config.secret).update(`notification:${conversationId}:${userId}:${stamp}`).digest('hex').slice(0, 32)

export function notificationMessageId(conversationId: number, userId: number, mailboxEmail: string, at = Date.now()): string {
  const stamp = at.toString(36)
  const nonce = crypto.randomBytes(4).toString('hex')
  return `<ansa-n.${conversationId}.${userId}.${stamp}.${refSignature(conversationId, userId, stamp)}.${nonce}@${mailboxEmail.split('@')[1] || 'ansa.local'}>`
}

/** Read a Message-ID back. Returns null unless it is a notification id that this install signed, and not too old. */
export function parseNotificationRef(messageId: string): { conversationId: number; userId: number } | null {
  const match = /^<?ansa-n\.(\d+)\.(\d+)\.([0-9a-z]+)\.([0-9a-f]{32})\.[0-9a-f]+@/.exec(messageId.trim())
  if (!match) return null
  const [, conversation, user, stamp, signature] = match
  const expected = refSignature(Number(conversation), Number(user), stamp)
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  if (Date.now() - parseInt(stamp, 36) > REF_MAX_AGE) return null
  return { conversationId: Number(conversation), userId: Number(user) }
}

const NOTIFICATION_HEADERS = { 'X-Ansa-Kind': 'notification', 'X-Ansa-Notification': '1', 'Auto-Submitted': 'auto-generated' }

const canNotify = (mailbox: MailboxRow) => (mailbox.kind === 'managed' ? !!mailbox.inbound_address : !!mailbox.smtp_host)
const repliesComeBack = (mailbox: MailboxRow) => (mailbox.kind === 'managed' ? !!mailbox.inbound_address : !!mailbox.imap_enabled && !!mailbox.imap_host)

function sendToTeammate(mailbox: MailboxRow, mail: { to: string; subject: string; html: string; messageId?: string }) {
  const fromName = `${mailbox.name} (${brandName()})`
  const sending =
    mailbox.kind === 'managed'
      ? sendSystemEmail({
          kind: 'notification',
          to: mail.to,
          subject: mail.subject,
          html: mail.html,
          text: htmlToText(mail.html),
          headers: { ...NOTIFICATION_HEADERS, ...(mail.messageId ? { 'Message-ID': mail.messageId } : {}), 'Reply-To': `"${fromName.replace(/["\\\r\n]/g, '')}" <${mailbox.inbound_address}>` },
        })
      : sendMail(mailbox, { to: [mail.to], subject: mail.subject, html: mail.html, messageId: mail.messageId, fromName, headers: NOTIFICATION_HEADERS })
  sending.catch((err) => console.error('[notify] could not send:', (err as Error).message))
}

/** Tell a teammate that their emailed reply was not sent to the customer. */
export function notifyReplyRejected(mailbox: MailboxRow, to: string, conversationId: number, reason: string) {
  if (config.mailDisabled || !canNotify(mailbox)) return
  sendToTeammate(mailbox, {
    to,
    subject: `Your reply was not sent (conversation #${conversationId})`,
    html: wrapEmailHtml(`<p>${escapeHtml(reason)}</p><p>Nothing was sent to the customer. <a href="${config.appUrl}/c/${conversationId}">Open conversation #${conversationId}</a> to reply in ${escapeHtml(brandName())}.</p>`),
  })
}

/** Inline images point at this server and need a login, so they cannot show inside an email. */
const emailSafe = (html: string) => html.replace(/<img[^>]+src="\/api\/[^>]*>/g, '<span style="color:#8a8f98;">[image: open the conversation to see it]</span>')

export interface NotificationView {
  appUrl: string
  viewerId: number
  /** One line above the subject, already escaped HTML. Example: "<strong>Maya</strong> assigned you conversation". */
  leadHtml: string
  /** True when a reply to this email reaches the customer (the mailbox fetches incoming mail). */
  replyByEmail?: boolean
  conversation: Pick<ReturnType<typeof getConversation>, 'id' | 'subject' | 'status' | 'mailboxName' | 'assignee' | 'threads' | 'customer'>
}

/** The notification email: a card with the subject, status and the conversation so far, newest first. */
export function renderNotification(view: NotificationView): string {
  const c = view.conversation
  const url = `${view.appUrl}/c/${c.id}`
  const link = `<a href="${url}" style="color:#3b5bdb; text-decoration:none;">#${c.id}</a>`
  const assignee = c.assignee ? (c.assignee.id === view.viewerId ? 'Assigned to you' : `Assigned to ${escapeHtml(c.assignee.name)}`) : 'Unassigned'
  const shown = [...c.threads].reverse().slice(0, MAX_ITEMS)
  const hidden = c.threads.length - shown.length
  const cell = 'padding:0 26px;'
  const rule = 'border-top:1px solid #e3e5e8;'

  const items = shown
    .map((t) => {
      if (t.type === 'event') {
        return `<tr><td style="${rule} background:#f7f8f9; padding:10px 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font:13px ${FONT}; color:#8a8f98;">${escapeHtml(eventText(t, view.viewerId))}</td>
            <td align="right" style="font:12px ${FONT}; color:#8a8f98; white-space:nowrap;">${when(t.createdAt)}</td>
          </tr></table></td></tr>`
      }
      const note = t.type === 'note'
      const verb = note ? 'added a note' : t.type === 'customer' && t === c.threads[0] ? 'started the conversation' : 'replied'
      const files = t.attachments.filter((a) => !a.inline)
      return `<tr><td style="${rule} ${cell} padding-top:20px; padding-bottom:22px;${note ? ' background:#fffaeb;' : ''}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font:17px ${FONT}; color:#8a8f98;"><strong style="color:#14161a;">${escapeHtml(t.author.name)}</strong> ${verb}</td>
          <td align="right" valign="top" style="font:12px ${FONT}; color:#8a8f98; white-space:nowrap; padding-top:4px;">${when(t.createdAt)}</td>
        </tr></table>
        ${t.state === 'failed' || t.state === 'uncertain' ? `<div style="font:12px ${FONT}; color:#b42318; padding-top:4px;">${t.state === 'failed' ? 'Not sent' : 'Delivery uncertain'}: ${escapeHtml(t.error || 'delivery failed')}</div>` : ''}
        <div style="font:14px/1.55 ${FONT}; color:#1f2328; padding-top:14px; overflow-wrap:anywhere;">${emailSafe(t.bodyHtml)}</div>
        ${files.length ? `<div style="font:12px ${FONT}; color:#8a8f98; padding-top:12px;">Attachments: ${files.map((a) => escapeHtml(a.filename)).join(', ')}</div>` : ''}
      </td></tr>`
    })
    .join('')

  return `<div style="background:#f1f2f4; margin:0; padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:650px;">
      ${view.replyByEmail ? `<tr><td align="center" style="font:11px ${FONT}; color:#a3a8b0; padding:0 8px 14px;">${REPLY_MARKER}</td></tr>` : ''}
      <tr><td align="center" style="font:15px ${FONT}; color:#3d4148; padding:4px 8px 20px;">
        ${
          view.replyByEmail
            ? `Replying to this notification will email ${escapeHtml(c.customer.name || c.customer.email)} (<a href="mailto:${escapeHtml(c.customer.email)}" style="color:#3b5bdb; text-decoration:none;">${escapeHtml(c.customer.email)}</a>)`
            : `Reply to ${escapeHtml(c.customer.name || c.customer.email)} in ${escapeHtml(brandName())}: <a href="${url}" style="color:#3b5bdb;">open conversation #${c.id}</a>`
        }
      </td></tr>
      <tr><td style="background:#ffffff; border:1px solid #dcdfe3;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="${cell} padding-top:22px; padding-bottom:22px;">
            <div style="font:12px ${FONT}; color:#8a8f98;">${escapeHtml(c.mailboxName)}: ${view.leadHtml} ${link}.</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr>
              <td style="font:20px/1.3 ${FONT}; color:#14161a;">${escapeHtml(c.subject)}</td>
              <td align="right" valign="top" style="white-space:nowrap; padding-left:12px;">
                <span style="display:inline-block; background:${STATUS_COLOR[c.status] || '#6b7280'}; color:#ffffff; font:bold 11px ${FONT}; letter-spacing:0.3px; padding:4px 7px;">${escapeHtml(statusLabel(c.status).toUpperCase())}</span>
                <div style="font:12px ${FONT}; color:#8a8f98; padding-top:8px;">${assignee}</div>
              </td>
            </tr></table>
          </td></tr>
          ${items}
          ${hidden > 0 ? `<tr><td style="${rule} background:#f7f8f9; padding:12px 26px; font:13px ${FONT}; color:#8a8f98;">${hidden} earlier ${hidden === 1 ? 'item' : 'items'}. <a href="${url}" style="color:#3b5bdb;">See the whole conversation</a></td></tr>` : ''}
        </table>
      </td></tr>
      <tr><td align="center" style="font:12px ${FONT}; color:#8a8f98; padding:18px 8px 4px;">
        <a href="${view.appUrl}/settings/profile" style="color:#8a8f98;">Notification settings</a> · ${escapeHtml(c.mailboxName)} · ${escapeHtml(brandName())}
      </td></tr>
    </table>
  </td></tr></table>
</div>`
}

/** Emails to teammates. Failures are logged and never block the action that caused them. */
function send(conversationId: number, userId: number, flag: 'notify_assigned' | 'notify_replies' | 'notify_mentions', lead: (ctx: { customer: string }) => { text: string; html: string }) {
  if (config.mailDisabled) return
  const user = get<any>(`SELECT name, email, ${flag} AS wants FROM users WHERE id = ? AND disabled = 0`, userId)
  if (!user?.wants) return
  let conversation: ReturnType<typeof getConversation>
  try {
    conversation = getConversation(conversationId)
  } catch {
    return
  }
  const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', conversation.mailboxId)
  if (!mailbox || !canNotify(mailbox) || user.email.toLowerCase() === mailbox.email.toLowerCase()) return
  const { html: leadHtml } = lead({ customer: conversation.customer.name || conversation.customer.email })
  sendToTeammate(mailbox, {
    to: user.email,
    // The same subject for every notification of a conversation, so mail clients group them.
    subject: `[${mailbox.name} #${conversation.id}] ${conversation.subject}`,
    html: renderNotification({ appUrl: config.appUrl, viewerId: userId, leadHtml, conversation, replyByEmail: repliesComeBack(mailbox) }),
    messageId: notificationMessageId(conversation.id, userId, mailbox.email),
  })
}

const strong = (text: string) => `<strong style="color:#5c6168;">${escapeHtml(text)}</strong>`

export function notifyAssigned(conversationId: number, userId: number, byUserId: number | null) {
  const by = (byUserId ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', byUserId)?.name : null) || 'A workflow'
  send(conversationId, userId, 'notify_assigned', () => ({ text: `${by} assigned you conversation`, html: `${strong(by)} assigned you conversation` }))
}

export function notifyCustomerReply(conversationId: number) {
  const conv = get<{ assignee_id: number | null }>('SELECT assignee_id FROM conversations WHERE id = ?', conversationId)
  if (conv?.assignee_id) send(conversationId, conv.assignee_id, 'notify_replies', ({ customer }) => ({ text: `${customer} replied to conversation`, html: `${strong(customer)} replied to conversation` }))
}

export function notifyMentioned(conversationId: number, userId: number, byUserId: number | null) {
  const by = (byUserId ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', byUserId)?.name : null) || 'Someone'
  send(conversationId, userId, 'notify_mentions', () => ({ text: `${by} mentioned you in conversation`, html: `${strong(by)} mentioned you in conversation` }))
}
