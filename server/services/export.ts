import { all } from '../db.ts'
import { blobs, type StoredBlob } from '../blobs.ts'
import { zipStream, type ZipEntry } from '../zip.ts'
import { getWorkspace } from './workspace.ts'

export const EXPORT_OMITTED_TABLES = ['sessions', 'api_tokens', 'one_time_links', 'attempts', 'reset_outbox', 'inbound_seen', 'outbound_log', '_blobs']
export const EXPORT_BLANKED_COLUMNS: Record<string, string[]> = {
  users: ['password_hash'],
  mailboxes: ['smtp_pass_enc', 'imap_pass_enc'],
  apps: ['secret_enc'],
}
const SECRET_SETTING_FIELD = /pass|secret|token|^smtp$|^appId$/i

const ROWS_PER_READ = 200
const FILE_LIMIT = 1024 * 1024 * 1024

const encode = (text: string) => new TextEncoder().encode(text)
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (value instanceof ArrayBuffer) return `X'${Buffer.from(value).toString('hex')}'`
  if (value instanceof Uint8Array) return `X'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}'`
  return `'${String(value).replace(/'/g, "''")}'`
}

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_SETTING_FIELD.test(key))
      .map(([key, inner]) => [key, withoutSecrets(inner)]),
  )
}

function settingWithoutSecrets(value: unknown): unknown {
  try {
    return JSON.stringify(withoutSecrets(JSON.parse(String(value))))
  } catch {
    return value
  }
}

interface Table {
  name: string
  sql: string
}

const exportedTables = () =>
  all<Table>(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`).filter(
    (table) => !/^(sqlite_|_cf_|search(_|$))/.test(table.name) && !EXPORT_OMITTED_TABLES.includes(table.name),
  )

function rowReader(table: Table): () => Record<string, unknown>[] {
  const from = `FROM ${quoted(table.name)}`
  if (/WITHOUT\s+ROWID/i.test(table.sql)) {
    let offset = 0
    return () => {
      const rows = all<Record<string, unknown>>(`SELECT * ${from} LIMIT ${ROWS_PER_READ} OFFSET ?`, offset)
      offset += rows.length
      return rows
    }
  }
  let after = Number.MIN_SAFE_INTEGER
  return () => {
    const rows = all<Record<string, unknown>>(`SELECT rowid AS "#rowid", * ${from} WHERE rowid > ? ORDER BY rowid LIMIT ${ROWS_PER_READ}`, after)
    if (rows.length) after = Number(rows[rows.length - 1]['#rowid'])
    return rows
  }
}

function insertStatement(table: Table, row: Record<string, unknown>): string {
  const blanked = EXPORT_BLANKED_COLUMNS[table.name] ?? []
  const columns = Object.keys(row).filter((column) => column !== '#rowid')
  const values = columns.map((column) => {
    if (blanked.includes(column)) return "''"
    return literal(table.name === 'settings' && column === 'value' ? settingWithoutSecrets(row[column]) : row[column])
  })
  return `INSERT INTO ${quoted(table.name)} (${columns.map(quoted).join(', ')}) VALUES (${values.join(', ')});\n`
}

function* tableFiles(table: Table): Generator<ZipEntry> {
  const read = rowReader(table)
  let finished = false
  for (let file = 1; !finished; file++) {
    yield {
      name: file === 1 ? `sql/${table.name}.sql` : `sql/${table.name}.${file}.sql`,
      data: (function* () {
        let size = 0
        if (file === 1) yield encode(`${table.sql};\n`)
        while (size < FILE_LIMIT) {
          const rows = read()
          if (rows.length === 0) {
            finished = true
            return
          }
          const bytes = encode(rows.map((row) => insertStatement(table, row)).join(''))
          size += bytes.length
          yield bytes
        }
      })(),
    }
  }
}

async function* chunksOf(body: StoredBlob['body']): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body
    return
  }
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

const fileName = (name: string) => {
  const safe = name.replace(/[\\/\x00-\x1f]/g, '_')
  return /^\.*$/.test(safe) ? 'attachment' : safe
}

const README = `This archive holds one workspace.

sql/          One file per table: the table definition, then one INSERT per row.
attachments/  Every stored file, as attachments/<attachment id>/<file name>. The attachments table names them.
brand/        The uploaded logo, when there is one.

Left out on purpose: password hashes, sessions, API tokens, one-time links, saved mail passwords,
sending credentials and the encryption secret.
`

async function* entries(): AsyncGenerator<ZipEntry> {
  yield { name: 'README.txt', data: [encode(README)] }
  for (const table of exportedTables()) yield* tableFiles(table)
  for (let after = 0; ; ) {
    const rows = all<{ id: number; filename: string; storage_key: string }>('SELECT id, filename, storage_key FROM attachments WHERE id > ? ORDER BY id LIMIT ?', after, ROWS_PER_READ)
    if (rows.length === 0) break
    for (const row of rows) {
      after = row.id
      const blob = await blobs.get(row.storage_key)
      if (blob) yield { name: `attachments/${row.id}/${fileName(row.filename)}`, data: chunksOf(blob.body) }
    }
  }
  const logo = getWorkspace().logo
  const image = logo ? await blobs.get(logo.key) : null
  if (logo && image) yield { name: `brand/logo.${logo.mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'img'}`, data: chunksOf(image.body) }
}

export const exportArchive = (): AsyncGenerator<Uint8Array> => zipStream(entries())

export const exportFileName = (at = new Date()) => `ansa-export-${at.toISOString().slice(0, 10)}.zip`
