import crypto from 'node:crypto'
import type { ParsedMail } from 'mailparser'
import { z } from 'zod'
import { all, get, run, now, parseJson } from '../db.ts'
import { publish } from '../events.ts'
import { BillingLinksSchema, controlPlane, DnsRecordSchema, DomainResultSchema, parseRpc, rpcError, type BillingLinks, type DnsRecord, type DomainResult, type PlanState } from '../hosted.ts'
import { ingestParsed, parseRaw } from '../mail/ingest.ts'
import { domainOf, type MailboxRow } from '../mail/outbound.ts'
import { currentTenant } from '../tenant.ts'
import { isEmail, normEmail } from './customers.ts'

const mailboxIdSchema = z.number().int().positive()

function managedMailbox(mailboxId: number): MailboxRow {
  const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', mailboxId)
  if (!mailbox) throw rpcError('NotFound', 'That mailbox does not exist.')
  if (mailbox.kind !== 'managed') throw rpcError('Invalid', 'That mailbox uses its own mail server.')
  return mailbox
}

export async function assignInboundAddress(mailboxId: number): Promise<void> {
  const { control, workspaceId } = controlPlane()
  const { address } = await control.createInboundAddress(workspaceId, mailboxId)
  if (!isEmail(address)) throw new Error('The control plane returned an inbound address that is not an email address.')
  run('UPDATE mailboxes SET inbound_address = ? WHERE id = ?', normEmail(address), mailboxId)
}

export async function releaseInboundAddress(mailboxId: number): Promise<void> {
  const { control, workspaceId } = controlPlane()
  await control.deleteInboundAddress(workspaceId, mailboxId)
}

export interface ForwardingConfirmation {
  code: string | null
  link: string | null
  at: number
}

const GMAIL_FORWARDING_SENDER = 'forwarding-noreply@google.com'

// Gmail puts the code in the subject and the link in the body, in every language.
export function gmailForwardingConfirmation(mail: Pick<ParsedMail, 'from' | 'subject' | 'text'>): ForwardingConfirmation | null {
  if (mail.from?.value[0]?.address?.toLowerCase() !== GMAIL_FORWARDING_SENDER) return null
  const text = mail.text ?? ''
  const code = /\(#\s*(\d{4,12})\s*\)/.exec(mail.subject ?? '')?.[1] ?? /confirmation code:?\s*(\d{4,12})/i.exec(text)?.[1] ?? null
  const link = /https:\/\/(?:mail-settings|mail)\.google\.com\/mail\/[^\s<>"']+/.exec(text)?.[0] ?? null
  return code || link ? { code, link, at: now() } : null
}

const SEEN_FOR = 60 * 86_400_000

export async function ingestInbound(mailboxId: number, raw: Uint8Array): Promise<'accepted' | 'duplicate'> {
  const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', parseRpc(mailboxIdSchema, mailboxId))
  if (!mailbox) throw rpcError('NotFound', 'That mailbox does not exist.')
  const source = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const mail = await parseRaw(source)
  const key = mail.messageId ? `id:${mail.messageId}` : `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`
  if (get('SELECT 1 FROM inbound_seen WHERE key = ?', key)) return 'duplicate'
  if (mail.messageId && get('SELECT 1 FROM threads WHERE message_id = ?', mail.messageId)) return 'duplicate'
  // Claimed before filing, so a second delivery that arrives meanwhile is turned away.
  run('INSERT INTO inbound_seen (key, created_at) VALUES (?, ?)', key, now())
  try {
    await ingestParsed(mailbox, mail)
  } catch (err) {
    run('DELETE FROM inbound_seen WHERE key = ?', key)
    throw err
  }
  run('DELETE FROM inbound_seen WHERE created_at < ?', now() - SEEN_FOR)
  const confirmation = gmailForwardingConfirmation(mail)
  if (confirmation) run('UPDATE mailboxes SET forwarding_confirmation = ? WHERE id = ?', JSON.stringify(confirmation), mailbox.id)
  else if (!mailbox.first_inbound_at) run('UPDATE mailboxes SET first_inbound_at = ? WHERE id = ?', now(), mailbox.id)
  if (confirmation || !mailbox.first_inbound_at) publish({ type: 'mailbox', id: mailbox.id })
  return 'accepted'
}

function saveSendingDomain(mailbox: MailboxRow, domain: string, result: DomainResult) {
  const since = mailbox.sending_domain === domain && mailbox.sending_since ? mailbox.sending_since : now()
  run(
    'UPDATE mailboxes SET sending_domain = ?, sending_status = ?, sending_records = ?, sending_since = ?, sending_checked_at = ? WHERE id = ?',
    domain,
    result.status,
    JSON.stringify(result.records),
    since,
    now(),
    mailbox.id,
  )
  publish({ type: 'mailbox', id: mailbox.id })
  currentTenant().deadlineChanged()
}

export async function addSendingDomain(mailboxId: number): Promise<void> {
  const mailbox = managedMailbox(mailboxId)
  const { control, workspaceId } = controlPlane()
  const domain = domainOf(mailbox.email)
  saveSendingDomain(mailbox, domain, parseRpc(DomainResultSchema, await control.addSendingDomain(workspaceId, mailboxId, domain)))
}

export async function checkSendingDomain(mailboxId: number): Promise<void> {
  const mailbox = managedMailbox(mailboxId)
  if (!mailbox.sending_domain) throw rpcError('Invalid', 'Add the sending domain first.')
  const { control, workspaceId } = controlPlane()
  saveSendingDomain(mailbox, mailbox.sending_domain, parseRpc(DomainResultSchema, await control.checkSendingDomain(workspaceId, mailboxId)))
}

const SetSendingDomainSchema = z.object({
  mailboxId: mailboxIdSchema,
  domain: z.string().trim().toLowerCase().min(1).max(253),
  status: DomainResultSchema.shape.status,
  records: DomainResultSchema.shape.records,
})

export function setSendingDomain(input: z.input<typeof SetSendingDomainSchema>): void {
  const { mailboxId, domain, ...result } = parseRpc(SetSendingDomainSchema, input)
  saveSendingDomain(managedMailbox(mailboxId), domain, result)
}

export function forgetSendingDomainIfMoved(mailboxId: number) {
  const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', mailboxId)
  if (!mailbox || mailbox.kind !== 'managed' || !mailbox.sending_domain || mailbox.sending_domain === domainOf(mailbox.email)) return
  run(`UPDATE mailboxes SET sending_domain = '', sending_status = 'none', sending_records = '[]', sending_since = NULL, sending_checked_at = NULL WHERE id = ?`, mailboxId)
}

const RECHECK_FAST_MS = 10 * 60_000
const RECHECK_FAST_FOR = 72 * 3_600_000
const RECHECK_SLOW_MS = 86_400_000

type PendingDomain = Pick<MailboxRow, 'id' | 'sending_since' | 'sending_checked_at'>
const pendingDomains = () => all<PendingDomain>(`SELECT id, sending_since, sending_checked_at FROM mailboxes WHERE kind = 'managed' AND sending_status = 'pending' AND sending_domain != ''`)
const recheckAt = (m: PendingDomain) => {
  const since = m.sending_since ?? 0
  const checked = m.sending_checked_at ?? since
  return checked + (checked - since < RECHECK_FAST_FOR ? RECHECK_FAST_MS : RECHECK_SLOW_MS)
}

export function nextDomainCheckAt(): number | null {
  const due = pendingDomains().map(recheckAt)
  return due.length ? Math.min(...due) : null
}

export async function checkDueDomains() {
  for (const mailbox of pendingDomains()) {
    if (recheckAt(mailbox) > now()) continue
    try {
      await checkSendingDomain(mailbox.id)
    } catch (err) {
      console.error(`[domain] check failed for mailbox ${mailbox.id}:`, (err as Error).message)
      run('UPDATE mailboxes SET sending_checked_at = ? WHERE id = ?', now(), mailbox.id)
    }
  }
}

const BounceSchema = z.object({
  messageId: z.string().trim().min(1).max(998),
  recipient: z.string().trim().min(1).max(254),
  kind: z.enum(['hard', 'complaint']),
  reason: z.string().max(2000),
})

// Only a hard bounce means the customer never got the reply. After a complaint it was delivered.
export function noteBounce(input: z.input<typeof BounceSchema>): void {
  const bounce = parseRpc(BounceSchema, input)
  const bare = bounce.messageId.replace(/^<|>$/g, '')
  const thread = get<{ id: number; conversation_id: number; mailbox_id: number }>(
    `SELECT t.id, t.conversation_id, c.mailbox_id FROM threads t JOIN conversations c ON c.id = t.conversation_id
     WHERE t.type = 'reply' AND (t.message_id IN (?, ?) OR t.provider_id IN (?, ?)) ORDER BY t.id DESC LIMIT 1`,
    bare,
    `<${bare}>`,
    bare,
    bounce.messageId,
  )
  if (!thread) return
  if (bounce.kind === 'complaint') {
    console.log(`[mail] ${bounce.recipient} marked thread ${thread.id} as spam`)
    return
  }
  const reason = bounce.reason.trim().split(/\r?\n/)[0].slice(0, 300)
  run(
    `UPDATE threads SET state = 'failed', error = ?, retry_at = NULL WHERE id = ? AND state IN ('sent', 'failed')`,
    `${bounce.recipient} did not get this reply. Their mail server refused it${reason ? `: "${reason}"` : '.'}`,
    thread.id,
  )
  publish({ type: 'conversation', id: thread.conversation_id, mailboxId: thread.mailbox_id, reason: 'send_failed' })
}

export interface ManagedMailboxView {
  inboundAddress: string
  receiving: boolean
  forwardingConfirmation: ForwardingConfirmation | null
  sendingDomain: string
  sendingStatus: MailboxRow['sending_status']
  sendingRecords: DnsRecord[]
  sendingCheckedAt: number | null
}

export function managedView(mailbox: MailboxRow): ManagedMailboxView {
  return {
    inboundAddress: mailbox.inbound_address,
    receiving: !!mailbox.first_inbound_at,
    forwardingConfirmation: parseJson<ForwardingConfirmation | null>(mailbox.forwarding_confirmation, null),
    sendingDomain: mailbox.sending_domain,
    sendingStatus: mailbox.sending_status,
    sendingRecords: z.array(DnsRecordSchema).catch([]).parse(parseJson<unknown>(mailbox.sending_records, [])),
    sendingCheckedAt: mailbox.sending_checked_at,
  }
}

export async function billing(): Promise<{ plan: PlanState; mailboxes: number; links: BillingLinks }> {
  const { control, workspaceId, state } = controlPlane()
  const links = parseRpc(BillingLinksSchema, await control.billingLinks(workspaceId))
  return { plan: state.planState, mailboxes: get<{ n: number }>('SELECT COUNT(*) AS n FROM mailboxes')!.n, links }
}
