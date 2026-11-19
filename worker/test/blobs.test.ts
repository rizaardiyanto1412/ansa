import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { checkAttachmentApi } from '../../server/test/blob-probe.ts'

const configPath = fileURLToPath(new URL('./wrangler.jsonc', import.meta.url))
const harness = createTestHarness({ workers: [{ configPath }] })
before(() => harness.listen().then(() => {}))
after(() => harness.close())

for (const r2 of [false, true]) {
  test(`${r2 ? 'R2' : 'DO SQLite'} blobs and API downloads inside workerd`, async () => {
    await harness.update({ workers: [{ configPath, env: r2 ? 'r2' : undefined }] })
    const send = async (workspace: string, path: string, init?: RequestInit) => {
      const request = new Request(`http://${workspace}.example.test${path}`, init)
      const response = await harness.fetch(request.url, {
        method: request.method,
        headers: { ...Object.fromEntries(request.headers), 'Accept-Encoding': 'identity' },
        body: request.body ? await request.arrayBuffer() : undefined,
      })
      return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) })
    }
    for (const workspace of ['first', 'second']) {
      assert.equal((await send(workspace, '/__workspace')).status, 200)
      const result = await send(workspace, '/__blobs')
      assert.equal(result.status, 200, await result.text())
    }
    await Promise.all(['first', 'second'].map(async (workspace) => {
      const response = await send(workspace, '/__blob', { method: 'PUT', body: workspace })
      assert.equal(await response.text(), workspace)
    }))
    for (const workspace of ['first', 'second']) assert.equal(await (await send(workspace, '/__blob')).text(), workspace)
    assert.equal((await send('first', '/__blob', { method: 'DELETE' })).status, 404)
    assert.equal(await (await send('second', '/__blob')).text(), 'second')
    if (r2) {
      const { ATTACHMENTS: bucket } = await harness.getWorker<{ ATTACHMENTS: { get(key: string): Promise<{ text(): Promise<string> } | null> } }>().getEnv()
      assert.equal(await (await bucket.get('ws/second/same/key.txt'))?.text(), 'second')
      assert.equal(await bucket.get('ws/first/same/key.txt'), null)
      assert.equal((await send('self-hosted', '/__blob', { method: 'PUT', body: 'fallback' })).status, 200)
      assert.equal(await (await bucket.get('ws/main/same/key.txt'))?.text(), 'fallback')
      assert.equal((await send('self-hosted', '/__blob', { method: 'DELETE' })).status, 404)
    }
    const mode = r2 ? 'r2' : 'sqlite'
    await checkAttachmentApi((path, init) => send(`api-${mode}`, path, init))
  })
}

test('hosted R2 rejects unprovisioned and invalid workspace IDs', async () => {
  await harness.update({ workers: [{ configPath, env: 'r2', vars: { ANSA_HOSTED: '1' } }] })
  const send = (path: string, init?: Parameters<typeof harness.fetch>[1]) => harness.fetch(`http://hosted.example.test${path}`, init)
  const missing = await send('/__blob', { method: 'PUT', body: 'must not be stored' })
  assert.equal(missing.status, 500)
  assert.match(await missing.text(), /NotProvisioned/)
  for (const id of ['', '../other', 'with/slash', 'with space', 'x'.repeat(65), 'é', 'trailing\n']) {
    await send(`/__workspace?id=${encodeURIComponent(id)}`)
    for (const method of ['PUT', 'GET', 'DELETE']) {
      const response = await send('/__blob', { method, ...(method === 'PUT' ? { body: 'invalid' } : {}) })
      assert.equal(response.status, 500, `${method} rejects workspace ID ${JSON.stringify(id)}`)
      assert.match(await response.text(), /Invalid/)
    }
  }
  for (const id of ['a', 'A_z-9', 'x'.repeat(64)]) {
    await send(`/__workspace?id=${id}`)
    const response = await send('/__blob', { method: 'PUT', body: id })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), id)
  }
  const { ATTACHMENTS: bucket } = await harness.getWorker<{ ATTACHMENTS: { get(key: string): Promise<unknown> } }>().getEnv()
  assert.equal(await bucket.get('ws/main/same/key.txt'), null, 'hosted writes never use the self-hosted prefix')
})

test('R2 removes more than 1000 blobs without deleting other workspace objects', async () => {
  await harness.update({ workers: [{ configPath, env: 'r2' }] })
  const { ATTACHMENTS: bucket } = await harness.getWorker<{ ATTACHMENTS: {
    put(key: string, value: string): Promise<unknown>
    get(key: string): Promise<{ text(): Promise<string> } | null>
    list(options: { prefix: string }): Promise<{ objects: { key: string }[] }>
  } }>().getEnv()
  await Promise.all(Array.from({ length: 1001 }, (_, i) => bucket.put(`ws/bulk/batch/${i}`, 'delete')))
  await bucket.put('ws/bulk/retained', 'keep')
  await bucket.put('ws/other/batch/0', 'other workspace')
  assert.equal((await harness.fetch('http://bulk.example.test/__workspace')).status, 200)
  const removed = await harness.fetch('http://bulk.example.test/__remove-batch', { method: 'DELETE' })
  assert.equal(removed.status, 200, await removed.text())
  assert.deepEqual((await bucket.list({ prefix: 'ws/bulk/batch/' })).objects, [])
  assert.equal(await (await bucket.get('ws/bulk/retained'))?.text(), 'keep')
  assert.equal(await (await bucket.get('ws/other/batch/0'))?.text(), 'other workspace')
})
