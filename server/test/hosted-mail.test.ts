import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp, prepareData } from '../app.ts'
import { readConfig } from '../config.ts'
import { all, get, run } from '../db.ts'
import type { ControlPlane, SystemEmail } from '../hosted.ts'
import { dispatchQueued, nextRetryAt } from '../mail/outbound.ts'
import { addReply, createConversation, getConversation, retryDelivery, updateConversation } from '../services/conversations.ts'
import { EXPORT_BLANKED_COLUMNS, EXPORT_OMITTED_TABLES, exportArchive } from '../services/export.ts'
import { gmailForwardingConfirmation, ingestInbound, nextIngestCleanupAt, pruneInboundIngests, noteBounce } from '../services/managed.ts'
import { provision } from '../services/provision.ts'
import { runInTenant } from '../tenant.ts'
import { openNodeTenant } from '../tenant-node.ts'
import { zipStream } from '../zip.ts'
import { startSmtpCatcher } from './smtp-catcher.ts'
import { readZip } from './zip-reader.ts'

interface FakeControl extends ControlPlane {
  system: SystemEmail[]
  fallback: { mailboxId: number; from: string; to: string[]; raw: string }[]
}

function fakeControl(): FakeControl {
  const system: SystemEmail[] = []
  const fallback: FakeControl['fallback'] = []
  return {
    system,
    fallback,
    createInboundAddress: async (workspaceId, mailboxId) => ({ address: `${workspaceId}-m${mailboxId}@in.hosted.test` }),
    deleteInboundAddress: async () => {},
    addSendingDomain: async () => ({ status: 'pending', records: [] }),
    checkSendingDomain: async () => ({ status: 'pending', records: [] }),
    sendFallback: async (_workspaceId, message) => {
      fallback.push({ mailboxId: message.mailboxId, from: message.from, to: message.to, raw: Buffer.from(message.raw).toString('utf8') })
      return { messageId: `fallback-${fallback.length}` }
    },
    sendSystemEmail: async (_workspaceId, mail) => void system.push(mail),
    billingLinks: async () => ({ checkout: {}, portal: null }),
    reportHealth: async () => {},
  }
}

function install(env: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-hosted-mail-'))
  const tenant = openNodeTenant(readConfig((key) => ({ DATA_DIR: dataDir, ...env })[key]))
  const control = fakeControl()
  if (env.ANSA_HOSTED === '1') tenant.control = control
  const inside = <T>(fn: () => T): T => runInTenant(tenant, fn)
  const app = inside(() => {
    prepareData()
    return createApp()
  })
  const call = async (method: string, route: string, body?: unknown, cookie = '') => {
    const request = new Request(`http://localhost:3000/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ansa', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return inside(() => app.fetch(request, { incoming: { socket: { remoteAddress: '203.0.113.9' } } }))
  }
  return { tenant, control, inside, call, dataDir }
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts)
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return assert.fail(`timed out waiting for ${what}`)
}

const threadRow = (id: number) => get<{ state: string; error: string | null; attempts: number; retry_at: number | null }>('SELECT state, error, attempts, retry_at FROM threads WHERE id = ?', id)!

test('the zip writer makes an archive that standard tools read', async () => {
  const big = new Uint8Array(300_000).map((_, i) => i % 251)
  const archive = await collect(
    zipStream(
      (async function* () {
        yield { name: 'README.txt', data: [new TextEncoder().encode('hello')] }
        yield { name: 'empty.bin', data: [] }
        yield { name: 'attachments/7/naïve résumé.pdf', data: [big.subarray(0, 100_000), big.subarray(100_000)] }
      })(),
    ),
  )
  const files = readZip(archive)
  assert.deepEqual(files.map((file) => [file.name, file.data.length]), [['README.txt', 5], ['empty.bin', 0], ['attachments/7/naïve résumé.pdf', 300_000]])
  assert.equal(files[0].data.toString(), 'hello')
  assert.ok(files[2].data.equals(big), 'a file written in several chunks comes back whole')

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-zip-')), 'out.zip')
  fs.writeFileSync(file, archive)
  let listing = ''
  try {
    listing = execFileSync('unzip', ['-t', file], { encoding: 'utf8' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  assert.match(listing, /No errors detected/, 'unzip -t accepts the archive')
})

test('an export holds the data and the files, and none of the secrets', async () => {
  const ws = install()
  const setup = await ws.call('POST', '/setup', { name: 'Sol', email: 'sol@self.test', password: 'a long password' })
  const cookie = setup.headers.getSetCookie().find((line) => /ansa_session=/.test(line))!.split(';')[0]
  const sessionId = cookie.split('=')[1]
  const mailbox = await ws.call('POST', '/mailboxes', { name: 'Support', email: 'support@self.test', smtpHost: 'smtp.self.test', smtpUser: 'support@self.test', smtpPassword: 'hunter2-smtp', imapEnabled: false }, cookie)
  assert.equal(mailbox.status, 201)
  const token = (await (await ws.call('POST', '/tokens', { name: 'CI' }, cookie)).json()) as { secret: string }
  await ws.inside(async () => {
    run(`INSERT INTO one_time_links (purpose, user_id, token_hash, expires_at, created_at) VALUES ('reset', 1, 'one-time-link-hash-0123456789', ?, 1)`, Date.now() + 60_000)
    run(`INSERT INTO apps (name, secret_enc, created_at) VALUES ('Hook', 'v1:sealed-app-secret', 1)`)
    run(`INSERT INTO settings (key, value) VALUES ('import_helpscout', ?)`, JSON.stringify({ status: 'paused', appId: 'hs-app-id', secretEnc: 'v1:sealed-hs', token: 'hs-token', imported: 3 }))
    run(`INSERT INTO settings (key, value) VALUES ('hosted', ?)`, JSON.stringify({ workspaceId: 'ws_x', smtp: { host: 'smtp.tenant.test', user: 'tenant-user', passEnc: 'v1:sealed-tenant' } }))
    const raw = ['From: Cara <cara@customer.test>', 'To: support@self.test', 'Subject: With a file', 'Message-ID: <export-1@customer.test>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', "It's broken", '--b', 'Content-Type: text/plain; name=notes.txt', 'Content-Disposition: attachment; filename=notes.txt', '', 'file body here', '--b--', ''].join('\r\n')
    const { ingestRaw } = await import('../mail/ingest.ts')
    await ingestRaw(1, raw)
  })

  const download = await ws.call('GET', '/workspace/export', undefined, cookie)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'application/zip')
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="ansa-export-\d{4}-\d\d-\d\d\.zip"$/)
  const files = readZip(new Uint8Array(await download.arrayBuffer()))
  const names = files.map((file) => file.name)
  const text = (name: string) => files.find((file) => file.name === name)?.data.toString('utf8') ?? assert.fail(`${name} is missing from ${names.join(', ')}`)

  for (const table of ['users', 'mailboxes', 'customers', 'conversations', 'threads', 'attachments', 'settings', 'apps']) assert.ok(names.includes(`sql/${table}.sql`), `sql/${table}.sql is in the export`)
  for (const table of ['sessions', 'api_tokens', 'one_time_links', 'attempts', 'reset_outbox', 'search', 'search_data', '_blobs']) assert.ok(!names.includes(`sql/${table}.sql`), `sql/${table}.sql is left out`)
  assert.match(text('sql/users.sql'), /^CREATE TABLE users/, 'each file starts with the table definition')
  assert.match(text('sql/users.sql'), /INSERT INTO "users" \("id", "name", "email", "password_hash"[^)]*\) VALUES \(1, 'Sol', 'sol@self\.test', '',/, 'the password hash is blank')
  assert.match(text('sql/threads.sql'), /'<p>It''s broken<\/p>'/, 'quotes are escaped')
  assert.match(text('sql/mailboxes.sql'), /'smtp\.self\.test'/, 'server names stay')
  assert.equal(text('attachments/1/notes.txt').trim(), 'file body here', 'the attachment is in the archive under its id and name')
  assert.match(text('sql/settings.sql'), /"imported":3/, 'harmless settings stay')
  assert.match(text('sql/settings.sql'), /"workspaceId":"ws_x"/)

  const everything = Buffer.concat(files.map((file) => file.data)).toString('latin1')
  const stored = ws.inside(() => ({
    hash: get<{ password_hash: string }>('SELECT password_hash FROM users')!.password_hash,
    smtp: get<{ smtp_pass_enc: string }>('SELECT smtp_pass_enc FROM mailboxes')!.smtp_pass_enc,
    tokenHash: get<{ token_hash: string }>('SELECT token_hash FROM api_tokens')!.token_hash,
    linkHash: get<{ token_hash: string }>('SELECT token_hash FROM one_time_links')!.token_hash,
  }))
  assert.ok(stored.hash.startsWith('scrypt:') && stored.smtp.startsWith('v1:'), 'the secrets exist in the database')
  const secrets = { ...stored, sessionId, apiToken: token.secret, appSecret: 'sealed-app-secret', helpScoutSecret: 'sealed-hs', helpScoutToken: 'hs-token', helpScoutApp: 'hs-app-id', tenantPassword: 'sealed-tenant', tenantUser: 'tenant-user', installSecret: ws.tenant.config.secret }
  for (const [name, value] of Object.entries(secrets)) assert.ok(value.length > 5 && !everything.includes(value), `the export does not contain the ${name}`)

  const secretLooking = ws.inside(() =>
    all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).flatMap((table) =>
      all<{ name: string }>(`SELECT name FROM pragma_table_info('${table.name}')`)
        .filter((column) => /pass|secret|token|hash|_enc$/i.test(column.name))
        .map((column) => ({ table: table.name, column: column.name })),
    ),
  )
  assert.ok(secretLooking.length >= 5, 'the schema has secret columns to check')
  for (const { table, column } of secretLooking) {
    assert.ok(EXPORT_OMITTED_TABLES.includes(table) || EXPORT_BLANKED_COLUMNS[table]?.includes(column), `${table}.${column} looks secret: omit its table or blank it in the export`)
  }

  const agent = await ws.call('POST', '/users', { name: 'Agent', email: 'agent@self.test', password: 'agent password', role: 'agent' }, cookie)
  assert.equal(agent.status, 201)
  const login = await ws.call('POST', '/login', { email: 'agent@self.test', password: 'agent password' })
  const agentCookie = login.headers.getSetCookie().find((line) => /ansa_session=/.test(line))!.split(';')[0]
  assert.equal((await ws.call('GET', '/workspace/export', undefined, agentCookie)).status, 403, 'only an admin may export')
})

test('a mail server that says "try later" gets another try; one that says no fails the reply', async () => {
  const catcher = await startSmtpCatcher()
  const ws = install()
  try {
    await ws.inside(async () => {
      const mailboxId = run(`INSERT INTO mailboxes (name, email, smtp_host, smtp_port, smtp_security, created_at) VALUES ('Support', 'support@self.test', '127.0.0.1', ?, 'none', 1)`, catcher.port).id
      const agentId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Agent', 'agent@self.test', 'x', 'admin', 1)`).id
      const actor = { userId: agentId, via: 'web' as const }
      const conversation = createConversation({ mailboxId, customerEmail: 'cara@customer.test', subject: 'Help', bodyHtml: '<p>Help</p>', kind: 'customer' }, { userId: null, via: 'email' })

      catcher.script.nextRcpt = '451 4.7.1 Hourly limit reached, try again later'
      const first = addReply(conversation.id, { bodyHtml: '<p>First answer</p>' }, actor)
      const queued = await until(() => threadRow(first), (t) => t.state !== 'sending', 'the first delivery to settle')
      assert.deepEqual([queued.state, queued.attempts], ['queued', 1], 'a 451 queues the reply')
      assert.match(queued.error ?? '', /try again later.*It said: "451 4\.7\.1 Hourly limit reached/, 'the reason names what the server said')
      assert.ok(queued.retry_at! > Date.now() + 50_000 && queued.retry_at! < Date.now() + 70_000, 'the first retry waits a minute')
      assert.equal(nextRetryAt(), queued.retry_at, 'the platform can ask when to wake up')
      assert.equal(getConversation(conversation.id).threads.find((t) => t.id === first)!.retryAt, queued.retry_at, 'the browser learns when it is tried again')
      assert.equal(catcher.inbox.length, 0)

      await dispatchQueued()
      assert.equal(threadRow(first).state, 'queued', 'nothing is sent before its time')
      run('UPDATE threads SET retry_at = ? WHERE id = ?', Date.now() - 1, first)
      await dispatchQueued()
      assert.deepEqual([threadRow(first).state, threadRow(first).error, threadRow(first).retry_at], ['sent', null, null], 'the retry delivers it')
      assert.deepEqual(catcher.inbox.map((mail) => [mail.to, mail.text.includes('First answer')]), [['cara@customer.test', true]])
      assert.equal(nextRetryAt(), null)
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM outbound_log')!.n, 0, 'a self-hosted install keeps no sending log')

      catcher.script.nextRcpt = '550 5.1.1 No such user here'
      const second = addReply(conversation.id, { bodyHtml: '<p>Second answer</p>' }, actor)
      const failed = await until(() => threadRow(second), (t) => t.state !== 'sending', 'the second delivery to settle')
      assert.equal(failed.state, 'failed', 'a 550 is final')
      assert.match(failed.error ?? '', /550 5\.1\.1 No such user here/)

      run('UPDATE threads SET attempts = 5 WHERE id = ?', second)
      run(`UPDATE threads SET state = 'sending' WHERE id = ?`, second)
      catcher.script.nextRcpt = '421 4.3.2 Service not available'
      const { deliverThread } = await import('../mail/outbound.ts')
      await deliverThread(second)
      assert.equal(threadRow(second).state, 'failed', 'after five retries it stops')
      assert.match(threadRow(second).error ?? '', /tried 6 times and stopped/)

      retryDelivery(second, actor)
      const again = await until(() => threadRow(second), (t) => t.state !== 'sending', 'the manual retry to settle')
      assert.deepEqual([again.state, again.attempts], ['sent', 0], 'Send again starts counting from zero')
    })
  } finally {
    await catcher.close()
  }
})

test("Gmail's forwarding confirmation is recognised by its sender", () => {
  const from = (address: string) => ({ value: [{ address, name: '' }], html: '', text: '' })
  const text = 'support@acme.test has requested to automatically forward mail to your email address acme-x7@in.helpansa.com.\nConfirmation code: 482913077\n\nTo allow it, click the link below:\n\nhttps://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-xyz_123\n\nIf you click the link and it appears to be broken, paste it into a new browser window.'
  const found = gmailForwardingConfirmation({ from: from('forwarding-noreply@google.com'), subject: '(#482913077) Gmail Forwarding Confirmation - Receive Mail from support@acme.test', text })
  assert.deepEqual([found?.code, found?.link], ['482913077', 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-xyz_123'])
  assert.equal(gmailForwardingConfirmation({ from: from('forwarding-noreply@google.com'), subject: 'Bestätigung', text: 'Bestätigungscode 77 https://evil.test/mail/vf' }), null, 'no code and no Google link means no confirmation')
  assert.equal(gmailForwardingConfirmation({ from: from('someone@customer.test'), subject: '(#482913077) Gmail Forwarding Confirmation', text }), null, 'any other sender is ordinary mail')
})

test('a managed mailbox notifies teammates through the control plane, and their emailed answer comes back in', async () => {
  const ws = install({ ANSA_HOSTED: '1' })
  ws.inside(() => provision({ workspaceId: 'acme', workspaceName: 'Acme', appUrl: 'https://acme.hosted.test', admin: { name: 'Ada', email: 'ada@acme.test' }, smtp: { host: 'smtp.tenant.test', port: 587, security: 'starttls', user: 'u', pass: 'p' }, planState: { plan: 'team', mailboxLimit: 10, readOnly: false, hourlySendLimit: 100 } }))
  const mail = (headers: Record<string, string>, body: string) => Buffer.from([...Object.entries({ 'MIME-Version': '1.0', 'Content-Type': 'text/plain; charset=utf-8', ...headers }).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n'))
  await ws.inside(async () => {
    const mailboxId = run(`INSERT INTO mailboxes (name, email, kind, inbound_address, created_at) VALUES ('Support', 'support@acme.test', 'managed', 'acme-m1@in.hosted.test', 1)`).id
    const boId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Bo', 'bo@acme.test', 'x', 'agent', 1)`).id
    assert.equal(await ingestInbound(mailboxId, mail({ From: 'Cara <cara@customer.test>', To: 'support@acme.test', Subject: 'Where is my order', 'Message-ID': '<order-1@customer.test>' }, 'Hello?')), 'accepted')
    const conversationId = get<{ id: number }>('SELECT id FROM conversations')!.id
    updateConversation(conversationId, { assigneeId: boId }, { userId: 1, via: 'web' })
    const [notice] = await until(() => ws.control.system, (sent) => sent.length === 1, 'the assignment notification')
    assert.deepEqual([notice.to, notice.subject], ['bo@acme.test', `[Support #${conversationId}] Where is my order`])
    assert.equal(notice.headers?.['Reply-To'], '"Support (Ansa)" <acme-m1@in.hosted.test>', 'answers go to the inbound address')
    assert.equal(notice.headers?.['X-Ansa-Notification'], '1')
    assert.equal(notice.headers?.['X-Ansa-Kind'], 'notification')
    assert.match(notice.headers?.['Message-ID'] ?? '', /^<ansa-n\.\d+\.\d+\./, 'the signed id travels as a header')
    assert.match(notice.html, /Replying to this notification will email Cara/, 'the email offers reply by email')
    assert.ok(notice.text.length > 20, 'a plain-text part is included')

    const answer = mail({ From: 'Bo <bo@acme.test>', To: 'acme-m1@in.hosted.test', Subject: 'Re: Where is my order', 'Message-ID': '<bo-answer@acme.test>', 'In-Reply-To': notice.headers!['Message-ID'] }, 'It ships today.\n\n-- Please reply above this line --\nold text')
    assert.equal(await ingestInbound(mailboxId, answer), 'accepted')
    const reply = get<{ id: number; via: string; body_text: string }>(`SELECT id, via, body_text FROM threads WHERE type = 'reply'`)!
    assert.deepEqual([reply.via, reply.body_text.trim()], ['email', 'It ships today.'], 'the answer became a reply to the customer')
    await until(() => threadRow(reply.id), (t) => t.state !== 'sending', 'the emailed reply to go out')
    assert.deepEqual(ws.control.fallback.map((sent) => [sent.from, sent.to]), [['"Support" <support@acme.test>', ['cara@customer.test']]], 'it went out through the fallback, as the mailbox')
    assert.equal(await ingestInbound(mailboxId, answer), 'duplicate', 'a second delivery of the answer sends nothing more')
    assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM threads WHERE type = 'reply'`)!.n, 1)
  })
})

const inboundWithFiles = (messageId?: string) => Buffer.from([
  'From: Cara <cara@customer.test>', 'To: support@acme.test', 'Subject: Retry with files',
  ...(messageId ? [`Message-ID: ${messageId}`] : []),
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=files', '',
  '--files', 'Content-Type: text/plain', '', 'See both files',
  '--files', 'Content-Type: text/plain; name=first.txt', 'Content-Disposition: attachment; filename=first.txt', '', 'first body',
  '--files', 'Content-Type: text/plain; name=second.txt', 'Content-Disposition: attachment; filename=second.txt', '', 'second body',
  '--files--', '',
].join('\r\n'))

function managedInstall() {
  const ws = install({ ANSA_HOSTED: '1' })
  const mailboxId = ws.inside(() => {
    provision({ workspaceId: 'acme', workspaceName: 'Acme', appUrl: 'https://acme.hosted.test', admin: { name: 'Ada', email: 'ada@acme.test' }, smtp: { host: 'smtp.tenant.test', port: 587, security: 'starttls', user: 'u', pass: 'p' }, planState: { plan: 'team', mailboxLimit: 10, readOnly: false, hourlySendLimit: 100 } })
    return run(`INSERT INTO mailboxes (name, email, kind, inbound_address, created_at) VALUES ('Support', 'support@acme.test', 'managed', 'acme-m1@in.hosted.test', 1)`).id
  })
  return { ...ws, mailboxId }
}

for (const messageId of ['<resume@customer.test>', undefined]) {
  test(`interrupted inbound with ${messageId ? 'a Message-ID' : 'no Message-ID'} resumes after restart without partial rows`, async () => {
    const ws = managedInstall()
    const store = ws.tenant.blobs
    const written: string[] = []
    let writes = 0
    ws.tenant.blobs = { ...store, put: async (key, data) => {
      written.push(key)
      if (++writes === 2) throw new Error('blob store unavailable')
      await store.put(key, data)
    } }
    const raw = inboundWithFiles(messageId)
    await ws.inside(async () => {
      await assert.rejects(ingestInbound(ws.mailboxId, raw), /blob store unavailable/)
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n, 0, 'a failed blob write creates no conversation')
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM threads')!.n, 0, 'a failed blob write creates no thread')
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments')!.n, 0, 'a failed blob write creates no attachment row')
      await pruneInboundIngests()
      assert.equal(get<{ state: string }>('SELECT state FROM inbound_ingests')!.state, 'started', 'a recent delivery stays resumable after a sweep')
      assert.equal(get<{ first_inbound_at: number | null }>('SELECT first_inbound_at FROM mailboxes')!.first_inbound_at, null, 'an interrupted delivery does not mark forwarding as working')
    })
    const restarted = openNodeTenant(readConfig((key) => ({ DATA_DIR: ws.dataDir, ANSA_HOSTED: '1' })[key]))
    restarted.control = ws.control
    await runInTenant(restarted, async () => {
      prepareData()
      assert.equal(await ingestInbound(ws.mailboxId, raw), 'accepted', 'a started delivery is retried after restart')
      assert.equal(await ingestInbound(ws.mailboxId, raw), 'duplicate', 'only a completed delivery is a duplicate')
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n, 1)
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM threads')!.n, 1)
      const files = all<{ storage_key: string; filename: string }>('SELECT storage_key, filename FROM attachments ORDER BY id')
      assert.deepEqual(files.map((file) => file.storage_key), written, 'the retry overwrites the same blob keys')
      for (const [index, file] of files.entries()) {
        const blob = await restarted.blobs.get(file.storage_key)
        assert.ok(blob, `${file.filename} is readable`)
        assert.equal((await new Response(blob.body).text()).trim(), index === 0 ? 'first body' : 'second body')
      }
      assert.equal(get<{ state: string }>('SELECT state FROM inbound_ingests')!.state, 'complete')
    })
  })
}

test('inbound row failures roll back the entire message and concurrent retries file it once', async () => {
  const ws = managedInstall()
  await ws.inside(async () => {
    const raw = inboundWithFiles()
    ws.tenant.db.exec(`CREATE TRIGGER reject_attachment BEFORE INSERT ON attachments WHEN NEW.filename = 'second.txt' BEGIN SELECT RAISE(ABORT, 'attachment row unavailable'); END`)
    await assert.rejects(ingestInbound(ws.mailboxId, raw), /attachment row unavailable/)
    assert.deepEqual({ ...get<Record<string, number>>('SELECT (SELECT COUNT(*) FROM conversations) AS conversations, (SELECT COUNT(*) FROM threads) AS threads, (SELECT COUNT(*) FROM attachments) AS attachments') }, { conversations: 0, threads: 0, attachments: 0 }, 'all message rows roll back together')
    assert.equal(get<{ state: string }>('SELECT state FROM inbound_ingests')!.state, 'started', 'completion rolls back with the rows')
    ws.tenant.db.exec('DROP TRIGGER reject_attachment')
    const results = await Promise.all([ingestInbound(ws.mailboxId, raw), ingestInbound(ws.mailboxId, raw)])
    assert.deepEqual(results.sort(), ['accepted', 'duplicate'])
    assert.deepEqual({ ...get<Record<string, number>>('SELECT (SELECT COUNT(*) FROM conversations) AS conversations, (SELECT COUNT(*) FROM threads) AS threads, (SELECT COUNT(*) FROM attachments) AS attachments') }, { conversations: 1, threads: 1, attachments: 2 }, 'concurrent retries commit one message with both files')
  })
})

test('restart requeues a reply interrupted before its provider attempt', async () => {
  const ws = managedInstall()
  await ws.inside(async () => {
    const conversation = createConversation({ mailboxId: ws.mailboxId, customerEmail: 'cara@customer.test', subject: 'Help', bodyHtml: '<p>Help</p>', kind: 'customer' }, { userId: null, via: 'email' })
    const id = addReply(conversation.id, { bodyHtml: '<p>Ready to send</p>', skipDelivery: true }, { userId: 1, via: 'web' })
    run(`UPDATE threads SET state = 'sending', attempt_id = NULL, error = 'interrupted', retry_at = NULL WHERE id = ?`, id)
    prepareData()
    assert.equal(threadRow(id).state, 'queued')
    assert.equal(threadRow(id).error, null)
    assert.ok(threadRow(id).retry_at! <= Date.now(), 'the reply is due immediately')
    await dispatchQueued()
    assert.equal(threadRow(id).state, 'sent', 'automatic delivery sends a reply that never reached the provider')
    assert.equal(ws.control.fallback.length, 1)
  })
})

for (const messageId of ['<expired@customer.test>', undefined]) {
  test(`abandoned inbound ${messageId ? 'with' : 'without'} Message-ID loses its blobs and retries cleanly`, async () => {
    const ws = managedInstall()
    await ws.inside(async () => {
      const raw = inboundWithFiles(messageId)
      const oldNow = Date.now
      Date.now = () => oldNow() - 3 * 86_400_000
      ws.tenant.db.exec(`CREATE TRIGGER reject_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'attachment row unavailable'); END`)
      try {
        await assert.rejects(ingestInbound(ws.mailboxId, raw), /attachment row unavailable/)
      } finally {
        Date.now = oldNow
        ws.tenant.db.exec('DROP TRIGGER reject_attachment')
      }
      const keys = all<{ storage_key: string }>('SELECT storage_key FROM inbound_ingest_files').map((file) => file.storage_key)
      assert.equal(keys.length, 2)
      for (const key of keys) assert.ok(await ws.tenant.blobs.get(key), 'failed filing leaves a tracked blob')
      const store = ws.tenant.blobs
      ws.tenant.blobs = { ...store, remove: async () => { throw new Error('delete unavailable') } }
      await assert.rejects(pruneInboundIngests(), /delete unavailable/)
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM inbound_ingests')!.n, 1, 'failed blob removal retains the row for another sweep')
      ws.tenant.blobs = store
      await pruneInboundIngests()
      for (const key of keys) assert.equal(await store.get(key), null, 'the abandoned blob is removed')
      assert.equal(nextIngestCleanupAt(), null, 'the abandoned row and file tracking are removed')
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM inbound_ingest_files')!.n, 0)
      assert.equal(await ingestInbound(ws.mailboxId, raw), 'accepted', 'the retry starts from a fresh ingest')
      assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments')!.n, 2)
      for (const file of all<{ storage_key: string }>('SELECT storage_key FROM attachments')) assert.ok(await store.get(file.storage_key))
    })
  })
}

test('an already-filed skip discards blobs from an earlier failed delivery', async () => {
  const ws = managedInstall()
  await ws.inside(async () => {
    const raw = inboundWithFiles('<already-filed@customer.test>')
    ws.tenant.db.exec(`CREATE TRIGGER reject_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'attachment row unavailable'); END`)
    await assert.rejects(ingestInbound(ws.mailboxId, raw), /attachment row unavailable/)
    ws.tenant.db.exec('DROP TRIGGER reject_attachment')
    const keys = all<{ storage_key: string }>('SELECT storage_key FROM inbound_ingest_files').map((file) => file.storage_key)
    const { ingestRaw } = await import('../mail/ingest.ts')
    await ingestRaw(ws.mailboxId, raw)
    const store = ws.tenant.blobs
    ws.tenant.blobs = { ...store, remove: async () => { throw new Error('delete unavailable') } }
    await assert.rejects(ingestInbound(ws.mailboxId, raw), /delete unavailable/)
    ws.tenant.blobs = store
    assert.equal(await ingestInbound(ws.mailboxId, raw), 'duplicate', 'a completed skip retries failed blob cleanup')
    for (const key of keys) assert.equal(await ws.tenant.blobs.get(key), null, 'skipped hash-keyed files are removed')
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM threads')!.n, 1)
    for (const file of all<{ storage_key: string }>('SELECT storage_key FROM attachments')) assert.ok(await ws.tenant.blobs.get(file.storage_key), 'the filed attachment survives')
  })
})

test('completed inbound deduplication lasts 180 days and pruning preserves filed attachments', async () => {
  const ws = managedInstall()
  await ws.inside(async () => {
    const raw = inboundWithFiles()
    const started = Date.now()
    assert.equal(await ingestInbound(ws.mailboxId, raw), 'accepted')
    const oldNow = Date.now
    try {
      Date.now = () => started + 61 * 86_400_000
      await pruneInboundIngests()
      assert.equal(await ingestInbound(ws.mailboxId, raw), 'duplicate', 'deduplication survives beyond 60 days')
      Date.now = () => started + 179 * 86_400_000
      await pruneInboundIngests()
      assert.equal(await ingestInbound(ws.mailboxId, raw), 'duplicate', 'deduplication survives until 180 days')
      Date.now = () => started + 181 * 86_400_000
      await pruneInboundIngests()
      assert.equal(await ingestInbound(ws.mailboxId, raw), 'accepted', 'a Message-ID-less duplicate can file after retention expires')
      for (const file of all<{ storage_key: string }>('SELECT storage_key FROM attachments')) assert.ok(await ws.tenant.blobs.get(file.storage_key), 'retention never deletes filed blobs')
    } finally {
      Date.now = oldNow
    }
  })
})

test('provider acceptance followed by restart leaves a reply uncertain until a confirmed resend', async () => {
  const ws = managedInstall()
  let accept = () => {}
  const accepted = new Promise<void>((resolve) => { accept = resolve })
  let attemptId: string | null = null
  let threadId = 0
  let rawAccepted = ''
  let acceptedThread: { state: string; attempt_id: string | null; message_id: string } | undefined
  ws.control.sendFallback = async (_workspaceId, message) => {
    rawAccepted = Buffer.from(message.raw).toString('utf8')
    acceptedThread = get('SELECT * FROM threads WHERE id = ?', threadId)
    attemptId = acceptedThread?.attempt_id ?? null
    accept()
    return new Promise(() => {})
  }
  ws.inside(() => {
    const conversation = createConversation({ mailboxId: ws.mailboxId, customerEmail: 'cara@customer.test', subject: 'Help', bodyHtml: '<p>Help</p>', kind: 'customer' }, { userId: null, via: 'email' })
    threadId = addReply(conversation.id, { bodyHtml: '<p>Already accepted</p>' }, { userId: 1, via: 'web' })
  })
  await accepted
  assert.equal(acceptedThread?.state, 'sending', 'sending is durable before provider acceptance')
  assert.ok(attemptId, 'the provider attempt is durable before acceptance')
  assert.equal(attemptId, acceptedThread?.message_id, 'the attempt id is the outbound Message-ID')
  assert.ok(attemptId && rawAccepted.includes(`Message-ID: ${attemptId}`), 'the accepted MIME identifies the recorded attempt')
  const restarted = openNodeTenant(readConfig((key) => ({ DATA_DIR: ws.dataDir, ANSA_HOSTED: '1' })[key]))
  const control = fakeControl()
  restarted.control = control
  await runInTenant(restarted, async () => {
    prepareData()
    const uncertain = threadRow(threadId)
    assert.equal(uncertain.state, 'uncertain', 'a restart cannot call an accepted message failed')
    assert.match(uncertain.error ?? '', /may have been delivered/i)
    assert.equal(uncertain.retry_at, null)
    await dispatchQueued()
    assert.equal(nextRetryAt(), null)
    assert.equal(control.fallback.length, 0, 'automatic retries do not send uncertain replies')
    assert.throws(() => retryDelivery(threadId, { userId: 1, via: 'web' }), /Confirm/, 'a manual resend requires confirmation')
    assert.equal(threadRow(threadId).state, 'uncertain')
    retryDelivery(threadId, { userId: 1, via: 'web' }, true)
    await until(() => threadRow(threadId), (thread) => thread.state === 'sent', 'the confirmed resend')
    assert.equal(control.fallback.length, 1)
    assert.ok(control.fallback[0].raw.includes(`Message-ID: ${attemptId}`), 'the confirmed resend keeps the recognised Message-ID')
  })
})


test('bounces match reply recipients in To, Cc, and Bcc', () => {
  const ws = managedInstall()
  ws.inside(() => {
    const conversation = createConversation({ mailboxId: ws.mailboxId, customerEmail: 'cara@customer.test', subject: 'Help', bodyHtml: '<p>Help</p>', kind: 'customer' }, { userId: null, via: 'email' })
    const threadId = addReply(conversation.id, { bodyHtml: '<p>Answer</p>', cc: ['copy@customer.test'], bcc: ['hidden@customer.test'], skipDelivery: true }, { userId: 1, via: 'web' })
    const { message_id: messageId } = get<{ message_id: string }>('SELECT message_id FROM threads WHERE id = ?', threadId)!
    noteBounce({ messageId, recipient: 'other@customer.test', kind: 'hard', reason: 'unrelated' })
    assert.equal(threadRow(threadId).state, 'sent', 'a non-recipient cannot fail the reply')
    for (const recipient of ['Cara <CARA@customer.test>', 'copy@customer.test', 'hidden@customer.test']) {
      run(`UPDATE threads SET state = 'sent', error = NULL WHERE id = ?`, threadId)
      noteBounce({ messageId, recipient, kind: 'hard', reason: '550 missing' })
      assert.equal(threadRow(threadId).state, 'failed', `${recipient} is a recipient of this reply`)
    }
  })
})
