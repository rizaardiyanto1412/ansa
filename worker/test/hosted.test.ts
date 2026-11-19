import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'

const APP_URL = 'https://acme.hosted.test'
const HOST = 'http://acme.example.test'
const configPath = fileURLToPath(new URL('./wrangler.hosted.jsonc', import.meta.url))
const harness = createTestHarness({ workers: [{ configPath }] })

before(() => harness.listen().then(() => {}))
after(() => harness.close())

async function call(method: string, path: string, body?: unknown, cookie = '') {
  const response = await harness.fetch(`${HOST}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ansa', ...(cookie ? { Cookie: cookie } : {}) },
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

const input = {
  workspaceId: 'acme',
  workspaceName: 'Acme Support',
  appUrl: APP_URL,
  admin: { name: 'Ada', email: 'ada@acme.test' },
  smtp: { host: 'smtp.postshiba.test', port: 587, security: 'starttls', user: 'tenant-acme', pass: 'smtp-secret-1' },
  planState: { plan: 'trial', mailboxLimit: 1, readOnly: false, hourlySendLimit: 100 },
}
const tokenOf = (text: string) => /\/link#([\w-]+)/.exec(text)?.[1] ?? assert.fail(`no one-time link in: ${text}`)

test('a control plane provisions a workspace over Durable Object RPC', async () => {
  const boot = (await call('GET', '/api/bootstrap')).data
  assert.deepEqual({ hosted: boot.hosted, setupRequired: boot.setupRequired, plan: boot.plan }, { hosted: true, setupRequired: false, plan: null }, 'an object that was never provisioned offers no setup')
  assert.equal((await call('POST', '/api/setup', { name: 'Mallory', email: 'mallory@evil.test', password: 'long enough password' })).status, 404, 'POST /api/setup is off')

  assert.equal((await rpc('setPlan', input.planState)).error?.name, 'NotProvisioned', 'the error name crosses the RPC boundary')
  const early = await harness.fetch(`${HOST}/__blob`, { method: 'PUT', body: 'too early' })
  assert.equal(early.status, 500, 'attachments have no home before provision')
  assert.match(await early.text(), /NotProvisioned/)
  assert.equal((await rpc('provision', { ...input, appUrl: 'nonsense' })).error?.name, 'Invalid')

  const first = await rpc('provision', input)
  assert.match(first.result?.signInUrl ?? JSON.stringify(first), /^https:\/\/acme\.hosted\.test\/link#[\w-]{40,}$/)
  const second = await rpc('provision', { ...input, workspaceName: 'Renamed' })
  assert.notEqual(second.result.signInUrl, first.result.signInUrl, 'a second call makes a fresh link')
  const health = (await rpc('health')).result
  assert.deepEqual({ users: health.users, mailboxes: health.mailboxes, coreVersion: typeof health.coreVersion }, { users: 1, mailboxes: 0, coreVersion: 'string' })
  assert.ok(health.schemaVersion >= 8, `schema version ${health.schemaVersion}`)

  const stored = await harness.fetch(`${HOST}/__blob`, { method: 'PUT', body: 'kept' })
  assert.equal(await stored.text(), 'kept', 'provision gives attachments their home')
  const { ATTACHMENTS: bucket } = await harness.getWorker<{ ATTACHMENTS: { get(key: string): Promise<{ text(): Promise<string> } | null> } }>().getEnv()
  assert.equal(await (await bucket.get('ws/acme/same/key.txt'))?.text(), 'kept', 'under the workspace id from provision')

  const after = (await call('GET', '/api/bootstrap')).data
  assert.equal(after.workspace.name, 'Acme Support', 'the second call changed nothing')
  assert.equal(after.appUrl, APP_URL, 'the address is the provisioned one, not the host of the request')

  const joined = await call('POST', '/api/links/consume', { token: tokenOf(second.result.signInUrl), password: 'correct horse 1' })
  assert.equal(joined.status, 200)
  assert.match(joined.cookie, /^__Host-ansa_session=[\w-]+; .*Secure/, 'the session cookie is host-only')
  const session = joined.cookie.split(';')[0]

  assert.equal((await call('POST', '/api/login', { email: 'ada@acme.test', password: 'correct horse 1' })).status, 200)
  assert.equal((await call('GET', '/api/bootstrap')).data.appUrl, APP_URL, 'signing in on another host does not teach the workspace a new address')

  assert.equal((await rpc('setPlan', { ...input.planState, plan: 'team', mailboxLimit: 5 })).error, undefined)
  assert.equal((await call('GET', '/api/bootstrap')).data.plan.plan, 'team', 'setPlan reaches the browser')

  const invited = await call('POST', '/api/invites', { email: 'bo@acme.test', role: 'agent' }, session)
  assert.equal(invited.status, 201, JSON.stringify(invited.data))
  const sent = (await call('GET', '/__sent')).data as { workspaceId: string; to: string; subject: string; text: string }[]
  assert.deepEqual(sent.map((mail) => ({ workspaceId: mail.workspaceId, to: mail.to, subject: mail.subject })), [{ workspaceId: 'acme', to: 'bo@acme.test', subject: 'Ada invited you to Acme Support' }], 'the invite went out through the CONTROL binding')
  const accepted = await call('POST', '/api/links/consume', { token: tokenOf(sent[0].text), name: 'Bo Li', password: 'bo chose this one' })
  assert.equal(accepted.data.user?.name, 'Bo Li', 'the teammate joined from the emailed link')

  const blocked = await call('POST', '/api/apps', { name: 'Hook', webhookUrl: 'https://other.hosted.test/hook', events: ['conversation.created'] }, session)
  assert.equal(blocked.status, 400, 'APP_BLOCKED_HOST_SUFFIX from the environment is enforced')
})

test('the sign-in limit survives a restart of the object', async () => {
  const bad = { email: 'ada@acme.test', password: 'wrong' }
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/login', bad)).status, 401)
  assert.equal((await call('POST', '/api/login', bad)).status, 429)
  assert.equal((await call('GET', '/__sent')).data.length, 1, 'the object still holds what it kept in memory')

  await harness.update({ workers: [{ configPath, vars: { RESTARTED: '1' } }] })
  assert.equal((await call('GET', '/__sent')).data.length, 0, 'the object started again: its memory is empty')
  assert.equal((await call('POST', '/api/login', { email: 'ada@acme.test', password: 'correct horse 1' })).status, 429, 'the fresh object still counts the earlier attempts')
  assert.equal((await call('GET', '/api/bootstrap')).data.appUrl, APP_URL, 'and still knows its address')
})

test('a reset request is kept in the outbox and the alarm delivers it once', async () => {
  const known = await call('POST', '/api/password/forgot', { email: 'ada@acme.test' })
  const unknown = await call('POST', '/api/password/forgot', { email: 'nobody@acme.test' })
  assert.deepEqual([known.status, unknown.status], [200, 200])
  assert.deepEqual(unknown.data, known.data, 'the answer is the same for an unknown address')

  const queued = (await call('GET', '/__reset-outbox')).data
  assert.equal(queued.rows.length, 2, 'both requests wait in the outbox')
  assert.ok(queued.alarm !== null && queued.alarm - Date.now() <= 2000, `the alarm is set for the outbox: ${queued.alarm}`)
  assert.equal((await call('GET', '/__sent')).data.length, 0, 'nothing is sent while the request is answered')

  let state = queued
  for (let i = 0; i < 100 && (state.rows.length > 0 || state.alarm !== null); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    state = (await call('GET', '/__reset-outbox')).data
  }
  assert.deepEqual(state, { rows: [], alarm: null }, 'the alarm emptied the outbox and nothing else is waiting')
  const sent = (await call('GET', '/__sent')).data as { workspaceId: string; to: string; subject: string }[]
  assert.deepEqual(sent.map((mail) => ({ workspaceId: mail.workspaceId, to: mail.to, subject: mail.subject })), [{ workspaceId: 'acme', to: 'ada@acme.test', subject: 'Reset your password for Acme Support' }], 'CONTROL.sendSystemEmail ran once, for the teammate only')
})
