import nodemailer from 'nodemailer'
import crypto from 'node:crypto'
import tls from 'node:tls'
import { blobs } from '../blobs.ts'
import { all, get, run, parseJson } from '../db.ts'
import { config } from '../config.ts'
import { decrypt } from '../crypto.ts'
import { publish } from '../events.ts'
import { bindTenant } from '../tenant.ts'
import { escapeHtml, htmlToText } from './html.ts'

export interface SmtpSettings {
  host: string
  port: number
  security: 'starttls' | 'ssl' | 'none'
  user: string
  pass: string
}

export interface MailboxRow {
  id: number
  name: string
  email: string
  from_name: string
  color: string
  signature: string
  smtp_host: string
  smtp_port: number
  smtp_security: 'starttls' | 'ssl' | 'none'
  smtp_user: string
  smtp_pass_enc: string
  imap_enabled: number
  imap_host: string
  imap_port: number
  imap_security: 'ssl' | 'starttls' | 'none'
  imap_user: string
  imap_pass_enc: string
  imap_folder: string
  imap_uidvalidity: string | null
  imap_last_uid: number | null
  import_existing: number
  sync_status: string
  sync_error: string | null
  last_sync_at: number | null
  auto_reply_enabled: number
  auto_reply_subject: string
  auto_reply_body: string
  created_at: number
}

export function smtpOf(mailbox: MailboxRow): SmtpSettings {
  return {
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    security: mailbox.smtp_security,
    user: mailbox.smtp_user,
    pass: decrypt(mailbox.smtp_pass_enc),
  }
}

function transportFor(smtp: SmtpSettings) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === 'ssl',
    requireTLS: smtp.security === 'starttls',
    ignoreTLS: smtp.security === 'none',
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    ...(config.imapPollOnly && smtp.security === 'ssl' ? { getSocket: bindTenant(openTlsSocket(smtp)) } : {}),
  } as Parameters<typeof nodemailer.createTransport>[0])
}

/**
 * On Cloudflare, nodemailer's own TLS connection fails because it connects to a resolved IP address.
 * Open the TLS socket by host name and hand it over. STARTTLS and plain connections do not need this.
 */
function openTlsSocket(smtp: SmtpSettings) {
  return (_options: unknown, callback: (err: Error | null, socket?: { connection: tls.TLSSocket; secured: boolean }) => void) => {
    let settled = false
    const socket = tls.connect({ host: smtp.host, port: smtp.port, servername: smtp.host })
    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        socket.destroy()
        callback(Object.assign(err, { code: (err as { code?: string }).code || 'ECONNECTION' }))
      } else callback(null, { connection: socket, secured: true })
    }
    const timer = setTimeout(() => finish(new Error('Connection timeout')), 20_000)
    socket.once('secureConnect', () => finish(null))
    socket.once('error', finish)
  }
}

/** Turn low-level SMTP errors into something a person can act on. */
/** The server's own words help tell a wrong password from a blocked address. */
const serverSaid = (response?: string) => {
  const line = (response || '').split(/\r?\n/)[0].trim().slice(0, 160)
  return line ? ` It said: "${line}".` : ''
}

export function explainMailError(err: unknown): string {
  const raw = err as { code?: string; responseCode?: number; response?: unknown; responseText?: string; message?: string; authenticationFailed?: boolean }
  // SMTP errors carry the reply as a string. IMAP errors carry a parsed object and put the text in responseText.
  const e = { ...raw, message: raw.message, response: typeof raw.response === 'string' ? raw.response : typeof raw.responseText === 'string' ? raw.responseText : '' }
  const text = `${e.response || ''} ${e.message || ''}`
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Invalid login|authentication failed/i.test(text)) {
    return /gmail|google/i.test(text)
      ? 'Google rejected the sign-in. Use an app password (Google Account → Security → 2-Step Verification → App passwords), not your normal password.'
      : `The server rejected the username or password.${serverSaid(e.response)}`
  }
  if (e.code === 'ENOTFOUND' || e.code === 'EDNS') return 'Could not find that server. Check the host name.'
  if (e.code === 'ECONNREFUSED') return 'The server refused the connection. Check the port.'
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ESOCKET') return `Could not connect: ${e.message || 'timed out'}. Check the host, port and security setting.`
  return (e.response || e.message || 'Unknown mail error').slice(0, 400)
}

export async function testSmtp(smtp: SmtpSettings): Promise<void> {
  if (!smtp.host) throw new Error('Enter the SMTP host.')
  const transport = transportFor(smtp)
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
export const wrapEmailHtml = (inner: string) =>
  `<div style="font-family: ${FONT}; font-size: 14px; line-height: 1.55; color: #1f2328;">${inner}</div>`

export function newMessageId(mailboxEmail: string): string {
  const domain = mailboxEmail.split('@')[1] || 'ansa.local'
  return `<${crypto.randomBytes(12).toString('hex')}.${Date.now().toString(36)}@${domain}>`
}

export interface OutgoingMail {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  html: string
  text?: string
  messageId?: string
  inReplyTo?: string | null
  references?: string[]
  attachments?: { filename: string; content: Buffer; contentType: string; cid?: string }[]
  headers?: Record<string, string>
  fromName?: string
}

export async function sendMail(mailbox: MailboxRow, mail: OutgoingMail): Promise<void> {
  if (config.mailDisabled) return
  if (!mailbox.smtp_host) throw new Error('This mailbox has no SMTP server. Add one in Settings → Mailboxes.')
  const transport = transportFor(smtpOf(mailbox))
  try {
    await transport.sendMail({
      from: { name: mail.fromName || mailbox.from_name || mailbox.name, address: mailbox.email },
      to: mail.to,
      cc: mail.cc?.length ? mail.cc : undefined,
      bcc: mail.bcc?.length ? mail.bcc : undefined,
      subject: mail.subject,
      html: mail.html,
      text: mail.text ?? htmlToText(mail.html),
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo || undefined,
      references: mail.references?.length ? mail.references : undefined,
      attachments: mail.attachments,
      headers: mail.headers,
    })
  } finally {
    transport.close()
  }
}

const reSubject = (subject: string) => (/^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`)

/** Deliver an agent reply. Marks the thread sent or failed and tells open browsers. */
export async function deliverThread(threadId: number): Promise<void> {
  const thread = get<any>('SELECT * FROM threads WHERE id = ?', threadId)
  if (!thread || thread.type !== 'reply') return
  const conversation = get<any>('SELECT * FROM conversations WHERE id = ?', thread.conversation_id)
  const mailbox = conversation && get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', conversation.mailbox_id)
  if (!conversation || !mailbox) return
  const finish = (state: 'sent' | 'failed', error: string | null) => {
    run('UPDATE threads SET state = ?, error = ? WHERE id = ?', state, error, threadId)
    publish({ type: 'conversation', id: conversation.id, mailboxId: mailbox.id, reason: state === 'sent' ? 'sent' : 'send_failed' })
  }
  try {
    const author = thread.user_id ? get<{ name: string; signature: string }>('SELECT name, signature FROM users WHERE id = ?', thread.user_id) : undefined
    const signature = thread.via === 'auto' ? '' : author?.signature?.trim() || mailbox.signature?.trim() || ''
    const previous = get<any>(
      `SELECT t.*, c.name AS customer_name, c.email AS customer_email FROM threads t LEFT JOIN customers c ON c.id = t.customer_id
       WHERE t.conversation_id = ? AND t.type = 'customer' AND t.id < ? ORDER BY t.id DESC LIMIT 1`,
      conversation.id,
      threadId,
    )
    const isFirst = !get('SELECT 1 FROM threads WHERE conversation_id = ? AND type IN (\'customer\', \'reply\') AND id < ? LIMIT 1', conversation.id, threadId)

    let html = thread.body_html as string
    if (signature) html += `<br><div style="color: #57606a;">${signature}</div>`
    if (previous) {
      // Inline images point at this server and need a login, so they cannot travel in the quote.
      const quoted = String(previous.body_html).replace(/<img[^>]+src="\/api\/[^>]*>/g, '')
      const when = new Date(previous.created_at).toUTCString().replace(/:\d\d GMT$/, ' UTC')
      const who = escapeHtml(previous.customer_name ? `${previous.customer_name} <${previous.customer_email}>` : previous.from_addr || '')
      html += `<br><div class="gmail_quote"><div style="color: #57606a;">On ${when}, ${who} wrote:</div><blockquote class="gmail_quote" style="margin: 8px 0 0; padding-left: 12px; border-left: 2px solid #d0d7de; color: #57606a;">${quoted}</blockquote></div>`
    }

    const attachments = all<any>('SELECT * FROM attachments WHERE thread_id = ?', threadId).flatMap((a) => {
      const content = blobs.get(a.storage_key)
      return content ? [{ filename: a.filename as string, content: Buffer.from(content), contentType: a.mime as string }] : []
    })

    await sendMail(mailbox, {
      to: parseJson<string[]>(thread.to_addrs, []),
      cc: parseJson<string[]>(thread.cc, []),
      bcc: parseJson<string[]>(thread.bcc, []),
      subject: isFirst ? conversation.subject || '(no subject)' : reSubject(conversation.subject || '(no subject)'),
      html: wrapEmailHtml(html),
      messageId: thread.message_id,
      inReplyTo: thread.in_reply_to,
      references: thread.refs ? String(thread.refs).split(/\s+/).filter(Boolean) : [],
      attachments,
      headers: { 'X-Ansa-Conversation': String(conversation.id) },
    })
    finish('sent', null)
  } catch (err) {
    console.error(`[mail] sending thread ${threadId} failed:`, (err as Error).message)
    finish('failed', explainMailError(err))
  }
}

export function queueDelivery(threadId: number) {
  setImmediate(() => void deliverThread(threadId))
}
