import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { BlobStore } from './blobs.ts'
import type { Config } from './config.ts'
import type { Driver, SqlValue } from './db.ts'
import { createTenant, type Tenant } from './tenant.ts'

function loadSecret(dataDir: string): string {
  const file = path.join(dataDir, 'secret.key')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

function openDb(dbPath: string): Driver {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')

  const cache = new Map<string, StatementSync>()
  function stmt(sql: string): StatementSync {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      cache.set(sql, s)
    }
    return s
  }
  type Bind = Exclude<SqlValue, never>[]

  return {
    all: (sql, params) => stmt(sql).all(...(params as Bind)) as any[],
    run: (sql, params) => {
      const r = stmt(sql).run(...(params as Bind))
      return { id: Number(r.lastInsertRowid), changes: Number(r.changes) }
    },
    exec: (sql) => db.exec(sql),
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}

function openBlobs(attachmentsDir: string): BlobStore {
  const fileOf = (key: string) => {
    const file = path.join(attachmentsDir, key)
    return file.startsWith(attachmentsDir) ? file : null
  }
  return {
    put: (key, data) => {
      const file = fileOf(key)
      if (!file) throw new Error('Bad file key.')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, data)
    },
    get: (key) => {
      const file = fileOf(key)
      return file && fs.existsSync(file) ? fs.readFileSync(file) : null
    },
    remove: (key) => {
      const file = fileOf(key)
      if (file) fs.rm(file, { force: true }, () => {})
    },
  }
}

export function openNodeTenant(config: Config): Tenant {
  fs.mkdirSync(config.attachmentsDir, { recursive: true })
  return createTenant({
    config: { ...config, secret: config.secret || loadSecret(config.dataDir) },
    db: openDb(config.dbPath),
    blobs: openBlobs(config.attachmentsDir),
  })
}
