import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config, readConfig } from '../config.ts'
import { get, getSetting, migrate } from '../db.ts'
import { decrypt, encrypt } from '../crypto.ts'
import { bindTenant, runInTenant } from '../tenant.ts'
import { openNodeTenant } from '../tenant-node.ts'
import { interleavings, openSealed, probe } from './tenant-probe.ts'

const ROUNDS = 5

function workspace(name: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `ansa-tenant-${name}-`))
  const appUrl = `https://${name}.example.test`
  const tenant = openNodeTenant(readConfig((key) => ({ DATA_DIR: dataDir, APP_URL: appUrl })[key]))
  runInTenant(tenant, migrate)
  return { name, appUrl, tenant }
}

const a = workspace('a')
const b = workspace('b')

test('two workspaces in one process never see each other across async work', async () => {
  const bus = new EventEmitter()
  const callers = [(emit: () => void) => emit(), (emit: () => void) => runInTenant(a.tenant, emit), (emit: () => void) => runInTenant(b.tenant, emit)]
  let ticks = 0
  const pump = setInterval(() => callers[ticks++ % callers.length](() => bus.emit('tick')), 1)
  try {
    const [reportA, reportB] = await Promise.all([a, b].map(({ name, appUrl, tenant }) => runInTenant(tenant, () => probe({ name, appUrl, bus, rounds: ROUNDS }))))

    assert.equal(reportA.steps, reportB.steps, 'both workspaces did the same work')
    assert.ok(interleavings() >= reportA.steps, `the work was interleaved (${interleavings()} switches for ${reportA.steps} steps each)`)
    assert.notEqual(reportA.secretPrint, reportB.secretPrint, 'each workspace has its own secret')
    assert.equal(runInTenant(a.tenant, () => openSealed(reportA.sealed)), 'a', 'a workspace opens its own sealed value')
    assert.equal(runInTenant(b.tenant, () => openSealed(reportA.sealed)), '', "a workspace cannot open another's sealed value")
  } finally {
    clearInterval(pump)
  }
})

test('work outside a workspace fails instead of reaching one', () => {
  assert.throws(() => get('SELECT 1'), /No workspace is active/, 'a query')
  assert.throws(() => config.appUrl, /No workspace is active/, 'a setting')
  assert.throws(() => bindTenant(() => {}), /No workspace is active/, 'binding a callback')
})

test('decrypting outside a workspace throws, and invalid ciphertext inside one gives an empty string', () => {
  const sealed = runInTenant(a.tenant, () => encrypt('hunter2'))
  assert.throws(() => decrypt(sealed), /No workspace is active/, 'valid ciphertext outside a workspace')
  assert.equal(runInTenant(a.tenant, () => decrypt(sealed)), 'hunter2', 'valid ciphertext inside the workspace')
  assert.equal(runInTenant(a.tenant, () => decrypt('v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA')), '', 'invalid ciphertext')
  assert.equal(runInTenant(b.tenant, () => decrypt(sealed)), '', "another workspace's key")
})

test('a bound callback returns to its own workspace wherever it is called from', () => {
  const read = () => getSetting('probe', '')
  const boundToA = runInTenant(a.tenant, () => bindTenant(read))
  assert.equal(runInTenant(b.tenant, read), 'b', 'an unbound callback sees its caller')
  assert.equal(runInTenant(b.tenant, boundToA), 'a', 'called from another workspace')
  assert.equal(boundToA(), 'a', 'called from outside any workspace')
})
