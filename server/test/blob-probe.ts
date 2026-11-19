import assert from 'node:assert/strict'
import { z } from 'zod'
import type { BlobStore } from '../blobs.ts'

export async function checkBlobStore(store: BlobStore, streamed = false) {
  const key = 'round-trip/file.bin'
  assert.equal(await store.get(key), null)
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, i) => i % 251)
  for (const data of [bytes, new Uint8Array(), new TextEncoder().encode('replacement')]) {
    await store.put(key, data)
    const saved = await store.get(key)
    assert.ok(saved, 'a stored blob exists, including an empty one')
    assert.equal(saved.body instanceof ReadableStream, streamed, 'R2 returns a stream instead of buffering the object')
    assert.equal(saved.size, data.byteLength)
    assert.deepEqual(new Uint8Array(await new Response(saved.body).arrayBuffer()), data)
  }
  await store.remove([key])
  assert.equal(await store.get(key), null, 'remove finishes before it resolves')
  await store.remove([key])
  const batch = ['batch/first', 'batch/second', 'batch/third']
  for (const key of batch) await store.put(key, bytes.subarray(0, 4))
  await store.put('batch/retained', bytes.subarray(0, 4))
  await store.remove([...batch, batch[0], 'batch/missing'])
  for (const key of batch) assert.equal(await store.get(key), null, 'batch removal deletes every requested blob')
  await store.remove([])
  assert.ok(await store.get('batch/retained'), 'batch removal leaves unrequested blobs intact')
  await store.remove(['batch/retained'])
}

export async function checkAttachmentApi(send: (path: string, init?: RequestInit) => Promise<Response>) {
  const setup = await send('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ansa' },
    body: JSON.stringify({ name: 'Agent', email: 'agent@example.test', password: 'attachment test password' }),
  })
  assert.equal(setup.status, 200, await setup.text())
  const cookie = setup.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const headers = { Cookie: cookie, 'X-Requested-With': 'ansa' }
  for (const [mime, name, inline] of [['text/plain', "notes (today)'.txt", true], ['text/html', 'page.html', false]] as const) {
    const form = new FormData()
    form.set('file', new File(['attachment bytes'], name, { type: mime }))
    const upload = await send('/api/attachments', { method: 'POST', headers, body: form })
    assert.equal(upload.status, 201)
    const { attachment } = z.object({ attachment: z.object({ url: z.string(), size: z.number() }) }).parse(await upload.json())
    assert.equal(attachment.size, 16)
    const anonymous = await send(attachment.url)
    assert.equal(anonymous.status, 401)
    for (const force of [false, true]) {
      const download = await send(attachment.url + (force ? '?download' : ''), { headers })
      assert.equal(download.status, 200)
      assert.equal(download.headers.get('content-type'), inline && !force ? mime : 'application/octet-stream')
      assert.equal(download.headers.get('content-length'), '16')
      const encoded = encodeURIComponent(name).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      assert.equal(download.headers.get('content-disposition'), `${inline && !force ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`)
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(download.headers.get('content-security-policy'), "default-src 'none'; sandbox")
      assert.equal(await download.text(), 'attachment bytes')
    }
  }
  assert.equal((await send('/api/attachments/999999/no.txt', { headers })).status, 404)
  const logo = new FormData()
  logo.set('file', new File(['logo bytes'], 'logo.png', { type: 'image/png' }))
  assert.equal((await send('/api/workspace/logo', { method: 'POST', headers, body: logo })).status, 200)
  const image = await send('/api/brand/logo')
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(await image.text(), 'logo bytes')
  assert.equal((await send('/api/workspace/logo', { method: 'DELETE', headers })).status, 200)
  assert.equal((await send('/api/brand/logo')).status, 404)
}
