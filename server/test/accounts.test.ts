import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { createApp, prepareData } from '../app.ts'
import { readConfig } from '../config.ts'
import { decrypt, encrypt, sha256 } from '../crypto.ts'
import { all, get, getSetting, run } from '../db.ts'
import type { HostedState, SystemEmail } from '../hosted.ts'
import { testApp } from '../services/apps.ts'
import { health, provision, setPlan, setSmtp, type ProvisionInput } from '../services/provision.ts'
import { runInTenant } from '../tenant.ts'
import { openNodeTenant } from '../tenant-node.ts'
import { startSmtpCatcher } from './smtp-catcher.ts'

const HOSTED_URL = 'https://acme.hosted.test'
const HOSTED_ENV = { ANSA_HOSTED: '1', APP_BLOCKED_HOST_SUFFIX: 'hosted.test' }
const LOCAL_URL = 'http://localhost:3000'

interface CallOptions {
  body?: unknown
  cookie?: string
  // Null means no socket, as on Workers.
  address?: string | null
  headers?: Record<string, string>
}

function install(env: Record<string, string>, origin: string, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-accounts-'))) {
  const sent: (SystemEmail & { workspaceId: string })[] = []
  const tenant = openNodeTenant(readConfig((key) => ({ DATA_DIR: dataDir, ...env })[key]))
  if (env.ANSA_HOSTED === '1') tenant.control = { sendSystemEmail: async (workspaceId, mail) => void sent.push({ workspaceId, ...mail }) }
  const inside = <T>(fn: () => T): T => runInTenant(tenant, fn)
  const app = inside(() => {
    prepareData()
    return createApp()
  })
  async function call(method: string, route: string, { body, cookie, address = '203.0.113.7', headers = {} }: CallOptions = {}) {
    const request = new Request(`${origin}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ansa', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const response = await inside(() => app.fetch(request, address === null ? undefined : { incoming: { socket: { remoteAddress: address } } }))
    const setCookies = response.headers.getSetCookie()
    const session = setCookies.find((line) => /ansa_session=[^;]+/.test(line) && !/Max-Age=0/.test(line))
    return { status: response.status, data: (await response.json()) as any, setCookies, cookie: session?.split(';')[0] ?? '' }
  }
  return { env, origin, dataDir, tenant, sent, inside, call }
}

const provisionInput = (over: Partial<ProvisionInput> = {}): ProvisionInput => ({
  workspaceId: 'ws_acme',
  workspaceName: 'Acme Support',
  appUrl: HOSTED_URL,
  admin: { name: 'Ada', email: 'Ada@Acme.test' },
  smtp: { host: 'smtp.postshiba.test', port: 587, security: 'starttls', user: 'tenant-acme', pass: 'smtp-secret-1' },
  planState: { plan: 'trial', mailboxLimit: 1, readOnly: false, hourlySendLimit: 100 },
  ...over,
})

const tokenOf = (text: string) => /\/link#([\w-]+)/.exec(text)?.[1] ?? assert.fail(`no one-time link in: ${text}`)
const settle = () => new Promise((resolve) => setImmediate(resolve))
const rows = (sql: string) => all<Record<string, unknown>>(sql).map((row) => ({ ...row }))

async function hostedWorkspace() {
  const ws = install(HOSTED_ENV, HOSTED_URL)
  const { signInUrl } = ws.inside(() => provision(provisionInput()))
  const joined = await ws.call('POST', '/links/consume', { body: { token: tokenOf(signInUrl), password: 'correct horse 1' } })
  assert.equal(joined.status, 200, 'the first admin signs in from the provision link')
  return { ...ws, adminCookie: joined.cookie }
}

async function selfHosted(env: Record<string, string> = {}, origin = LOCAL_URL) {
  const ws = install(env, origin)
  const setup = await ws.call('POST', '/setup', { body: { name: 'Sol', email: 'sol@self.test', password: 'self pass' } })
  assert.equal(setup.status, 200, 'a self-hosted install is set up by its first visitor')
  return { ...ws, adminCookie: setup.cookie }
}

test('provision starts a workspace once; a second call only makes a new sign-in link', async () => {
  const ws = install(HOSTED_ENV, HOSTED_URL)
  const trial = provisionInput().planState
  assert.throws(() => ws.inside(() => setPlan(trial)), { name: 'NotProvisioned' }, 'setPlan before provision')
  assert.throws(() => ws.inside(() => setSmtp(provisionInput().smtp)), { name: 'NotProvisioned' }, 'setSmtp before provision')
  assert.throws(() => ws.inside(() => provision(provisionInput({ appUrl: 'javascript:alert(1)' }))), { name: 'Invalid' }, 'a bad address is refused')
  assert.equal(ws.inside(() => all('SELECT id FROM users')).length, 0, 'a refused call creates nobody')

  const first = ws.inside(() => provision(provisionInput()))
  assert.match(first.signInUrl, /^https:\/\/acme\.hosted\.test\/link#[\w-]{40,}$/, 'the link is on the fixed address')
  const state = ws.inside(() => getSetting<HostedState | null>('hosted', null))!
  assert.deepEqual(
    { workspaceId: state.workspaceId, workspaceName: state.workspaceName, appUrl: state.appUrl, planState: state.planState },
    { workspaceId: 'ws_acme', workspaceName: 'Acme Support', appUrl: HOSTED_URL, planState: trial },
  )
  assert.ok(!JSON.stringify(state).includes('smtp-secret-1'), 'the SMTP password is not stored in the clear')
  assert.equal(ws.inside(() => decrypt(state.smtp.passEnc)), 'smtp-secret-1', 'the workspace can read its SMTP password back')
  assert.deepEqual(ws.inside(() => rows('SELECT name, email, role, password_hash FROM users')), [{ name: 'Ada', email: 'ada@acme.test', role: 'admin', password_hash: '' }], 'one admin, without a password')
  assert.equal(ws.tenant.config.appUrl, HOSTED_URL, 'the public address is the one from provision')

  const second = ws.inside(() =>
    provision(provisionInput({ workspaceName: 'Renamed', admin: { name: 'Eve', email: 'eve@other.test' }, smtp: { ...provisionInput().smtp, pass: 'another' }, planState: { ...trial, plan: 'business' } })),
  )
  assert.notEqual(second.signInUrl, first.signInUrl, 'a fresh link')
  assert.deepEqual(ws.inside(() => getSetting<HostedState | null>('hosted', null)), state, 'nothing else changed')
  assert.equal(ws.inside(() => all('SELECT id FROM users')).length, 1, 'no second admin')
  for (const url of [first.signInUrl, second.signInUrl]) {
    assert.equal((await ws.call('POST', '/links/inspect', { body: { token: tokenOf(url) } })).status, 200, 'both links open the sign-in page')
  }
  assert.throws(() => ws.inside(() => provision(provisionInput({ workspaceId: 'ws_other' }))), { name: 'Invalid' }, 'another workspace cannot take this object')

  const paid = { plan: 'team', mailboxLimit: 5, readOnly: false, hourlySendLimit: 400 } as const
  ws.inside(() => setPlan(paid))
  assert.deepEqual((await ws.call('GET', '/bootstrap')).data.plan, paid, 'the browser sees the new plan')
  ws.inside(() => setSmtp({ ...provisionInput().smtp, host: 'smtp2.postshiba.test', pass: 'rotated' }))
  const rotated = ws.inside(() => getSetting<HostedState | null>('hosted', null))!
  assert.equal(rotated.smtp.host, 'smtp2.postshiba.test')
  assert.equal(ws.inside(() => decrypt(rotated.smtp.passEnc)), 'rotated')
  assert.deepEqual(rotated.planState, paid, 'setSmtp leaves the plan alone')

  const migrations = ws.inside(() => get<{ n: number }>('SELECT COUNT(*) AS n FROM _migrations'))!.n
  assert.deepEqual(ws.inside(health), { schemaVersion: migrations, coreVersion: pkg.version, mailboxes: 0, users: 1 })

  const restarted = install(HOSTED_ENV, HOSTED_URL, ws.dataDir)
  assert.equal(restarted.tenant.config.appUrl, HOSTED_URL, 'the address survives a restart')

  const self = install({}, LOCAL_URL)
  assert.throws(() => self.inside(() => provision(provisionInput())), { name: 'Invalid' }, 'a self-hosted install cannot be provisioned')
})

test('a hosted workspace has no first-visitor setup', async () => {
  const ws = install(HOSTED_ENV, HOSTED_URL)
  const setup = await ws.call('POST', '/setup', { body: { name: 'Mallory', email: 'mallory@evil.test', password: 'long enough password' } })
  assert.equal(setup.status, 404, 'POST /api/setup is off')
  assert.equal(ws.inside(() => all('SELECT id FROM users')).length, 0, 'nobody was created')
  const before = (await ws.call('GET', '/bootstrap')).data
  assert.deepEqual(
    { setupRequired: before.setupRequired, hosted: before.hosted, plan: before.plan, passwordMinLength: before.passwordMinLength },
    { setupRequired: false, hosted: true, plan: null, passwordMinLength: 10 },
  )

  ws.inside(() => provision(provisionInput()))
  const after = (await ws.call('GET', '/bootstrap')).data
  assert.deepEqual(after.plan, provisionInput().planState, 'bootstrap reports the plan')
  assert.equal(after.workspace.name, 'Acme Support', 'bootstrap reports the workspace name')
  assert.equal((await ws.call('POST', '/setup', { body: { name: 'Mallory', email: 'mallory@evil.test', password: 'long enough password' } })).status, 404, 'still off after provision')

  const self = install({}, LOCAL_URL)
  const boot = (await self.call('GET', '/bootstrap')).data
  assert.deepEqual({ setupRequired: boot.setupRequired, hosted: boot.hosted, plan: boot.plan, passwordMinLength: boot.passwordMinLength }, { setupRequired: true, hosted: false, plan: null, passwordMinLength: 8 })
  assert.equal(boot.workspace.name, '')
})

test('a one-time link works once, for 24 hours, and only when the form is sent', async () => {
  const ws = install(HOSTED_ENV, HOSTED_URL)
  const token = tokenOf(ws.inside(() => provision(provisionInput())).signInUrl)
  assert.equal(ws.inside(() => get('SELECT 1 FROM one_time_links WHERE token_hash = ?', token)), undefined, 'the token itself is not stored')
  const stored = ws.inside(() => get<{ token_hash: string; expires_at: number; created_at: number }>('SELECT token_hash, expires_at, created_at FROM one_time_links'))!
  assert.equal(stored.token_hash, ws.inside(() => sha256(token)), 'its hash is')
  assert.equal(stored.expires_at - stored.created_at, 24 * 3_600_000, 'it lasts 24 hours')

  for (const route of [`/links/consume?token=${token}`, `/links/inspect?token=${token}`, `/links/${token}`]) {
    assert.equal((await ws.call('GET', route)).status, 401, `GET ${route.split('?')[0]} is not a link route: it asks for a sign-in like any unknown path`)
  }
  for (const round of [1, 2]) {
    const seen = await ws.call('POST', '/links/inspect', { body: { token } })
    assert.deepEqual(seen.data.link, { purpose: 'sign_in', email: 'ada@acme.test', name: 'Ada', needsName: false, needsPassword: true }, `looking at the link (${round}) uses nothing up`)
    assert.equal(seen.cookie, '', 'looking signs nobody in')
  }

  const short = await ws.call('POST', '/links/consume', { body: { token, password: '9 chars!!' } })
  assert.equal(short.status, 400)
  assert.match(short.data.error, /at least 10 characters/, 'hosted passwords need 10 characters')
  assert.equal((await ws.call('POST', '/links/consume', { body: { token } })).status, 400, 'a password-less admin must choose a password')
  assert.equal((await ws.call('POST', '/links/inspect', { body: { token } })).status, 200, 'a refused password leaves the link usable')

  const used = await ws.call('POST', '/links/consume', { body: { token, password: '10 chars!!' } })
  assert.equal(used.status, 200)
  assert.equal(used.data.user.pending, false, 'the admin now has a password')
  assert.equal((await ws.call('GET', '/me', { cookie: used.cookie })).data.user.email, 'ada@acme.test', 'the link signed the admin in')
  assert.equal((await ws.call('POST', '/links/consume', { body: { token, password: '10 chars!!' } })).status, 404, 'a second use fails')
  assert.equal((await ws.call('POST', '/links/inspect', { body: { token } })).status, 404, 'a used link shows as gone')
  assert.equal((await ws.call('POST', '/login', { body: { email: 'ada@acme.test', password: '10 chars!!' } })).status, 200, 'the chosen password signs in')

  const again = tokenOf(ws.inside(() => provision(provisionInput())).signInUrl)
  assert.equal((await ws.call('POST', '/links/inspect', { body: { token: again } })).data.link.needsPassword, false, 'an admin with a password is not asked for one')
  const signedIn = await ws.call('POST', '/links/consume', { body: { token: again } })
  assert.equal(signedIn.status, 200)
  assert.ok(signedIn.cookie, 'a later sign-in link just signs in')
  assert.equal((await ws.call('POST', '/login', { body: { email: 'ada@acme.test', password: '10 chars!!' } })).status, 200, 'and keeps the password')

  const late = tokenOf(ws.inside(() => provision(provisionInput())).signInUrl)
  ws.inside(() => run('UPDATE one_time_links SET expires_at = ? WHERE used_at IS NULL', Date.now() - 1))
  assert.equal((await ws.call('POST', '/links/inspect', { body: { token: late } })).status, 404, 'an expired link shows as gone')
  assert.equal((await ws.call('POST', '/links/consume', { body: { token: late } })).status, 404, 'an expired link signs nobody in')
  assert.equal((await ws.call('POST', '/links/consume', { body: { token: 'made-up' } })).status, 404, 'an unknown token')
  assert.equal((await ws.call('POST', '/links/consume', { body: {} })).status, 404, 'no token')

  const blocked = tokenOf(ws.inside(() => provision(provisionInput())).signInUrl)
  ws.inside(() => run('UPDATE users SET disabled = 1'))
  assert.equal((await ws.call('POST', '/links/consume', { body: { token: blocked } })).status, 404, 'a deactivated teammate cannot use a link')
})

test('an admin invites by email; the teammate chooses a name and a password', async () => {
  const ws = await hostedWorkspace()
  const admin = { cookie: ws.adminCookie }

  const typed = await ws.call('POST', '/users', { ...admin, body: { name: 'Bo', email: 'bo@acme.test', password: 'typed by the admin' } })
  assert.equal(typed.status, 400, 'a hosted admin cannot type a teammate password')
  const adminId = (await ws.call('GET', '/me', admin)).data.user.id
  assert.equal((await ws.call('PATCH', `/users/${adminId}`, { ...admin, body: { password: 'typed by the admin' } })).status, 400, 'nor change one')

  const invited = await ws.call('POST', '/invites', { ...admin, body: { email: 'Bo@Acme.test', role: 'agent' } })
  assert.equal(invited.status, 201)
  assert.deepEqual({ email: invited.data.user.email, role: invited.data.user.role, pending: invited.data.user.pending }, { email: 'bo@acme.test', role: 'agent', pending: true })
  assert.equal(ws.sent.length, 1, 'one email went to the control plane')
  assert.deepEqual({ workspaceId: ws.sent[0].workspaceId, to: ws.sent[0].to, subject: ws.sent[0].subject }, { workspaceId: 'ws_acme', to: 'bo@acme.test', subject: 'Ada invited you to Acme Support' })
  assert.ok(ws.sent[0].html.includes(`${HOSTED_URL}/link#`), 'the HTML part carries the link')
  const firstToken = tokenOf(ws.sent[0].text)
  assert.equal((await ws.call('POST', '/login', { body: { email: 'bo@acme.test', password: '' } })).status, 401, 'an invited teammate cannot sign in yet')

  assert.equal((await ws.call('POST', '/invites', { ...admin, body: { email: 'bo@acme.test', role: 'admin' } })).status, 201, 'inviting again sends again')
  assert.equal(ws.sent.length, 2)
  assert.deepEqual(ws.inside(() => rows(`SELECT role FROM users WHERE email = 'bo@acme.test'`)), [{ role: 'admin' }], 'still one teammate, with the newer role')
  const token = tokenOf(ws.sent[1].text)

  const seen = await ws.call('POST', '/links/inspect', { body: { token } })
  assert.deepEqual(seen.data.link, { purpose: 'invite', email: 'bo@acme.test', name: '', needsName: true, needsPassword: true })
  assert.equal((await ws.call('POST', '/links/consume', { body: { token, password: 'bo chose this one' } })).status, 400, 'a name is required')
  const joined = await ws.call('POST', '/links/consume', { body: { token, name: 'Bo Li', password: 'bo chose this one' } })
  assert.equal(joined.status, 200)
  assert.deepEqual({ name: joined.data.user.name, pending: joined.data.user.pending }, { name: 'Bo Li', pending: false })
  assert.equal((await ws.call('GET', '/me', { cookie: joined.cookie })).data.user.name, 'Bo Li', 'accepting signs the teammate in')
  assert.equal((await ws.call('POST', '/login', { body: { email: 'bo@acme.test', password: 'bo chose this one' } })).status, 200, 'the teammate signs in with the chosen password')
  assert.equal((await ws.call('POST', '/links/consume', { body: { token: firstToken, name: 'Other', password: 'someone else tries' } })).status, 404, 'the earlier invite link died when the teammate joined')

  assert.equal((await ws.call('POST', '/invites', { ...admin, body: { email: 'bo@acme.test', role: 'agent' } })).status, 409, 'a teammate who joined cannot be invited again')
  assert.equal((await ws.call('POST', '/invites', { ...admin, body: { email: 'not an email' } })).status, 400)
  ws.inside(() => run(`UPDATE users SET role = 'agent' WHERE email = 'bo@acme.test'`))
  assert.equal((await ws.call('POST', '/invites', { cookie: joined.cookie, body: { email: 'cy@acme.test' } })).status, 403, 'only admins invite')

  const extra = await ws.call('POST', '/invites', { ...admin, body: { email: 'cy@acme.test' } })
  const extraToken = tokenOf(ws.sent.at(-1)!.text)
  assert.equal((await ws.call('DELETE', `/invites/${extra.data.user.id}`, admin)).status, 200, 'an admin cancels a waiting invite')
  assert.equal(ws.inside(() => get(`SELECT 1 FROM users WHERE email = 'cy@acme.test'`)), undefined, 'the invited teammate is gone')
  assert.equal((await ws.call('POST', '/links/inspect', { body: { token: extraToken } })).status, 404, 'and so is the link')
  assert.equal((await ws.call('DELETE', `/invites/${joined.data.user.id}`, admin)).status, 409, 'a teammate who joined is not an invite')
})

test('a self-hosted install invites through its first mailbox, or says why it cannot', async () => {
  const ws = await selfHosted()
  const admin = { cookie: ws.adminCookie }

  const refused = await ws.call('POST', '/invites', { ...admin, body: { email: 'bo@self.test' } })
  assert.equal(refused.status, 400)
  assert.match(refused.data.error, /cannot send email yet\. Connect a mailbox/, 'without SMTP the error says what to do')
  assert.equal(ws.inside(() => get(`SELECT 1 FROM users WHERE email = 'bo@self.test'`)), undefined, 'no half-invited teammate is left')

  const catcher = await startSmtpCatcher()
  try {
    ws.inside(() => run(`INSERT INTO mailboxes (name, email, smtp_host, smtp_port, smtp_security, created_at) VALUES ('Support', 'support@self.test', '127.0.0.1', ?, 'none', 1)`, catcher.port))
    const invited = await ws.call('POST', '/invites', { ...admin, body: { email: 'bo@self.test' } })
    assert.equal(invited.status, 201)
    assert.deepEqual({ to: catcher.inbox[0]?.to, subject: catcher.inbox[0]?.subject }, { to: 'bo@self.test', subject: 'Sol invited you to Ansa' }, 'the invite left through the mailbox SMTP server')
    assert.ok(catcher.inbox[0].text.includes(`${LOCAL_URL}/link#`), 'the link uses the public address')
    const joined = await ws.call('POST', '/links/consume', { body: { token: tokenOf(catcher.inbox[0].text), name: 'Bo', password: '8 chars!' } })
    assert.equal(joined.status, 200, 'self-hosted passwords need 8 characters')

    assert.equal((await ws.call('POST', '/password/forgot', { body: { email: 'bo@self.test' } })).status, 200)
    for (let i = 0; i < 100 && catcher.inbox.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(catcher.inbox[1]?.subject, 'Reset your password for Ansa', 'the reset link left through SMTP too')
    assert.equal((await ws.call('POST', '/links/consume', { body: { token: tokenOf(catcher.inbox[1].text), password: 'new pass' } })).status, 200)
  } finally {
    await catcher.close()
  }

  const typed = await ws.call('POST', '/users', { ...admin, body: { name: 'Cy', email: 'cy@self.test', password: 'typed it' } })
  assert.equal(typed.status, 201, 'a self-hosted admin may still type a teammate password')
  assert.equal(typed.data.user.pending, false)
})

test('forgot password answers the same for everyone and emails a single-use link', async () => {
  const ws = await hostedWorkspace()
  const known = await ws.call('POST', '/password/forgot', { body: { email: 'Ada@acme.test' } })
  const unknown = await ws.call('POST', '/password/forgot', { body: { email: 'nobody@acme.test' } })
  const malformed = await ws.call('POST', '/password/forgot', { body: { email: 'nonsense' } })
  await settle()
  assert.deepEqual([known.status, known.data], [200, { ok: true }])
  assert.deepEqual([unknown.status, unknown.data], [known.status, known.data], 'an unknown address gets the same answer')
  assert.deepEqual([malformed.status, malformed.data], [known.status, known.data], 'so does a malformed one')
  assert.equal(ws.sent.length, 1, 'only the teammate got an email')
  assert.deepEqual({ to: ws.sent[0].to, subject: ws.sent[0].subject }, { to: 'ada@acme.test', subject: 'Reset your password for Acme Support' })

  const token = tokenOf(ws.sent[0].text)
  assert.deepEqual((await ws.call('POST', '/links/inspect', { body: { token } })).data.link, { purpose: 'reset', email: 'ada@acme.test', name: 'Ada', needsName: false, needsPassword: true })
  assert.equal((await ws.call('POST', '/links/consume', { body: { token } })).status, 400, 'a new password is required')
  const reset = await ws.call('POST', '/links/consume', { body: { token, password: 'a brand new one' } })
  assert.equal(reset.status, 200)
  assert.equal((await ws.call('GET', '/me', { cookie: reset.cookie })).status, 200, 'the reset signs in')
  assert.equal((await ws.call('GET', '/me', { cookie: ws.adminCookie })).status, 401, 'every earlier session ended')
  assert.equal((await ws.call('POST', '/login', { body: { email: 'ada@acme.test', password: 'correct horse 1' } })).status, 401, 'the old password is dead')
  assert.equal((await ws.call('POST', '/login', { body: { email: 'ada@acme.test', password: 'a brand new one' } })).status, 200, 'the new one works')
  assert.equal((await ws.call('POST', '/links/consume', { body: { token, password: 'yet another one' } })).status, 404, 'the link worked once')

  for (let i = 0; i < 3; i++) assert.equal((await ws.call('POST', '/password/forgot', { body: { email: 'ada@acme.test' } })).status, 200, 'the answer stays the same over the limit')
  await settle()
  assert.equal(ws.sent.length, 3, 'at most three reset emails an hour go to one address')

  const elsewhere = { address: '198.51.100.9' }
  for (let i = 0; i < 10; i++) assert.equal((await ws.call('POST', '/password/forgot', { ...elsewhere, body: { email: `guess${i}@acme.test` } })).status, 200)
  assert.equal((await ws.call('POST', '/password/forgot', { ...elsewhere, body: { email: 'guess10@acme.test' } })).status, 429, 'one address may ask ten times an hour')
})

test('sign-in attempts are counted in the database and survive a restart', async () => {
  const ws = await selfHosted()
  const good = { email: 'sol@self.test', password: 'self pass' }
  const bad = { ...good, password: 'wrong' }
  for (let i = 0; i < 10; i++) assert.equal((await ws.call('POST', '/login', { body: bad })).status, 401)
  assert.equal((await ws.call('POST', '/login', { body: good })).status, 429, 'the eleventh attempt is refused, even with the right password')
  assert.ok(!JSON.stringify(ws.inside(() => all('SELECT key FROM attempts'))).includes('sol@self.test'), 'the counter does not store the address in the clear')

  const restarted = install(ws.env, ws.origin, ws.dataDir)
  assert.equal((await restarted.call('POST', '/login', { body: good })).status, 429, 'a restart does not reset the count')
  assert.equal((await restarted.call('POST', '/login', { body: good, headers: { 'X-Forwarded-For': '192.0.2.50', 'CF-Connecting-IP': '192.0.2.50' } })).status, 429, 'headers a client can forge do not move it to another counter')
  assert.equal((await restarted.call('POST', '/login', { body: good, address: '198.51.100.20' })).status, 200, 'another address is not held back')

  restarted.inside(() => run('UPDATE attempts SET reset_at = ?', Date.now() - 1))
  assert.equal((await restarted.call('POST', '/login', { body: good })).status, 200, 'the count expires')

  const proxied = await selfHosted({ TRUST_PROXY: '1' })
  const via = (chain: string) => ({ address: '10.0.0.2', headers: { 'X-Forwarded-For': chain } })
  for (let i = 0; i < 10; i++) assert.equal((await proxied.call('POST', '/login', { ...via(`${i}.${i}.${i}.${i}, 192.0.2.60`), body: bad })).status, 401)
  assert.equal((await proxied.call('POST', '/login', { ...via('192.0.2.60'), body: good })).status, 429, 'with TRUST_PROXY the hop the proxy appended is counted, whatever the client put first')
  assert.equal((await proxied.call('POST', '/login', { ...via('192.0.2.60, 192.0.2.61'), body: good })).status, 200, 'another visitor behind the proxy is not held back')

  const worker = await selfHosted()
  const from = (ip: string) => ({ address: null, headers: { 'CF-Connecting-IP': ip, 'X-Forwarded-For': '192.0.2.99' } })
  for (let i = 0; i < 10; i++) assert.equal((await worker.call('POST', '/login', { ...from('192.0.2.70'), body: bad })).status, 401)
  assert.equal((await worker.call('POST', '/login', { ...from('192.0.2.70'), body: good })).status, 429, 'without a socket, as on Workers, CF-Connecting-IP is counted')
  assert.equal((await worker.call('POST', '/login', { ...from('192.0.2.71'), body: good })).status, 200)
})

test('the session cookie is host-only on HTTPS, and the old name still works on a self-hosted install', async () => {
  const hosted = install(HOSTED_ENV, HOSTED_URL)
  const token = tokenOf(hosted.inside(() => provision(provisionInput())).signInUrl)
  const joined = await hosted.call('POST', '/links/consume', { body: { token, password: 'correct horse 1' } })
  const line = joined.setCookies.find((cookie) => cookie.includes('ansa_session='))!
  assert.match(line, /^__Host-ansa_session=[\w-]+;/, 'the name carries the __Host- prefix')
  const attributes = line.split('; ').slice(1).sort()
  assert.deepEqual(attributes, ['HttpOnly', 'Max-Age=2592000', 'Path=/', 'SameSite=Lax', 'Secure'], 'Secure, Path=/, and no Domain')

  const planted = 'planted-by-a-sibling-subdomain'
  hosted.inside(() => run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)', sha256(planted), Date.now(), Date.now() + 60_000))
  assert.equal((await hosted.call('GET', '/me', { cookie: `ansa_session=${planted}` })).status, 401, 'a hosted workspace ignores the old cookie name')
  assert.equal((await hosted.call('GET', '/me', { cookie: `__Host-ansa_session=${planted}` })).status, 200, 'the same session under the prefixed name is fine')

  const plain = await selfHosted()
  assert.match(plain.adminCookie, /^ansa_session=/, 'plain HTTP keeps the old name: __Host- needs Secure')
  const again = await plain.call('POST', '/login', { body: { email: 'sol@self.test', password: 'self pass' } })
  assert.ok(!/Secure/.test(again.setCookies.join()), 'and is not marked Secure')

  const secure = await selfHosted({ APP_URL: 'https://help.example.test' }, 'http://ansa:3000')
  assert.match(secure.adminCookie, /^__Host-ansa_session=/, 'an install with an https APP_URL behind a proxy uses the prefixed name')
  const old = 'session-from-the-previous-release'
  secure.inside(() => run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)', sha256(old), Date.now(), Date.now() + 3_600_000))
  const moved = await secure.call('GET', '/bootstrap', { cookie: `ansa_session=${old}` })
  assert.equal(moved.data.user?.email, 'sol@self.test', 'a session under the old name still signs in')
  assert.equal(moved.cookie, `__Host-ansa_session=${old}`, 'and moves to the new name')
  assert.ok(moved.setCookies.some((cookie) => /^ansa_session=;.*Max-Age=0/.test(cookie)), 'the old cookie is cleared')

  const out = await secure.call('POST', '/logout', { cookie: secure.adminCookie })
  assert.ok(out.setCookies.some((cookie) => /^__Host-ansa_session=;.*Max-Age=0/.test(cookie) && /Secure/.test(cookie)), 'signing out clears the prefixed cookie')
  assert.equal((await secure.call('GET', '/me', { cookie: secure.adminCookie })).status, 401)
})

test('apps cannot call the workspace itself or, on a hosted install, its neighbours', async () => {
  const ws = await hostedWorkspace()
  const admin = { cookie: ws.adminCookie }
  const app = (webhookUrl: string) => ws.call('POST', '/apps', { ...admin, body: { name: 'Hook', webhookUrl, events: ['conversation.created'] } })

  const own = await app(`${HOSTED_URL}/api/setup`)
  assert.equal(own.status, 400)
  assert.match(own.data.error, /address of this workspace/)
  for (const url of ['https://other.hosted.test/hook', 'http://other.hosted.test/hook', 'https://HOSTED.test./hook', 'https://a.b.hosted.test:8443/hook']) {
    const refused = await app(url)
    assert.equal(refused.status, 400, `${url} is refused`)
    assert.match(refused.data.error, /cannot use an address on hosted\.test/)
  }
  const sidebar = await ws.call('POST', '/apps', { ...admin, body: { name: 'Side', sidebarMode: 'dynamic', sidebarUrl: 'https://other.hosted.test/side' } })
  assert.equal(sidebar.status, 400, 'a sidebar address is checked the same way')
  assert.equal((await app('https://hooks.nothosted.test/hook')).status, 201, 'a look-alike domain is a different host')

  const id = ws.inside(() => run(`INSERT INTO apps (name, webhook_url, events, secret_enc, created_at) VALUES ('Old', 'https://other.hosted.test/hook', '["conversation.created"]', ?, 1)`, encrypt('secret')).id)
  const started = Date.now()
  const result = await ws.inside(() => testApp(id))
  assert.deepEqual(result.webhook, { ok: false, message: 'An app cannot use an address on hosted.test.' }, 'an address saved before the rule is refused when it is called')
  assert.ok(Date.now() - started < 1000, 'without a request or a retry')

  const self = await selfHosted()
  const local = (webhookUrl: string) => self.call('POST', '/apps', { cookie: self.adminCookie, body: { name: 'Hook', webhookUrl, events: ['conversation.created'] } })
  assert.equal((await local(`${LOCAL_URL}/api/setup`)).status, 400, 'a self-hosted install refuses its own address')
  assert.equal((await local('http://localhost:4000/hook')).status, 201, 'another port on the same machine is another server')
  assert.equal((await local('https://other.hosted.test/hook')).status, 201, 'without APP_BLOCKED_HOST_SUFFIX no domain is off limits')
})
