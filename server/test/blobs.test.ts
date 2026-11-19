import { test, after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readConfig } from '../config.ts'
import { openNodeTenant } from '../tenant-node.ts'
import { runInTenant } from '../tenant.ts'
import { createApp, prepareData } from '../app.ts'
import { checkAttachmentApi, checkBlobStore } from './blob-probe.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansa-blobs-'))
const tenant = openNodeTenant(readConfig((key) => ({ DATA_DIR: dataDir, MAIL_DISABLED: '1' })[key]))
after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

test('Node files round-trip, overwrite, and remove blobs', () => checkBlobStore(tenant.blobs))

test('Node attachment upload and download preserve security and disposition rules', async () => {
  await runInTenant(tenant, async () => {
    prepareData()
    const app = createApp()
    await checkAttachmentApi(async (path, init) => app.fetch(new Request(`http://node.example.test${path}`, init)))
  })
})
