import { ImapFlow } from 'imapflow'
import { all, get, run, now, getSetting, setSetting } from '../db.ts'
import { config } from '../config.ts'
import { decrypt } from '../crypto.ts'
import { publish } from '../events.ts'
import { bindTenant, currentTenant } from '../tenant.ts'
import { explainMailError, type MailboxRow } from './outbound.ts'
import { ingestRaw } from './ingest.ts'

export interface ImapSettings {
  host: string
  port: number
  security: 'ssl' | 'starttls' | 'none'
  user: string
  pass: string
  folder: string
}

function clientFor(s: ImapSettings) {
  return new ImapFlow({
    host: s.host,
    port: s.port,
    secure: s.security === 'ssl',
    doSTARTTLS: s.security === 'starttls' ? true : s.security === 'none' ? false : undefined,
    auth: { user: s.user, pass: s.pass },
    logger: false,
    socketTimeout: 5 * 60_000,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
  } as ConstructorParameters<typeof ImapFlow>[0])
}

export async function testImap(s: ImapSettings): Promise<{ messages: number }> {
  if (!s.host) throw new Error('Enter the IMAP host.')
  const client = clientFor(s)
  client.on('error', () => {})
  try {
    await client.connect()
    const folder = s.folder || 'INBOX'
    let status
    try {
      status = await client.status(folder, { messages: true })
    } catch (err) {
      if (!client.usable) throw err
      // Most often the folder name is wrong. Show the real names so the person can pick one.
      const names = (await client.list().catch(() => [])).map((box) => box.path).filter((path) => !/^\[Gmail\]$/i.test(path))
      if (names.length === 0 || names.includes(folder)) throw err
      throw new Error(`The folder "${folder}" was not found. Folders in this account: ${names.slice(0, 25).join(', ')}${names.length > 25 ? ', …' : ''}.`)
    }
    return { messages: (status && status.messages) || 0 }
  } finally {
    await client.logout().catch(() => client.close())
  }
}

const IMPORT_DAYS = 30

export class MailboxWorker {
  private client: ImapFlow | null = null
  private stopped = false
  private syncing = false
  private again = false
  private timer: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null
  private failures = 0
  constructor(readonly mailboxId: number) {}

  private mailbox() {
    return get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', this.mailboxId)
  }

  private setStatus(status: string, error: string | null = null) {
    run('UPDATE mailboxes SET sync_status = ?, sync_error = ?, last_sync_at = CASE WHEN ? = \'ok\' THEN ? ELSE last_sync_at END WHERE id = ?', status, error, status, now(), this.mailboxId)
    publish({ type: 'mailbox', id: this.mailboxId })
  }

  async start() {
    const mailbox = this.mailbox()
    if (this.stopped || !mailbox || !mailbox.imap_enabled || !mailbox.imap_host) return
    this.teardown()
    // In poll-only mode this runs every minute, so skip the status write when all is well.
    if (!config.imapPollOnly || mailbox.sync_status !== 'ok') this.setStatus('connecting')
    const client = clientFor({
      host: mailbox.imap_host,
      port: mailbox.imap_port,
      security: mailbox.imap_security,
      user: mailbox.imap_user,
      pass: decrypt(mailbox.imap_pass_enc),
      folder: mailbox.imap_folder,
    })
    this.client = client
    client.on('error', (err) => console.error(`[imap ${mailbox.email}]`, err.message))
    const onClose = bindTenant(() => {
      if (this.client === client) this.reconnect('Connection closed')
    })
    const onExists = bindTenant(() => void this.sync())
    client.on('close', onClose)
    client.on('exists', onExists)
    try {
      await client.connect()
      await client.mailboxOpen(mailbox.imap_folder || 'INBOX')
      this.failures = 0
      await this.sync()
      if (this.stopped || this.client !== client) return // dropped during the first sync; a reconnect is already scheduled
      if (config.imapPollOnly) {
        this.client = null
        await client.logout().catch(() => client.close())
        return
      }
      this.timer = setInterval(onExists, config.imapPollSeconds * 1000)
    } catch (err) {
      this.reconnect(explainMailError(err))
    }
  }

  private reconnect(reason: string) {
    if (this.stopped) return
    this.teardown()
    this.failures++
    const delay = Math.min(5 * 60_000, 5000 * 2 ** Math.min(this.failures - 1, 6))
    this.setStatus('error', reason)
    if (config.imapPollOnly) return // the next scheduled check tries again
    const retry = bindTenant(() => void this.start())
    this.retry = setTimeout(retry, delay)
  }

  private teardown() {
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
    this.timer = this.retry = null
    const client = this.client
    this.client = null
    if (client) {
      try {
        client.close()
      } catch {
        /* already closed */
      }
    }
  }

  async stop() {
    this.stopped = true
    this.teardown()
  }

  /** Fetch every message newer than the last one we imported. */
  async sync(): Promise<void> {
    const client = this.client
    if (!client || !client.usable || this.stopped) return
    if (this.syncing) {
      this.again = true
      return
    }
    this.syncing = true
    try {
      const mailbox = this.mailbox()
      if (!mailbox) return
      const lock = await client.getMailboxLock(mailbox.imap_folder || 'INBOX')
      try {
        const box = client.mailbox
        if (!box) return
        const validity = String(box.uidValidity)
        let lastUid = mailbox.imap_last_uid
        let historicalUpTo = 0
        if (lastUid === null || mailbox.imap_uidvalidity !== validity) {
          // First connection, or the server renumbered the folder: decide where to start.
          const top = Math.max(0, Number(box.uidNext) - 1)
          lastUid = top
          const renumbered = mailbox.imap_uidvalidity !== null
          // After a renumber, look back to the last good sync so nothing is skipped. Message-IDs prevent duplicates.
          const since = renumbered ? new Date((mailbox.last_sync_at ?? Date.now()) - 86_400_000) : mailbox.import_existing ? new Date(Date.now() - IMPORT_DAYS * 86_400_000) : null
          if (since) {
            const found = await client.search({ since }, { uid: true })
            if (found && found.length) {
              lastUid = Math.min(...found) - 1
              historicalUpTo = top
            }
          }
          run('UPDATE mailboxes SET imap_uidvalidity = ?, imap_last_uid = ? WHERE id = ?', validity, lastUid, this.mailboxId)
        }
        {
          // Always ask the server: the cached uidNext is not refreshed when new mail arrives.
          const uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter((uid) => uid > lastUid!).sort((a, b) => a - b)
          for (const uid of uids) {
            if (this.stopped) break
            const message = await client.fetchOne(String(uid), { source: true }, { uid: true })
            if (message && message.source) {
              try {
                await ingestRaw(this.mailboxId, message.source, { historical: uid <= historicalUpTo })
              } catch (err) {
                // Stop here and try this message again on the next pass (a full disk recovers; a bad message is skipped after 3 tries).
                // Kept in the database: in poll-only mode the process does not live between checks.
                const badKey = `imap_bad_uid_${this.mailboxId}`
                const bad = getSetting<{ uid: number; tries: number }>(badKey, { uid: 0, tries: 0 })
                const tries = (bad.uid === uid ? bad.tries : 0) + 1
                console.error(`[imap ${mailbox.email}] could not import message uid ${uid} (try ${tries}):`, (err as Error).message)
                if (tries < 3) {
                  setSetting(badKey, { uid, tries })
                  this.setStatus('error', `Could not import a message: ${(err as Error).message}`)
                  return
                }
              }
            }
            run('UPDATE mailboxes SET imap_last_uid = ? WHERE id = ?', uid, this.mailboxId)
          }
        }
        this.setStatus('ok')
      } finally {
        lock.release()
      }
    } catch (err) {
      console.error(`[imap] sync failed for mailbox ${this.mailboxId}:`, (err as Error).message)
      if (this.client === client && !client.usable) this.reconnect(explainMailError(err))
    } finally {
      this.syncing = false
      if (this.again) {
        this.again = false
        void this.sync()
      }
    }
  }
}

/** (Re)start the IMAP worker for one mailbox after its settings change. */
export async function restartMailbox(mailboxId: number) {
  const workers = currentTenant().imapWorkers
  await workers.get(mailboxId)?.stop()
  workers.delete(mailboxId)
  if (config.mailDisabled) return
  const mailbox = get<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', mailboxId)
  if (!mailbox) return
  if (!mailbox.imap_enabled || !mailbox.imap_host) {
    run(`UPDATE mailboxes SET sync_status = 'idle', sync_error = NULL WHERE id = ?`, mailboxId)
    return
  }
  const worker = new MailboxWorker(mailboxId)
  workers.set(mailboxId, worker)
  if (config.imapPollOnly) await worker.start()
  else void worker.start()
}

/** Poll-only platforms call this on a schedule: check every connected mailbox once. */
export async function pollAllMailboxes() {
  if (config.mailDisabled) return
  const ids = all<{ id: number }>(`SELECT id FROM mailboxes WHERE imap_enabled = 1 AND imap_host != ''`).map((m) => m.id)
  await Promise.allSettled(ids.map((id) => restartMailbox(id)))
}

export function startAllMailboxes() {
  for (const { id } of all<{ id: number }>('SELECT id FROM mailboxes')) void restartMailbox(id)
}

export async function syncMailboxNow(mailboxId: number) {
  const worker = currentTenant().imapWorkers.get(mailboxId)
  if (!worker || config.imapPollOnly) return restartMailbox(mailboxId)
  await worker.sync()
}

export async function stopAllMailboxes() {
  const workers = currentTenant().imapWorkers
  await Promise.all([...workers.values()].map((w) => w.stop()))
  workers.clear()
}
