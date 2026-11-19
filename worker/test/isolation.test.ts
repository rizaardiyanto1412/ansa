import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import type { ProbeReport } from '../../server/test/tenant-probe.ts'

const ROUNDS = 5
const configPath = fileURLToPath(new URL('./wrangler.jsonc', import.meta.url))
const harness = createTestHarness({ workers: [{ configPath }] })

before(() => harness.listen().then(() => {}))
after(() => harness.close())

async function call<T>(workspace: string, path: string, init?: Parameters<typeof harness.fetch>[1]): Promise<T> {
  const response = await harness.fetch(`http://${workspace}.example.test${path}`, init)
  const text = await response.text()
  assert.ok(response.ok, `${workspace} ${path} answered ${response.status}: ${text}`)
  return JSON.parse(text) as T
}

test('two workspaces in one isolate never see each other across async work', async () => {
  for (const workspace of ['a', 'b']) {
    const { appUrl } = await call<{ appUrl: string }>(workspace, '/api/bootstrap')
    assert.equal(appUrl, `http://${workspace}.example.test`, `${workspace} learned its own public URL`)
  }

  const [reportA, reportB] = await Promise.all(['a', 'b'].map((workspace) => call<ProbeReport>(workspace, `/__probe?rounds=${ROUNDS}`)))
  const { interleavings } = await call<{ interleavings: number }>('a', '/__interleavings')

  assert.equal(reportA.steps, reportB.steps, 'both workspaces did the same work')
  assert.ok(interleavings >= reportA.steps, `the work was interleaved in one isolate (${interleavings} switches for ${reportA.steps} steps each)`)
  assert.notEqual(reportA.secretPrint, reportB.secretPrint, 'each workspace has its own secret')
  const sealed = encodeURIComponent(reportA.sealed)
  assert.equal((await call<{ opened: string }>('a', `/__open?sealed=${sealed}`)).opened, 'a', 'a workspace opens its own sealed value')
  assert.equal((await call<{ opened: string }>('b', `/__open?sealed=${sealed}`)).opened, '', "a workspace cannot open another's sealed value")
})

test('setting up one workspace through the app leaves the other untouched', async () => {
  const setup = await call<{ user: { email: string } }>('c', '/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ansa' },
    body: JSON.stringify({ name: 'Ada', email: 'ada@c.example.test', password: 'correct horse battery' }),
  })
  assert.equal(setup.user.email, 'ada@c.example.test', 'the first admin was created')
  assert.equal((await call<{ setupRequired: boolean }>('c', '/api/bootstrap')).setupRequired, false, 'that workspace is set up')
  assert.equal((await call<{ setupRequired: boolean }>('d', '/api/bootstrap')).setupRequired, true, 'another workspace still needs setup')
})

test('the alarm does its work inside its own workspace', async () => {
  const thread = await call<{ state: string; error: string }>('e', '/__alarm')
  assert.equal(thread.state, 'failed', 'the alarm released the reply that was due and tried to deliver it')
  assert.match(thread.error, /no SMTP server/)
})

test('work outside a workspace fails on Workers, where there is no fallback', async () => {
  const response = await harness.fetch('http://a.example.test/__outside')
  assert.equal(response.status, 500)
  assert.match(await response.text(), /No workspace is active/)
})

test('decrypting outside a workspace throws on Workers, and invalid ciphertext inside one gives an empty string', async () => {
  const response = await harness.fetch('http://a.example.test/__decrypt-outside')
  assert.equal(response.status, 500)
  assert.match(await response.text(), /No workspace is active/, 'valid ciphertext outside a workspace')
  assert.equal((await call<{ opened: string }>('a', '/__decrypt-invalid')).opened, '', 'invalid ciphertext inside a workspace')
})

test('hosted mode refuses to start with a shared APP_SECRET', async () => {
  const start = (vars: Record<string, string>) => harness.update({ workers: [{ configPath, vars }] })
  try {
    await start({ ANSA_HOSTED: '1', APP_SECRET: 'x'.repeat(32) })
    const refused = await harness.fetch('http://a.example.test/healthz')
    assert.equal(refused.status, 500)
    assert.match(await refused.text(), /APP_SECRET is set in hosted mode/)

    await harness.update({ workers: [{ configPath, env: 'r2', vars: { ANSA_HOSTED: '1' } }] })
    assert.deepEqual(await call('a', '/healthz'), { ok: true }, 'hosted mode starts without APP_SECRET')

    await start({ APP_SECRET: 'x'.repeat(32) })
    assert.deepEqual(await call('a', '/healthz'), { ok: true }, 'a self-hosted install may set APP_SECRET')
  } finally {
    await start({})
  }
})

test('hosted mode refuses to start without ATTACHMENTS', async () => {
  try {
    await harness.update({ workers: [{ configPath, vars: { ANSA_HOSTED: '1' } }] })
    const response = await harness.fetch('http://missing-bucket.example.test/healthz')
    assert.equal(response.status, 500)
    assert.match(await response.text(), /ATTACHMENTS is required in hosted mode/)
  } finally {
    await harness.update({ workers: [{ configPath }] })
  }
})
