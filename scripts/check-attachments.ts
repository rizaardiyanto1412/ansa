import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { checkAttachmentApi } from '../server/test/blob-probe.ts'

const root = path.resolve(import.meta.dirname, '..')
await mkdir(path.join(root, '.wrangler'), { recursive: true })
const scratch = await mkdtemp(path.join(root, '.wrangler/attachment-smoke-'))

try {
  for (const [index, mode] of ['node', 'sqlite', 'r2'].entries()) {
    const port = 18870 + index
    const origin = `http://127.0.0.1:${port}`
    const dataDir = path.join(scratch, mode)
    await mkdir(dataDir)
    const configPath = path.join(dataDir, 'wrangler.json')
    await writeFile(configPath, JSON.stringify({
      name: `ansa-attachment-smoke-${mode}`,
      main: path.join(root, 'worker/index.ts'),
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      durable_objects: { bindings: [{ name: 'ANSA', class_name: 'AnsaStore' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['AnsaStore'] }],
      vars: { MAIL_DISABLED: '1', APP_URL: origin },
      ...(mode === 'r2' ? { r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'ansa-attachment-smoke' }] } : {}),
    }))
    const child = mode === 'node'
      ? spawn(process.execPath, ['dist/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, MAIL_DISABLED: '1', APP_URL: origin } })
      : spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--config', configPath, '--port', String(port), '--persist-to', path.join(dataDir, 'state')], { cwd: root })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      const deadline = Date.now() + 30_000
      for (;;) {
        assert.equal(child.exitCode, null, output)
        assert.ok(Date.now() < deadline, `startup timed out: ${output}`)
        const ready = await fetch(`${origin}/healthz`).catch(() => null)
        if (ready?.ok) { await ready.text(); break }
        await setTimeout(100)
      }
      await checkAttachmentApi((route, init) => fetch(`${origin}${route}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'Accept-Encoding': 'identity' } }))
      console.log(`${mode}: attachment upload, download, disposition, authentication, and logos passed`)
    } catch (err) {
      throw new Error(`${mode}: ${output}`, { cause: err })
    } finally {
      child.kill('SIGTERM')
      await exited
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
