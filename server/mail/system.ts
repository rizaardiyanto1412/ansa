import { get } from '../db.ts'
import { config } from '../config.ts'
import { hostedState, type SystemEmail } from '../hosted.ts'
import { currentTenant } from '../tenant.ts'
import { AppError } from '../services/customers.ts'
import { brandName } from '../services/workspace.ts'
import { sendMail, type MailboxRow } from './outbound.ts'

export async function sendSystemEmail(mail: SystemEmail): Promise<void> {
  if (config.mailDisabled) {
    console.log(`[mail] disabled, so this was not sent. To ${mail.to}: ${mail.subject}\n${mail.text}`)
    return
  }
  if (config.hosted) {
    const { control } = currentTenant()
    const state = hostedState()
    if (!control || !state) throw new AppError('This workspace cannot send email yet.', 503)
    await control.sendSystemEmail(state.workspaceId, { ...mail, headers: { ...mail.headers, 'X-Ansa-Kind': mail.kind } })
    return
  }
  const mailbox = get<MailboxRow>(`SELECT * FROM mailboxes WHERE smtp_host != '' ORDER BY id LIMIT 1`)
  if (!mailbox) throw new AppError('Ansa cannot send email yet. Connect a mailbox with an SMTP server in Settings → Mailboxes first.')
  await sendMail(mailbox, {
    to: [mail.to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    fromName: brandName(),
    headers: { ...mail.headers, 'X-Ansa-Kind': mail.kind, 'X-Ansa-Notification': '1', 'Auto-Submitted': 'auto-generated' },
  })
}
