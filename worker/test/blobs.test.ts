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
    }
    const mode = r2 ? 'r2' : 'sqlite'
    await checkAttachmentApi((path, init) => send(`api-${mode}`, path, init))
  })
}
