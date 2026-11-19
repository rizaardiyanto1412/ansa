import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { createTestHarness } from 'wrangler'

const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) }] })
before(() => harness.listen().then(() => {}))
after(() => harness.close())
const worker = harness.getWorker()
const url = (workspace: string, path: string) => `http://${workspace}.example.test${path}`
async function call<T>(workspace: string, path: string, init?: Parameters<typeof harness.fetch>[1]): Promise<T> {
  const response = await harness.fetch(url(workspace, path), init)
  assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`)
  return await response.json() as T
}
async function fixture(workspace: string) {
  const response = await harness.fetch(url(workspace, '/api/setup'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ansa' },
    body: JSON.stringify({ name: 'Ada', email: `ada@${workspace}.test`, password: 'correct horse battery' }),
  })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')!.split(';')[0]
  const sql = await worker.getDurableObjectStorage('ANSA', { name: workspace })
  await sql.exec("INSERT INTO mailboxes (name, email, imap_enabled, created_at) VALUES ('Support', 'support@test.invalid', 0, 1)")
  await sql.exec("INSERT INTO customers (email, name, created_at, updated_at) VALUES ('customer@test.invalid', 'Customer', 1, 1)")
  await sql.exec("INSERT INTO conversations (mailbox_id, customer_id, subject, created_at, updated_at) VALUES (1, 1, 'Hello', 1, 1)")
  return { cookie, sql }
}
type Socket = NonNullable<Awaited<ReturnType<typeof harness.fetch>>['webSocket']>
async function connect(workspace: string, headers: Record<string, string>) {
  const response = await harness.fetch(url(workspace, '/api/events'), { headers: { ...headers, Upgrade: 'websocket' } })
  assert.equal(response.status, 101)
  const socket = response.webSocket!
  const received: string[] = []
  socket.addEventListener('message', (event) => received.push(String(event.data)))
  socket.accept()
  await until(() => received.some((raw) => raw.includes('hello')))
  return { socket, received }
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check() && Date.now() < end) await wait(10)
  assert.ok(check(), 'the expected socket event arrived')
}
function presence(socket: Socket, state: 'viewing' | 'replying' | null) {
  socket.send(JSON.stringify({ type: 'presence', presence: state ? { conversationId: 1, state } : null }))
}
const viewers = (workspace: string, cookie: string) => call<{ viewers: Record<number, { userId: number; state: string }[]> }>(workspace, '/api/presence', { headers: { Cookie: cookie } })

test('alarms use the earliest actual deadline, survive reconstruction, and disappear when idle', async () => {
  const workspace = 'deadlines'
  const { sql } = await fixture(workspace)
  const schedule = () => call<{ alarm: number | null }>(workspace, '/__schedule')
  assert.equal((await schedule()).alarm, null, 'an idle workspace has no alarm')
  const now = Date.now()
  const snooze = now + 7_200_000
  const send = now + 3_600_000
  const retry = now + 1_800_000
  await sql.exec('UPDATE conversations SET snoozed_until = ?', snooze)
  assert.equal((await schedule()).alarm, snooze, 'snoozing for two hours does not wake every minute')
  await sql.exec("INSERT INTO threads (conversation_id, type, state, send_at, created_at) VALUES (1, 'reply', 'scheduled', ?, 1)", send)
  assert.equal((await schedule()).alarm, send, 'an earlier scheduled reply wins')
  await sql.exec("INSERT INTO settings (key, value) VALUES ('import_helpscout', ?)", JSON.stringify({ status: 'running', waitUntil: retry }))
  assert.equal((await schedule()).alarm, retry, 'an import retry waits for its saved deadline')
  await sql.exec("UPDATE mailboxes SET imap_enabled = 1, imap_host = 'imap.test.invalid'")
  const poll = (await schedule()).alarm!
  assert.ok(poll >= now + 60_000 && poll < retry, 'only an IMAP mailbox adds a polling deadline')
  await worker.evictDurableObject('ANSA', { name: workspace, webSockets: 'hibernate' })
  assert.equal((await schedule()).alarm, poll, 'reconstruction does not reset the IMAP clock')
  await sql.exec("UPDATE mailboxes SET imap_enabled = 0")
  await sql.exec("UPDATE settings SET value = ? WHERE key = 'import_helpscout'", JSON.stringify({ status: 'paused' }))
  assert.equal((await schedule()).alarm, send, 'removing the earliest job moves the alarm later')
  await sql.exec("UPDATE threads SET send_at = NULL")
  assert.equal((await schedule()).alarm, snooze, 'held replies do not create deadlines')
  await sql.exec('UPDATE conversations SET snoozed_until = NULL')
  assert.equal((await schedule()).alarm, null, 'cancelling the last job removes the alarm')
  await sql.exec("UPDATE settings SET value = ? WHERE key = 'import_helpscout'", JSON.stringify({ status: 'running', waitUntil: 0 }))
  const start = Date.now()
  const step = (await schedule()).alarm!
  assert.ok(step >= start + 1000 && step < start + 2000, 'an active import gets a short next step')
  assert.ok((await schedule()).alarm! < start + 2000, 'requests keep import work within the one-second scheduling floor')
  await sql.exec("UPDATE settings SET value = ? WHERE key = 'import_helpscout'", JSON.stringify({ status: 'cancelled' }))
  await sql.exec('UPDATE conversations SET snoozed_until = ?', Date.now() + 100)
  await schedule()
  await wait(1200)
  assert.equal((await schedule()).alarm, null, 'the real alarm woke the conversation and returned to idle')
})

test('socket presence and workspace broadcasts survive hibernation, including multiple tabs and close', async () => {
  const a = await fixture('socket-a')
  const b = await fixture('socket-b')
  assert.equal((await call<{ liveTransport: string }>('socket-a', '/api/bootstrap')).liveTransport, 'websocket')
  assert.equal((await harness.fetch(url('socket-a', '/api/events'), { headers: { Upgrade: 'websocket' } })).status, 401)
  assert.equal((await harness.fetch(url('socket-a', '/api/events'), { headers: { Upgrade: 'websocket', Cookie: a.cookie, Origin: 'http://evil.test' } })).status, 403)
  const one = await connect('socket-a', { Cookie: a.cookie })
  const two = await connect('socket-a', { Cookie: a.cookie })
  const other = await connect('socket-b', { Cookie: b.cookie })
  try {
    presence(one.socket, 'viewing')
    await until(() => two.received.some((raw) => raw.includes('viewing')))
    presence(two.socket, 'replying')
    await until(() => one.received.some((raw) => raw.includes('replying')))
    assert.deepEqual((await viewers('socket-a', a.cookie)).viewers[1], [{ userId: 1, name: 'Ada', color: '#6366f1', state: 'replying' }])
    await worker.evictDurableObject('ANSA', { name: 'socket-a', webSockets: 'hibernate' })
    const state = await call<{ constructors: number }>('socket-a', '/__lifecycle')
    assert.ok(state.constructors >= 2, 'the object was reconstructed with accepted sockets')
    assert.equal((await viewers('socket-a', a.cookie)).viewers[1][0].state, 'replying', 'attachments restore presence after hibernation')
    one.received.length = two.received.length = other.received.length = 0
    await call('socket-a', '/__notify?scope=only-a')
    await until(() => one.received.some((raw) => raw.includes('only-a')) && two.received.some((raw) => raw.includes('only-a')))
    assert.deepEqual(other.received, [], 'another workspace receives no event')
    presence(two.socket, null)
    await until(() => one.received.some((raw) => raw.includes('viewing')))
    assert.equal((await viewers('socket-a', a.cookie)).viewers[1][0].state, 'viewing', 'leaving one tab preserves the other tab')
    await worker.evictDurableObject('ANSA', { name: 'socket-a', webSockets: 'hibernate' })
    one.socket.close(1000)
    await until(() => two.received.some((raw) => raw.includes('"viewers":[]')))
    assert.deepEqual((await viewers('socket-a', a.cookie)).viewers, {}, 'close after hibernation means left')
    assert.equal((await call<{ sockets: number }>('socket-a', '/__lifecycle')).sockets, 1, 'the close handshake releases the accepted socket')
  } finally {
    for (const connection of [one, two, other]) {
      if (connection.socket.readyState < 2) connection.socket.close(1000)
    }
  }
})

test('automatic ping replies leave the object asleep and idle workspaces have no alarms', async () => {
  const workspace = 'asleep'
  const { cookie } = await fixture(workspace)
  const connection = await connect(workspace, { Cookie: cookie })
  try {
    const before = await call<{ constructors: number; messages: number; constructorTimers: number; alarm: number | null }>(workspace, '/__lifecycle')
    assert.equal(before.alarm, null)
    assert.equal(before.constructorTimers, 0, 'the constructor starts no JavaScript timers')
    await worker.evictDurableObject('ANSA', { name: workspace, webSockets: 'hibernate' })
    connection.socket.send('ping')
    await until(() => connection.received.includes('pong'))
    await assert.rejects(worker.evictDurableObject('ANSA', { name: workspace, webSockets: 'hibernate' }), /not currently running/, 'the runtime confirms ping left the object asleep')
    const after = await call<typeof before>(workspace, '/__lifecycle')
    assert.equal(after.constructors, before.constructors + 1, 'only the inspection request reconstructed the object; ping did not')
    assert.equal(after.messages, before.messages, 'ping bypassed the JavaScript handler')
    assert.equal(after.alarm, null, 'an open tab adds no alarm')
    assert.equal(after.constructorTimers, 0, 'reconstruction also starts no JavaScript timers')
  } finally {
    connection.socket.close(1000)
  }
})


test('API tokens connect, revoked credentials stop receiving events, and malformed messages close', async () => {
  const workspace = 'socket-auth'
  const { cookie } = await fixture(workspace)
  const token = await call<{ token: { id: number }; secret: string }>(workspace, '/api/tokens', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'ansa' },
    body: JSON.stringify({ name: 'App', access: 'internal' }),
  })
  const app = await connect(workspace, { Authorization: `Bearer ${token.secret}` })
  const browser = await connect(workspace, { Cookie: cookie })
  try {
    presence(app.socket, 'replying')
    await until(() => browser.received.some((raw) => raw.includes('replying')))
    await worker.evictDurableObject('ANSA', { name: workspace, webSockets: 'hibernate' })
    await call(workspace, `/api/tokens/${token.token.id}`, { method: 'DELETE', headers: { Cookie: cookie, 'X-Requested-With': 'ansa' } })
    app.received.length = 0
    const closed = new Promise<number>((resolve) => app.socket.addEventListener('close', (event) => resolve(event.code), { once: true }))
    await call(workspace, '/__notify?scope=private')
    assert.equal(await closed, 1008, 'revoked credentials are closed after reconstruction')
    assert.ok(!app.received.some((raw) => raw.includes('private')), 'a revoked token receives no more events')
    assert.deepEqual((await viewers(workspace, cookie)).viewers, {}, 'revoked sockets no longer appear as viewers')
    const malformed = new Promise<number>((resolve) => browser.socket.addEventListener('close', (event) => resolve(event.code), { once: true }))
    browser.socket.send(JSON.stringify({ type: 'presence', presence: { conversationId: -1, state: 'replying' } }))
    assert.equal(await malformed, 1007, 'invalid socket input does not sign out the client')
  } finally {
    for (const connection of [app, browser]) {
      if (connection.socket.readyState < 2) connection.socket.close(1000)
    }
  }
})


test('expired presence closes sockets with and without an automatic heartbeat after hibernation', async () => {
  for (const ping of [false, true]) {
    const workspace = ping ? 'stale-ping' : 'stale-connect'
    const { cookie } = await fixture(workspace)
    const connection = await connect(workspace, { Cookie: cookie })
    presence(connection.socket, 'viewing')
    await until(() => connection.received.some((raw) => raw.includes('viewing')))
    await worker.evictDurableObject('ANSA', { name: workspace, webSockets: 'hibernate' })
    if (ping) {
      connection.socket.send('ping')
      await until(() => connection.received.includes('pong'))
    }
    const now = Date.now()
    const readAt = (at: number) => call<Record<number, unknown[]>>(workspace, `/__presence-at?at=${at}`)
    assert.equal((await readAt(now + 74_000))[1].length, 1, 'a recent socket remains visible')
    const closed = new Promise<number>((resolve) => connection.socket.addEventListener('close', (event) => resolve(event.code), { once: true }))
    assert.deepEqual(await readAt(now + 76_000), {}, 'a silent socket no longer appears as a viewer')
    assert.equal(await closed, 1000, 'expiry closes the socket without an authentication failure')
  }
})

test('one failed alarm job does not skip later jobs or spin on its overdue deadline', async () => {
  const workspace = 'alarm-failure'
  const { sql } = await fixture(workspace)
  await sql.exec("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('expired', 1, 1, 1)")
  await sql.exec('UPDATE conversations SET snoozed_until = 1')
  await sql.exec("CREATE TRIGGER fail_wake BEFORE UPDATE OF snoozed_until ON conversations BEGIN SELECT RAISE(ABORT, 'wake failure'); END")
  const start = Date.now()
  const result = await call<{ alarm: number }>(workspace, '/__run-alarm')
  assert.ok(result.alarm >= start + 1000, 'an overdue failed job waits at least one second')
  assert.equal((await sql.exec("SELECT id FROM sessions WHERE id = 'expired'")).length, 0, 'session pruning runs after waking snoozes fails')
  await sql.exec('DROP TRIGGER fail_wake')
  await sql.exec('UPDATE conversations SET snoozed_until = NULL')
  await call(workspace, '/__schedule')
})

test('malformed JSON and unsupported frames close without an authentication failure', async () => {
  const workspace = 'invalid-frames'
  const { cookie } = await fixture(workspace)
  for (const [input, code] of [['{', 1007], ['x'.repeat(1025), 1003], [new Uint8Array([1]), 1003]] as const) {
    const connection = await connect(workspace, { Cookie: cookie })
    const closed = new Promise<number>((resolve) => connection.socket.addEventListener('close', (event) => resolve(event.code), { once: true }))
    connection.socket.send(input)
    assert.equal(await closed, code)
  }
})
