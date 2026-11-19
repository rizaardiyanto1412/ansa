import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { startSmtpCatcher } from '../../server/test/smtp-catcher.ts'
import { readZip } from '../../server/test/zip-reader.ts'

const HOST = 'http://mail.example.test'
const configPath = fileURLToPath(new URL('./wrangler.hosted.jsonc', import.meta.url))
const harness = createTestHarness({ workers: [{ configPath }] })
const catcher = await startSmtpCatcher()

before(() => harness.listen().then(() => {}))
after(async () => {
  await harness.close()
  await catcher.close()
})

interface Bucket {
  put(key: string, value: string): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  list(options: { prefix: string }): Promise<{ objects: { key: string }[] }>
}
const bucket = async () => (await harness.getWorker<{ ATTACHMENTS: Bucket }>().getEnv()).ATTACHMENTS

let session = ''

async function call(method: string, path: string, body?: unknown) {
  const response = await harness.fetch(`${HOST}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ansa', ...(session ? { Cookie: session } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    assert.fail(`${method} ${path} answered ${response.status}: ${text}`)
  }
  return { status: response.status, data, cookie: response.headers.getSetCookie().find((line) => /ansa_session=[^;]+/.test(line)) ?? '' }
}

const rpc = async (method: string, input: unknown = null) => (await call('POST', `/__rpc/${method}`, input)).data as { result?: any; error?: { name: string; message: string } }
const sql = async <T = Record<string, any>>(query: string, ...params: (string | number | null)[]) => (await call('POST', '/__sql', { sql: query, params })).data as T[]
const controlCalls = async (method: string) => ((await call('GET', '/__control')).data as { method: string; args: any[] }[]).filter((entry) => entry.method === method).map((entry) => entry.args)
const script = (change: Record<string, unknown>) => call('POST', '/__control', change)
const tick = async () => (await call('GET', '/__tick')).data.alarm as number | null
const nextAlarm = async () => (await call('GET', '/__next-alarm')).data.alarm as number | null
const mailbox = async (id: number) => ((await call('GET', '/api/mailboxes')).data.mailboxes as any[]).find((m) => m.id === id)

const plan = { plan: 'trial', mailboxLimit: 2, readOnly: false, hourlySendLimit: 100, trialEndsAt: Date.now() + 14 * 86_400_000 }
const eml = (headers: Record<string, string>, body: string) =>
  [...Object.entries({ 'MIME-Version': '1.0', 'Content-Type': 'text/plain; charset=utf-8', ...headers }).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n')

async function settled(threadId: number) {
  for (let i = 0; i < 300; i++) {
    const [thread] = await sql<{ state: string; error: string | null; retry_at: number | null; attempts: number; message_id: string; provider_id: string | null }>(
      'SELECT state, error, retry_at, attempts, message_id, provider_id FROM threads WHERE id = ?',
      threadId,
    )
    if (thread.state !== 'sending') return thread
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return assert.fail(`thread ${threadId} is still sending`)
}

async function reply(conversationId: number, text: string) {
  const sent = await call('POST', `/api/conversations/${conversationId}/reply`, { bodyHtml: `<p>${text}</p>`, status: 'active' })
  assert.equal(sent.status, 201, JSON.stringify(sent.data))
  return { id: sent.data.threadId as number, ...(await settled(sent.data.threadId)) }
}

let supportId = 0
let conversationId = 0

test('a managed mailbox gets an inbound address, and the plan limits how many mailboxes exist', async () => {
  const provisioned = await rpc('provision', {
    workspaceId: 'mail',
    workspaceName: 'Acme Support',
    appUrl: 'https://mail.hosted.test',
    admin: { name: 'Ada', email: 'ada@acme.test' },
    smtp: { host: '127.0.0.1', port: catcher.port, security: 'starttls', user: 'tenant-mail', pass: 'tenant-smtp-secret' },
    planState: plan,
  })
  const token = /\/link#([\w-]+)/.exec(provisioned.result?.signInUrl ?? '')?.[1] ?? assert.fail(JSON.stringify(provisioned))
  session = (await call('POST', '/api/links/consume', { token, password: 'correct horse 1' })).cookie.split(';')[0]
  assert.ok(session, 'the admin is signed in')

  const reports = await controlCalls('reportHealth')
  assert.equal(reports.length, 1, 'provision reports health to the control plane once')
  assert.deepEqual({ users: reports[0][0].users, mailboxes: reports[0][0].mailboxes, version: typeof reports[0][0].coreVersion }, { users: 1, mailboxes: 0, version: 'string' })
  assert.ok(reports[0][0].schemaVersion >= 9, `schema version ${reports[0][0].schemaVersion}`)

  const created = await call('POST', '/api/mailboxes', { name: 'Support', email: 'Support@Acme.test', smtpHost: 'ignored.example', imapHost: 'ignored.example' })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  supportId = created.data.mailbox.id
  assert.deepEqual(
    { kind: created.data.mailbox.kind, address: created.data.mailbox.managed.inboundAddress, receiving: created.data.mailbox.receiving, sending: created.data.mailbox.managed.sendingStatus, smtp: created.data.mailbox.smtpHost, imap: created.data.mailbox.imapHost },
    { kind: 'managed', address: `mail-m${supportId}@in.hosted.test`, receiving: false, sending: 'none', smtp: '', imap: '' },
    'a new hosted mailbox is managed by default and has no mail server settings',
  )
  assert.deepEqual(await controlCalls('createInboundAddress'), [[supportId]], 'the control plane handed out the address')

  const advanced = await call('POST', '/api/mailboxes', { kind: 'imap', name: 'Billing', email: 'billing@acme.test', smtpHost: 'smtp.acme.test', imapEnabled: false })
  assert.deepEqual([advanced.status, advanced.data.mailbox?.kind, advanced.data.mailbox?.smtpHost], [201, 'imap', 'smtp.acme.test'], 'IMAP and SMTP stay available')

  const over = await call('POST', '/api/mailboxes', { name: 'Sales', email: 'sales@acme.test' })
  assert.deepEqual([over.status, over.data.code], [402, 'PlanLimit'], 'a third mailbox is over the limit of two')
  assert.match(over.data.error, /Your trial includes 2 mailboxes, and this workspace has 2\. Upgrade in Settings → Billing/)
  assert.equal((await controlCalls('createInboundAddress')).length, 1, 'no address is handed out for a refused mailbox')

  assert.equal((await call('DELETE', `/api/mailboxes/${advanced.data.mailbox.id}`)).status, 200)
  assert.deepEqual(await controlCalls('deleteInboundAddress'), [], 'an IMAP mailbox has no inbound address to release')
  const sales = await call('POST', '/api/mailboxes', { name: 'Sales', email: 'sales@acme.test' })
  assert.equal(sales.status, 201, 'there is room again')
  assert.equal((await call('DELETE', `/api/mailboxes/${sales.data.mailbox.id}`)).status, 200)
  assert.deepEqual(await controlCalls('deleteInboundAddress'), [[sales.data.mailbox.id]], 'deleting a managed mailbox releases its address')
  assert.equal((await rpc('health')).result.mailboxes, 1)
  const counts = (await controlCalls('reportHealth')).map(([health]) => health.mailboxes)
  assert.equal(counts[counts.length - 1], 1, 'the control plane hears the mailbox count change')

  const billing = await call('GET', '/api/billing')
  assert.equal(billing.data.plan.trialEndsAt, plan.trialEndsAt, 'billing receives the control-plane trial deadline in epoch milliseconds')
  assert.deepEqual([billing.status, billing.data.plan.plan, billing.data.mailboxes, billing.data.links.portal], [200, 'trial', 1, 'https://pay.hosted.test/portal'], 'billing shows the plan, the usage and the links')
})

test('inbound mail is filed once, with or without a Message-ID', async () => {
  const confirmation = eml(
    { From: 'Gmail Team <forwarding-noreply@google.com>', To: `mail-m${supportId}@in.hosted.test`, Subject: '(#482913077) Gmail Forwarding Confirmation - Receive Mail from support@acme.test', 'Message-ID': '<confirm-1@google.com>' },
    'support@acme.test has requested to automatically forward mail to your email address.\nConfirmation code: 482913077\n\nhttps://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-xyz\n',
  )
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: confirmation })).result, 'accepted')
  const waiting = await mailbox(supportId)
  assert.deepEqual(
    [waiting.receiving, waiting.managed.forwardingConfirmation.code, waiting.managed.forwardingConfirmation.link],
    [false, '482913077', 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-xyz'],
    "Gmail's confirmation shows its code and link, and does not count as the first email",
  )

  const first = eml({ From: 'Cara <cara@customer.test>', To: 'support@acme.test', Subject: 'Where is my order', 'Message-ID': '<order-1@customer.test>' }, 'Hello?')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: first })).result, 'accepted')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: first })).result, 'duplicate', 'the same Message-ID is not filed twice')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: first.replace('Hello?', 'Hello again?') })).result, 'duplicate', 'the Message-ID decides, not the bytes')
  assert.equal((await mailbox(supportId)).receiving, true, 'the first real email means forwarding works')

  const bare = eml({ From: 'Dan <dan@customer.test>', To: 'support@acme.test', Subject: 'No id' }, 'I have no Message-ID')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: bare })).result, 'accepted')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: bare })).result, 'duplicate', 'without a Message-ID the bytes decide')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: bare.replace('I have', 'I still have') })).result, 'accepted', 'other bytes are another message')

  await (await bucket()).put('inbound/mail/large-1', eml({ From: 'Eve <eve@customer.test>', To: 'support@acme.test', Subject: 'From R2', 'Message-ID': '<r2-1@customer.test>' }, 'Stored first'))
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, r2Key: 'inbound/mail/large-1' })).result, 'accepted', 'a large message is read from R2')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, r2Key: 'inbound/mail/large-1' })).result, 'duplicate')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, r2Key: 'inbound/mail/missing' })).error?.name, 'NotFound')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, r2Key: 'ws/other/secret' })).error?.name, 'Invalid', "another workspace's objects are out of reach")
  assert.equal((await rpc('ingestInbound', { mailboxId: 999, raw: first })).error?.name, 'NotFound', 'an unknown mailbox is an error, so the sender retries')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId })).error?.name, 'Invalid')

  const subjects = (await sql<{ subject: string }>('SELECT subject FROM conversations ORDER BY id')).map((row) => row.subject)
  assert.deepEqual(subjects, ['(#482913077) Gmail Forwarding Confirmation - Receive Mail from support@acme.test', 'Where is my order', 'No id', 'No id', 'From R2'])
  conversationId = (await sql<{ id: number }>(`SELECT id FROM conversations WHERE subject = 'Where is my order'`))[0].id
})

test('inbound R2 keys are restricted to the owning workspace', async () => {
  const first = eml({ From: 'Cara <cara@customer.test>', To: 'support@acme.test', 'Message-ID': '<order-1@customer.test>' }, 'Hello?')
  for (const key of ['inbound/other/secret', 'inbound/mailroom/secret', 'inbound/unscoped']) {
    await (await bucket()).put(key, first.replace('<order-1@customer.test>', `<${key}@customer.test>`))
    assert.equal((await rpc('ingestInbound', { mailboxId: supportId, r2Key: key })).error?.name, 'Invalid', `${key} cannot be read by this workspace`)
  }
  await (await bucket()).put('ws/mail/raw/message', first)
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, r2Key: 'ws/mail/raw/message' })).result, 'duplicate', 'the workspace can read its own prefix')
})

test('replies go through the fallback until the domain verifies, then through the tenant SMTP server', async () => {
  const before = await reply(conversationId, 'Sent before any domain')
  assert.equal(before.state, 'sent', before.error ?? '')
  const [[fallback]] = await controlCalls('sendFallback')
  assert.deepEqual([fallback.mailboxId, fallback.from, fallback.to], [supportId, '"Support" <support@acme.test>', ['cara@customer.test']], 'an unverified mailbox hands the raw message to the control plane')
  assert.match(fallback.raw, /Subject: Re: Where is my order/)
  assert.match(fallback.raw, /Sent before any domain/)
  assert.match(fallback.raw, new RegExp(`Message-ID: ${before.message_id.replace(/[.<>@]/g, '\\$&')}`, 'i'), 'the raw message carries the thread id')
  assert.match(before.provider_id ?? '', /^fallback-/, 'the id the control plane returned is kept for bounces')
  assert.equal(catcher.connections(), 0, 'the tenant SMTP server was not used')

  const added = await call('POST', `/api/mailboxes/${supportId}/sending-domain`)
  assert.equal(added.status, 200, JSON.stringify(added.data))
  assert.deepEqual([added.data.mailbox.managed.sendingDomain, added.data.mailbox.managed.sendingStatus, added.data.mailbox.managed.sendingRecords.length], ['acme.test', 'pending', 2])
  assert.deepEqual(await controlCalls('addSendingDomain'), [[supportId, 'acme.test']], "the domain is the one in the mailbox's address")
  const recheck = await nextAlarm()
  assert.equal(recheck, null, 'pending sending domains never schedule an object alarm')

  const pending = await reply(conversationId, 'Sent while DNS is pending')
  assert.equal(pending.state, 'sent')
  assert.equal((await controlCalls('sendFallback')).length, 2, 'a pending domain still uses the fallback')

  const checked = await call('POST', `/api/mailboxes/${supportId}/sending-domain/check`)
  assert.equal(checked.data.mailbox.managed.sendingStatus, 'pending', 'Check now asks the control plane')
  await script({ domain: 'verified' })
  await sql('UPDATE mailboxes SET sending_checked_at = sending_checked_at - ? WHERE id = ?', 11 * 60_000, supportId)
  await tick()
  assert.equal((await mailbox(supportId)).managed.sendingStatus, 'pending', 'the object alarm leaves scheduled domain checks to the control plane')
  assert.equal((await controlCalls('checkSendingDomain')).length, 1, 'only Check now called the control plane')
  assert.equal((await rpc('setSendingDomain', { mailboxId: supportId, domain: 'acme.test', status: 'verified', records: [] })).error, undefined)
  assert.equal((await mailbox(supportId)).managed.sendingStatus, 'verified', 'the control plane pushes the verified status')

  catcher.script.greeting = '451 4.7.1 Hourly cap reached, try again later'
  const verified = await reply(conversationId, 'Sent as our own domain')
  assert.equal(catcher.connections(), 1, 'a verified mailbox connects to the tenant SMTP server')
  assert.equal((await controlCalls('sendFallback')).length, 2, 'and no longer uses the fallback')
  assert.deepEqual([verified.state, verified.attempts], ['queued', 1], `a 451 queues the reply for another try: ${verified.error}`)
  assert.match(verified.error ?? '', /try again later.*451 4\.7\.1 Hourly cap reached/)
  assert.ok(verified.retry_at! > Date.now() + 40_000 && verified.retry_at! < Date.now() + 70_000, 'the retry is a minute away')
  const wake = await nextAlarm()
  assert.ok(wake !== null && wake <= verified.retry_at! + 1000, 'the alarm is set for the retry')
  const lines = (await call('GET', '/__logs')).data as string[]
  assert.ok(lines.includes(`[ws mail] [mail] thread ${verified.id} will be sent again later: Invalid greeting. response=451 4.7.1 Hourly cap reached, try again later: 451 4.7.1 Hourly cap reached, try again later`), `the log line names the workspace: ${lines.filter((line) => line.includes('[mail]')).join(' | ')}`)
  assert.ok(lines.every((line) => line.startsWith('[ws mail] ') || !line.includes('[mail]')), 'no mail log line is without its workspace')

  const pushed = await rpc('setSendingDomain', { mailboxId: supportId, domain: 'acme.test', status: 'failed', records: [] })
  assert.equal(pushed.error, undefined, JSON.stringify(pushed))
  assert.equal((await mailbox(supportId)).managed.sendingStatus, 'failed', 'the control plane can push a status')
  await sql('UPDATE threads SET retry_at = ? WHERE id = ?', Date.now() - 1, verified.id)
  await tick()
  const retried = await settled(verified.id)
  assert.equal(retried.state, 'sent', `the alarm sends the queued reply: ${retried.error}`)
  assert.equal((await controlCalls('sendFallback')).length, 3, 'through the fallback, because the domain is no longer verified')
  assert.equal((await rpc('setSendingDomain', { mailboxId: 999, domain: 'acme.test', status: 'verified', records: [] })).error?.name, 'NotFound')
})

test('a rate-limited fallback and a full hour both queue the reply instead of failing it', async () => {
  const retryAt = Date.now() + 2 * 3_600_000
  await script({ fallback: 'rate-limited', retryAt })
  const limited = await reply(conversationId, 'Over the fallback cap')
  assert.deepEqual([limited.state, limited.attempts], ['queued', 0], `RateLimited queues the reply: ${limited.error}`)
  assert.match(limited.error ?? '', /limited each hour\. Verify the sending domain/)
  assert.equal(limited.retry_at, retryAt, 'it waits until the time the control plane named')
  await script({ fallback: 'ok' })
  await sql('UPDATE threads SET retry_at = ? WHERE id = ?', Date.now() - 1, limited.id)
  await tick()
  assert.equal((await settled(limited.id)).state, 'sent', 'and goes out when the cap allows')

  const used = (await sql<{ n: number }>('SELECT COUNT(*) AS n FROM outbound_log'))[0].n
  assert.equal(used, 4, 'every delivered reply counts toward the hour, and the refused attempts do not')
  assert.equal((await rpc('setPlan', { ...plan, hourlySendLimit: used + 1 })).error, undefined)
  assert.equal((await reply(conversationId, 'The last one this hour')).state, 'sent')
  const held = await reply(conversationId, 'One too many')
  assert.deepEqual([held.state, held.attempts, held.error], ['queued', 0, 'This workspace reached its hourly sending limit.'])
  const oldest = (await sql<{ at: number }>('SELECT MIN(sent_at) AS at FROM outbound_log'))[0].at
  assert.equal(held.retry_at, oldest + 3_600_000, 'it waits until the oldest send leaves the hour')
  const sends = (await controlCalls('sendFallback')).length
  await tick()
  assert.equal((await settled(held.id)).state, 'queued', 'the alarm does not send it early')
  assert.equal((await controlCalls('sendFallback')).length, sends)

  assert.equal((await rpc('setPlan', plan)).error, undefined)
  await tick()
  assert.equal((await settled(held.id)).state, 'sent', 'a higher limit releases it at once')
})

test('a read-only workspace receives mail but does not send', async () => {
  assert.equal((await rpc('setPlan', { ...plan, readOnly: true })).error, undefined)
  assert.equal((await call('GET', '/api/bootstrap')).data.plan.readOnly, true, 'the browser knows, and shows the banner')
  const refused = await call('POST', `/api/conversations/${conversationId}/reply`, { bodyHtml: '<p>Not now</p>' })
  assert.deepEqual([refused.status, refused.data.code], [403, 'ReadOnly'])
  assert.match(refused.data.error, /read-only, so replies are not sent\. Choose a plan in Settings → Billing/, 'the refusal says why')
  const incoming = eml({ From: 'Cara <cara@customer.test>', To: 'support@acme.test', Subject: 'Re: Where is my order', 'Message-ID': '<order-2@customer.test>', 'In-Reply-To': '<order-1@customer.test>' }, 'Still waiting')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: incoming })).result, 'accepted', 'inbound mail still arrives')
  assert.equal((await call('GET', `/api/conversations/${conversationId}`)).status, 200, 'and everything stays readable')
  assert.equal((await rpc('setPlan', plan)).error, undefined)
  assert.equal((await reply(conversationId, 'Back in business')).state, 'sent')
})

test('a failed inbound transaction stays resumable in workerd', async () => {
  const raw = ['From: Cara <cara@customer.test>', 'To: support@acme.test', 'Subject: Atomic inbound', 'Message-ID: <atomic@customer.test>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', 'See attached', '--b', 'Content-Type: text/plain; name=atomic.txt', 'Content-Disposition: attachment; filename=atomic.txt', '', 'durable file', '--b--', ''].join('\r\n')
  await sql(`CREATE TRIGGER reject_attachment BEFORE INSERT ON attachments WHEN NEW.filename = 'atomic.txt' BEGIN SELECT RAISE(ABORT, 'attachment row unavailable'); END`)
  const failed = await rpc('ingestInbound', { mailboxId: supportId, raw })
  assert.match(failed.error?.message ?? '', /attachment row unavailable/)
  assert.deepEqual(await sql(`SELECT subject FROM conversations WHERE subject = 'Atomic inbound'`), [], 'a failed attachment row rolls back the conversation')
  assert.deepEqual(await sql(`SELECT id FROM threads WHERE message_id = '<atomic@customer.test>'`), [], 'a failed attachment row rolls back the thread')
  assert.deepEqual(await sql(`SELECT state FROM inbound_ingests WHERE key = 'id:<atomic@customer.test>'`), [{ state: 'started' }], 'a failed transaction rolls back completion')
  await sql('DROP TRIGGER reject_attachment')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw })).result, 'accepted')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw })).result, 'duplicate')
  assert.deepEqual(await sql(`SELECT COUNT(*) AS n FROM conversations WHERE subject = 'Atomic inbound'`), [{ n: 1 }], 'the retry creates exactly one conversation')
})

test('the retry API requires explicit confirmation for an uncertain reply', async () => {
  const sent = await reply(conversationId, 'May already be delivered')
  await sql(`UPDATE threads SET state = 'uncertain', attempt_id = message_id WHERE id = ?`, sent.id)
  const before = (await controlCalls('sendFallback')).length
  for (const body of [undefined, { confirm: false }, { confirm: 'true' }]) {
    const denied = await call('POST', `/api/threads/${sent.id}/retry`, body)
    assert.equal(denied.status, 409, 'only boolean confirmation authorizes another delivery')
    assert.equal((await settled(sent.id)).state, 'uncertain')
  }
  assert.equal((await controlCalls('sendFallback')).length, before, 'unconfirmed requests send nothing')
  assert.equal((await call('POST', `/api/threads/${sent.id}/retry`, { confirm: true })).status, 200)
  const resent = await settled(sent.id)
  assert.equal(resent.state, 'sent')
  assert.equal(resent.message_id, sent.message_id, 'the confirmed resend preserves Message-ID')
  assert.equal((await controlCalls('sendFallback')).length, before + 1)
})

test('a hard bounce marks the sent reply failed', async () => {
  const [sent] = await sql<{ id: number; message_id: string; provider_id: string }>(`SELECT id, message_id, provider_id FROM threads WHERE type = 'reply' AND state = 'sent' ORDER BY id LIMIT 1`)
  assert.equal((await rpc('noteBounce', { messageId: '<nobody-sent-this@acme.test>', recipient: 'cara@customer.test', kind: 'hard', reason: 'unknown' })).error, undefined, 'an unknown message is ignored')
  assert.equal((await rpc('noteBounce', { messageId: sent.message_id, recipient: 'stranger@customer.test', kind: 'hard', reason: '550 unrelated recipient' })).error, undefined)
  assert.equal((await settled(sent.id)).state, 'sent', 'a bounce for someone outside the reply recipients does not fail it')
  assert.equal((await rpc('noteBounce', { messageId: sent.message_id, recipient: 'cara@customer.test', kind: 'complaint', reason: 'abuse' })).error, undefined)
  assert.equal((await settled(sent.id)).state, 'sent', 'a spam complaint does not mean the reply was lost')
  assert.equal((await rpc('noteBounce', { messageId: sent.message_id.replace(/^<|>$/g, ''), recipient: 'cara@customer.test', kind: 'hard', reason: '550 5.1.1 The email account does not exist' })).error, undefined)
  const bounced = await settled(sent.id)
  assert.equal(bounced.state, 'failed')
  assert.equal(bounced.error, 'cara@customer.test did not get this reply. Their mail server refused it: "550 5.1.1 The email account does not exist"')

  const [other] = await sql<{ id: number; provider_id: string }>(`SELECT id, provider_id FROM threads WHERE type = 'reply' AND state = 'sent' AND provider_id IS NOT NULL ORDER BY id LIMIT 1`)
  assert.equal((await rpc('noteBounce', { messageId: other.provider_id, recipient: 'cara@customer.test', kind: 'hard', reason: '' })).error, undefined)
  assert.equal((await settled(other.id)).state, 'failed', "the control plane's own message id matches too")
  assert.equal((await rpc('noteBounce', { messageId: '', recipient: 'x', kind: 'soft', reason: '' })).error?.name, 'Invalid')
})

test('an export is a zip in R2 without secrets, and hosted delete keeps files for the control-plane grace period', async () => {
  const withFile = ['From: Cara <cara@customer.test>', 'To: support@acme.test', 'Subject: A file', 'Message-ID: <file-1@customer.test>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', 'See attached', '--b', 'Content-Type: text/plain; name=notes.txt', 'Content-Disposition: attachment; filename=notes.txt', '', 'file body here', '--b--', ''].join('\r\n')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: withFile })).result, 'accepted')
  const token = await call('POST', '/api/tokens', { name: 'CI' })
  assert.equal(token.status, 201)

  const exported = await rpc('exportWorkspace')
  assert.match(exported.result?.r2Key ?? JSON.stringify(exported), /^ws\/mail\/exports\/[\w-]+\.zip$/, "the export is stored under the workspace's own prefix")
  const store = await bucket()
  const archive = await store.get(exported.result.r2Key)
  assert.ok(archive, 'the archive is in R2')
  const files = readZip(new Uint8Array(await archive.arrayBuffer()))
  const names = files.map((file) => file.name)
  for (const name of ['README.txt', 'sql/users.sql', 'sql/mailboxes.sql', 'sql/conversations.sql', 'sql/threads.sql', 'sql/settings.sql']) assert.ok(names.includes(name), `${name} is in the export`)
  for (const table of ['sessions', 'api_tokens', 'one_time_links', 'attempts', '_cf_KV', '_cf_METADATA', 'search']) assert.ok(!names.includes(`sql/${table}.sql`), `sql/${table}.sql is left out`)
  const attachment = files.find((file) => /^attachments\/\d+\/notes\.txt$/.test(file.name))
  assert.equal(attachment?.data.toString().trim(), 'file body here', 'attachments come out of R2 into the archive')
  const everything = Buffer.concat(files.map((file) => file.data)).toString('latin1')
  assert.match(everything, /Where is my order/)
  const [user] = await sql<{ password_hash: string }>('SELECT password_hash FROM users')
  const [apiToken] = await sql<{ token_hash: string }>('SELECT token_hash FROM api_tokens')
  const [hosted] = await sql<{ value: string }>(`SELECT value FROM settings WHERE key = 'hosted'`)
  const secrets = { passwordHash: user.password_hash, tokenHash: apiToken.token_hash, apiToken: token.data.secret, sessionId: session.split('=')[1], tenantPassword: JSON.parse(hosted.value).smtp.passEnc, tenantUser: 'tenant-mail' }
  for (const [name, value] of Object.entries(secrets)) assert.ok(value.length > 5 && !everything.includes(value), `the export does not contain the ${name}`)

  const download = await harness.fetch(`${HOST}/api/workspace/export`, { headers: { Cookie: session } })
  assert.deepEqual([download.status, download.headers.get('content-type')], [200, 'application/zip'], 'an admin can download the same archive from Settings')
  assert.deepEqual(readZip(new Uint8Array(await download.arrayBuffer())).map((file) => file.name), names)

  assert.ok((await store.list({ prefix: 'ws/mail/' })).objects.length >= 2, 'the workspace has objects in R2 before it is deleted')
  const retained = (await store.list({ prefix: 'ws/mail/' })).objects.map((object) => object.key)
  await store.put('ws/mailroom/keep.txt', 'another workspace')
  assert.equal((await rpc('deleteWorkspace')).error, undefined)
  assert.deepEqual((await store.list({ prefix: 'ws/mail/' })).objects.map((object) => object.key), retained, 'hosted deletion retains R2 objects for seven-day cleanup by the control plane')
  assert.ok(await store.get(exported.result.r2Key), 'the exported archive survives workspace deletion')
  assert.equal((await store.list({ prefix: 'ws/mailroom/' })).objects.length, 1, 'a workspace whose id only starts the same keeps its files')
  assert.deepEqual(await sql('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM mailboxes) AS mailboxes, (SELECT COUNT(*) FROM conversations) AS conversations, (SELECT COUNT(*) FROM threads) AS threads, (SELECT COUNT(*) FROM settings) AS settings, (SELECT COUNT(*) FROM sessions) AS sessions'), [
    { users: 0, mailboxes: 0, conversations: 0, threads: 0, settings: 0, sessions: 0 },
  ])
  assert.equal(await nextAlarm(), null, 'no alarm is left')
  const boot = (await call('GET', '/api/bootstrap')).data
  assert.deepEqual([boot.user, boot.plan, boot.workspace.name], [null, null, ''], 'the session and the workspace are gone')
  assert.equal((await rpc('setPlan', plan)).error?.name, 'NotProvisioned')
  assert.equal((await rpc('ingestInbound', { mailboxId: supportId, raw: withFile })).error?.name, 'NotProvisioned', 'mail for a deleted workspace is refused')
  const blob = await harness.fetch(`${HOST}/__blob`, { method: 'PUT', body: 'late' })
  assert.match(await blob.text(), /NotProvisioned/, 'attachments have no home any more')
  assert.equal((await rpc('deleteWorkspace')).error, undefined, 'deleting twice is fine')
})
