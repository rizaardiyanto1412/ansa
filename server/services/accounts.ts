import { all, get, run, tx, now } from '../db.ts'
import { config } from '../config.ts'
import { hashPassword, randomToken, sha256 } from '../crypto.ts'
import { allowAttempt, USER_COLORS } from '../auth.ts'
import { hostedState, type SystemEmail } from '../hosted.ts'
import { escapeHtml } from '../mail/html.ts'
import { wrapEmailHtml } from '../mail/outbound.ts'
import { sendSystemEmail } from '../mail/system.ts'
import { AppError, isEmail, normEmail } from './customers.ts'
import { brandName } from './workspace.ts'

export type LinkPurpose = 'sign_in' | 'invite' | 'reset'

const LINK_HOURS = 24
const HOUR = 3_600_000
const LINK_GONE = 'This link has expired or was already used. Ask for a new one.'

export const minPasswordLength = () => (config.hosted ? 10 : 8)

export function checkPassword(password: unknown): string {
  const min = minPasswordLength()
  if (typeof password !== 'string' || password.length < min) throw new AppError(`Use a password with at least ${min} characters.`)
  if (password.length > 1000) throw new AppError('That password is too long.')
  return password
}

export const workspaceLabel = () => hostedState()?.workspaceName || brandName()

// The token travels in the URL fragment, which browsers send to no server, so no proxy or log sees it.
export function issueLink(userId: number, purpose: LinkPurpose): string {
  const token = randomToken()
  const ts = now()
  run('INSERT INTO one_time_links (purpose, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', purpose, userId, sha256(token), ts + LINK_HOURS * HOUR, ts)
  return `${config.appUrl}/link#${token}`
}

interface OpenLink {
  id: number
  purpose: LinkPurpose
  userId: number
  name: string
  email: string
  hasPassword: boolean
}

function openLink(token: unknown): OpenLink {
  const row =
    typeof token === 'string' && token.length > 0 && token.length <= 200
      ? get<any>(
          `SELECT l.id, l.purpose, l.user_id, u.name, u.email, u.password_hash FROM one_time_links l JOIN users u ON u.id = l.user_id
           WHERE l.token_hash = ? AND l.used_at IS NULL AND l.expires_at > ? AND u.disabled = 0`,
          sha256(token),
          now(),
        )
      : undefined
  if (!row) throw new AppError(LINK_GONE, 404)
  return { id: row.id, purpose: row.purpose, userId: row.user_id, name: row.name, email: row.email, hasPassword: row.password_hash !== '' }
}

const asksPassword = (link: OpenLink) => link.purpose !== 'sign_in' || !link.hasPassword

export function inspectLink(token: unknown) {
  const link = openLink(token)
  return { purpose: link.purpose, email: link.email, name: link.purpose === 'invite' ? '' : link.name, needsName: link.purpose === 'invite', needsPassword: asksPassword(link) }
}

export function consumeLink(token: unknown, input: { name?: unknown; password?: unknown }): number {
  const link = openLink(token)
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : ''
  if (link.purpose === 'invite' && !name) throw new AppError('Enter your name.')
  const passwordHash = asksPassword(link) ? hashPassword(checkPassword(input.password)) : null
  tx(() => {
    const ts = now()
    if (run('UPDATE one_time_links SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', ts, link.id, ts).changes !== 1) throw new AppError(LINK_GONE, 404)
    if (link.purpose === 'invite') run('UPDATE users SET name = ? WHERE id = ?', name, link.userId)
    if (!passwordHash) return
    run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, link.userId)
    run('DELETE FROM one_time_links WHERE user_id = ? AND id != ?', link.userId, link.id)
    if (link.purpose === 'reset') run('DELETE FROM sessions WHERE user_id = ?', link.userId)
  })
  return link.userId
}

export const voidLinks = (userId: number) => run('DELETE FROM one_time_links WHERE user_id = ?', userId)

const button = (url: string, label: string) =>
  `<p style="margin:20px 0;"><a href="${escapeHtml(url)}" style="display:inline-block; background:#4336c9; color:#ffffff; text-decoration:none; font-weight:600; padding:10px 16px; border-radius:8px;">${escapeHtml(label)}</a></p>`

const footnote = `This link works once and expires in ${LINK_HOURS} hours.`

function inviteEmail(to: string, inviter: string, url: string): SystemEmail {
  const where = workspaceLabel()
  return {
    kind: 'invite',
    to,
    subject: `${inviter} invited you to ${where}`,
    html: wrapEmailHtml(`<p>${escapeHtml(inviter)} invited you to answer customer email with the team at ${escapeHtml(where)}.</p>${button(url, 'Accept the invite')}<p style="color:#6b7280;">${footnote}</p>`),
    text: `${inviter} invited you to answer customer email with the team at ${where}.\n\nAccept the invite:\n${url}\n\n${footnote}`,
  }
}

function resetEmail(to: string, url: string): SystemEmail {
  const where = workspaceLabel()
  return {
    kind: 'reset',
    to,
    subject: `Reset your password for ${where}`,
    html: wrapEmailHtml(
      `<p>Someone asked to reset the password of ${escapeHtml(to)} at ${escapeHtml(where)}.</p>${button(url, 'Choose a new password')}<p style="color:#6b7280;">${footnote} If you did not ask for it, ignore this email: your password stays the same.</p>`,
    ),
    text: `Someone asked to reset the password of ${to} at ${where}.\n\nChoose a new password:\n${url}\n\n${footnote} If you did not ask for it, ignore this email: your password stays the same.`,
  }
}

const nameFromEmail = (email: string) => email.split('@')[0].slice(0, 100)

export async function inviteTeammate(input: { email: unknown; role: unknown }, inviter: { id: number; name: string }): Promise<number> {
  if (!isEmail(input.email)) throw new AppError('Enter a valid email address.')
  const email = normEmail(input.email)
  const role = input.role === 'admin' ? 'admin' : 'agent'
  const waiting = get<{ id: number; password_hash: string; disabled: number }>('SELECT id, password_hash, disabled FROM users WHERE email = ?', email)
  if (waiting && (waiting.password_hash !== '' || waiting.disabled)) throw new AppError('A teammate with that email already exists.', 409)
  if (!allowAttempt(`invite:by:${inviter.id}`, 30, HOUR) || !allowAttempt(`invite:to:${email}`, 5, HOUR)) throw new AppError('Too many invites. Wait an hour and try again.', 429)

  const userId = tx(() => {
    if (waiting) {
      run('UPDATE users SET role = ? WHERE id = ?', role, waiting.id)
      return waiting.id
    }
    const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n
    return run(`INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?, ?, '', ?, ?, ?)`, nameFromEmail(email), email, role, USER_COLORS[count % USER_COLORS.length], now()).id
  })
  try {
    await sendSystemEmail(inviteEmail(email, inviter.name, issueLink(userId, 'invite')))
  } catch (err) {
    if (!waiting) run(`DELETE FROM users WHERE id = ? AND password_hash = ''`, userId)
    throw err
  }
  return userId
}

export function cancelInvite(userId: number) {
  if (run(`DELETE FROM users WHERE id = ? AND password_hash = ''`, userId).changes !== 1) throw new AppError('That invite is no longer waiting.', 409)
}

const RESET_TRIES = 5
const RESET_LEASE = 5 * 60_000
const resetRetryDelay = (tries: number) => Math.min(HOUR, 30_000 * 4 ** (tries - 1))

export function requestPasswordReset(emailRaw: unknown) {
  if (!isEmail(emailRaw)) return
  const email = normEmail(emailRaw)
  if (!allowAttempt(`reset:to:${email}`, 3, HOUR)) return
  const ts = now()
  run('INSERT INTO reset_outbox (email, next_at, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING', email, ts, ts)
}

export const nextResetAt = () => get<{ at: number | null }>('SELECT MIN(next_at) AS at FROM reset_outbox')?.at ?? null

async function sendResetLink(email: string) {
  const user = get<{ id: number; email: string }>('SELECT id, email FROM users WHERE email = ? AND disabled = 0', email)
  if (user) await sendSystemEmail(resetEmail(user.email, issueLink(user.id, 'reset')))
}

export async function deliverResetOutbox() {
  const due = all<{ email: string; tries: number; next_at: number }>('SELECT email, tries, next_at FROM reset_outbox WHERE next_at <= ? ORDER BY next_at LIMIT 20', now())
  for (const row of due) {
    if (run('UPDATE reset_outbox SET next_at = ? WHERE email = ? AND next_at = ?', now() + RESET_LEASE, row.email, row.next_at).changes !== 1) continue
    try {
      await sendResetLink(row.email)
      run('DELETE FROM reset_outbox WHERE email = ?', row.email)
    } catch (err) {
      const tries = row.tries + 1
      console.error(`[accounts] could not send a reset link (try ${tries} of ${RESET_TRIES}):`, (err as Error).message)
      if (tries >= RESET_TRIES) run('DELETE FROM reset_outbox WHERE email = ?', row.email)
      else run('UPDATE reset_outbox SET tries = ?, next_at = ? WHERE email = ?', tries, now() + resetRetryDelay(tries), row.email)
    }
  }
}
