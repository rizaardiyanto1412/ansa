import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'

const HOST = 'http://restore.example.test'
const DAY = 24 * 60 * 60 * 1000
const configPath = fileURLToPath(new URL('./wrangler.hosted.jsonc', import.meta.url))
const harness = createTestHarness({ workers: [{ configPath }] })

before(() => harness.listen().then(() => {}))
after(() => harness.close())

const rpc = async (method: string, input: unknown = null) => {
  const response = await harness.fetch(`${HOST}/__rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  return (await response.json()) as { result?: any; error?: { name: string; message: string } }
}

const provisioning = {
  workspaceId: 'restore',
  workspaceName: 'Restore Co',
  appUrl: 'https://restore.hosted.test',
  admin: { name: 'Ada', email: 'ada@restore.test' },
  smtp: { host: 'smtp.postshiba.test', port: 587, security: 'starttls', user: 'tenant-restore', pass: 'smtp-secret-1' },
  planState: { plan: 'trial', mailboxLimit: 1, readOnly: false, hourlySendLimit: 100 },
}

test('restore calls refuse a workspace that was never provisioned', async () => {
  assert.equal((await rpc('restoreBookmark', Date.now() - 1000)).error?.name, 'NotProvisioned')
  assert.equal((await rpc('restoreTo', [Date.now() - 1000, 'restore'])).error?.name, 'NotProvisioned')
})

test('restore times outside the last 30 days are invalid', async () => {
  assert.equal((await rpc('provision', provisioning)).error, undefined)
  const now = Date.now()
  for (const [label, at] of [
    ['the future', now + 60_000],
    ['31 days ago', now - 31 * DAY],
    ['a fraction', now - 1000.5],
    ['a string', 'yesterday'],
    ['null', null],
  ] as const) {
    assert.equal((await rpc('restoreBookmark', at)).error?.name, 'Invalid', `restoreBookmark rejects ${label}`)
    assert.equal((await rpc('restoreTo', [at, 'restore'])).error?.name, 'Invalid', `restoreTo rejects ${label}`)
  }
})

test('restoreTo rejects a confirmation that is not the workspace ID', async () => {
  const at = Date.now() - 1000
  for (const confirm of ['', 'other', 'RESTORE', 'restore ', 'ws/restore', null]) {
    const answer = await rpc('restoreTo', [at, confirm])
    assert.equal(answer.error?.name, 'Invalid', `confirm ${JSON.stringify(confirm)} is rejected`)
    assert.match(answer.error?.message ?? '', /confirmation/)
  }
  assert.equal((await rpc('health')).error, undefined, 'the object kept running after the refusals')
})

test('a confirmed restore asks storage for the bookmark, schedules it, then restarts the object', async () => {
  const at = Date.now() - 5000
  const response = await harness.fetch(`${HOST}/__fake-pitr?at=${at}&confirm=restore`)
  const answer = (await response.json()) as { bookmark: string; calls: unknown[][]; aborted: string }
  assert.equal(answer.bookmark, `bookmark-${at}`, 'restoreBookmark returns the bookmark for that time')
  assert.deepEqual(answer.calls, [
    ['getBookmarkForTime', at],
    ['getBookmarkForTime', at],
    ['onNextSessionRestoreBookmark', `bookmark-${at}`],
    ['abort'],
  ], 'restoreTo reads the bookmark, schedules it, and only then aborts')
  assert.match(answer.aborted, /^aborted: /)
})

test('real PITR runs only where the runtime keeps a change log', async (t) => {
  const answer = await rpc('restoreBookmark', Date.now() - 1000)
  if (answer.error?.message.includes('does not implement point-in-time recovery')) {
    t.skip('local workerd has no durable change log, so a restore round trip cannot run here')
    return
  }
  assert.equal(typeof answer.result, 'string', JSON.stringify(answer))
})
