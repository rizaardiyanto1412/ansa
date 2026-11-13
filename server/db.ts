/**
 * Database access. The engine is SQLite everywhere; the driver differs per platform:
 * node:sqlite on a server (platform-node.ts), Durable Object storage on Cloudflare (worker/).
 */
export type SqlValue = string | number | bigint | null | Uint8Array
export interface Driver {
  all(sql: string, params: SqlValue[]): any[]
  run(sql: string, params: SqlValue[]): { id: number; changes: number }
  /** Run one or more statements without parameters. */
  exec(sql: string): void
  transaction<T>(fn: () => T): T
}

let driver: Driver | null = null
export function initDb(next: Driver) {
  driver = next
}
const use = (): Driver => {
  if (!driver) throw new Error('The database is not ready. Load a platform module first.')
  return driver
}

type Param = string | number | bigint | null | undefined | boolean | Uint8Array

const norm = (params: Param[]) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as SqlValue[]

export function all<T = any>(sql: string, ...params: Param[]): T[] {
  return use().all(sql, norm(params)) as T[]
}
export function get<T = any>(sql: string, ...params: Param[]): T | undefined {
  return use().all(sql, norm(params))[0] as T | undefined
}
export function run(sql: string, ...params: Param[]) {
  return use().run(sql, norm(params))
}

/** Query with ":name" placeholders. They are rewritten to positional ones, which every driver supports. */
export function allNamed<T = any>(sql: string, params: Record<string, Param>): T[] {
  const values: Param[] = []
  const positional = sql.replace(/(?<![:\w]):([a-zA-Z_]\w*)/g, (match, name: string) => {
    if (!(name in params)) return match
    values.push(params[name])
    return '?'
  })
  return all<T>(positional, ...values)
}

let depth = 0
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn()
  depth++
  try {
    return use().transaction(fn)
  } finally {
    depth--
  }
}

export const now = () => Date.now()

const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent',
    color TEXT NOT NULL DEFAULT '#6366f1',
    signature TEXT NOT NULL DEFAULT '',
    notify_assigned INTEGER NOT NULL DEFAULT 1,
    notify_replies INTEGER NOT NULL DEFAULT 1,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE mailboxes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    from_name TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#6366f1',
    signature TEXT NOT NULL DEFAULT '',
    smtp_host TEXT NOT NULL DEFAULT '',
    smtp_port INTEGER NOT NULL DEFAULT 587,
    smtp_security TEXT NOT NULL DEFAULT 'starttls',
    smtp_user TEXT NOT NULL DEFAULT '',
    smtp_pass_enc TEXT NOT NULL DEFAULT '',
    imap_enabled INTEGER NOT NULL DEFAULT 0,
    imap_host TEXT NOT NULL DEFAULT '',
    imap_port INTEGER NOT NULL DEFAULT 993,
    imap_security TEXT NOT NULL DEFAULT 'ssl',
    imap_user TEXT NOT NULL DEFAULT '',
    imap_pass_enc TEXT NOT NULL DEFAULT '',
    imap_folder TEXT NOT NULL DEFAULT 'INBOX',
    imap_uidvalidity TEXT,
    imap_last_uid INTEGER,
    import_existing INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'idle',
    sync_error TEXT,
    last_sync_at INTEGER,
    auto_reply_enabled INTEGER NOT NULL DEFAULT 0,
    auto_reply_subject TEXT NOT NULL DEFAULT '',
    auto_reply_body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL COLLATE NOCASE,
    company TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE customer_emails (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE INDEX customer_emails_customer ON customer_emails(customer_id);
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    subject TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    preview TEXT NOT NULL DEFAULT '',
    cc TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'email',
    thread_count INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    snoozed_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_customer_at INTEGER,
    last_agent_at INTEGER,
    first_reply_at INTEGER,
    waiting_since INTEGER,
    closed_at INTEGER,
    closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX conversations_folder ON conversations(mailbox_id, status, assignee_id, updated_at);
  CREATE INDEX conversations_customer ON conversations(customer_id, updated_at);
  CREATE INDEX conversations_created ON conversations(created_at);
  CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    body_html TEXT NOT NULL DEFAULT '',
    body_full_html TEXT,
    body_text TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_addrs TEXT NOT NULL DEFAULT '[]',
    cc TEXT NOT NULL DEFAULT '[]',
    bcc TEXT NOT NULL DEFAULT '[]',
    message_id TEXT,
    in_reply_to TEXT,
    refs TEXT,
    state TEXT NOT NULL DEFAULT 'sent',
    error TEXT,
    event TEXT,
    via TEXT NOT NULL DEFAULT 'web',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX threads_conversation ON threads(conversation_id, created_at);
  CREATE INDEX threads_message_id ON threads(message_id);
  CREATE INDEX threads_created ON threads(type, created_at);
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL,
    content_id TEXT,
    inline INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_thread ON attachments(thread_id);
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#64748b',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE conversation_tags (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, tag_id)
  );
  CREATE INDEX conversation_tags_tag ON conversation_tags(tag_id);
  CREATE TABLE saved_replies (
    id INTEGER PRIMARY KEY,
    mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    body_html TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE workflows (
    id INTEGER PRIMARY KEY,
    mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger TEXT NOT NULL DEFAULT 'new',
    match TEXT NOT NULL DEFAULT 'all',
    conditions TEXT NOT NULL DEFAULT '[]',
    actions TEXT NOT NULL DEFAULT '[]',
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE drafts (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'reply',
    body_html TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE search USING fts5(subject, body, customer, tokenize = 'porter unicode61 remove_diacritics 2');
  `,
  `
  CREATE TABLE apps (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    sidebar_mode TEXT NOT NULL DEFAULT 'none',
    sidebar_content TEXT NOT NULL DEFAULT '',
    sidebar_url TEXT NOT NULL DEFAULT '',
    webhook_url TEXT NOT NULL DEFAULT '',
    events TEXT NOT NULL DEFAULT '[]',
    mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
    secret_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE app_deliveries (
    id INTEGER PRIMARY KEY,
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    event TEXT NOT NULL,
    conversation_id INTEGER,
    ok INTEGER NOT NULL,
    status INTEGER,
    detail TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX app_deliveries_app ON app_deliveries(app_id, id);
  `,
  `
  CREATE TABLE mentions (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX mentions_user ON mentions(user_id, conversation_id);
  ALTER TABLE users ADD COLUMN notify_mentions INTEGER NOT NULL DEFAULT 1;
  `,
  `
  CREATE TABLE import_map (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    external_number INTEGER,
    PRIMARY KEY (source, external_id)
  ) WITHOUT ROWID;
  `,
  `
  -- Send later: a reply with state 'scheduled' waits here until send_at.
  ALTER TABLE threads ADD COLUMN send_at INTEGER;
  CREATE INDEX threads_send_at ON threads(send_at) WHERE send_at IS NOT NULL;
  `,
  `
  -- A teammate can keep a reply draft and a note draft on one conversation at the same time.
  CREATE TABLE drafts_by_kind (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'reply',
    body_html TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id, kind)
  );
  INSERT INTO drafts_by_kind SELECT conversation_id, user_id, kind, body_html, updated_at FROM drafts;
  DROP TABLE drafts;
  ALTER TABLE drafts_by_kind RENAME TO drafts;
  `,
  `ALTER TABLE api_tokens ADD COLUMN access TEXT NOT NULL DEFAULT 'full';`,
]

export function migrate() {
  use().exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = (get<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM _migrations')?.n ?? 0)
  for (let i = applied; i < migrations.length; i++) {
    tx(() => {
      use().exec(migrations[i])
      run('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', i + 1, now())
    })
    console.log(`[db] applied migration ${i + 1}`)
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}
export function setSetting(key: string, value: unknown) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
}

export const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
