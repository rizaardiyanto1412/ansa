/**
 * One workspace's half of the isolation check. Two workspaces run it at the same time, in one process on Node
 * and in one isolate on workerd. Both use the same keys and row ids, so any shared state shows up as a mismatch.
 */
import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'
import { blobs } from '../blobs.ts'
import { config } from '../config.ts'
import { decrypt, encrypt, sha256 } from '../crypto.ts'
import { all, get, getSetting, run, setSetting } from '../db.ts'
import { publish, subscribe, type AppEvent } from '../events.ts'
import { addReply, createConversation } from '../services/conversations.ts'
import { bindTenant } from '../tenant.ts'

export interface ProbeInput {
  name: string
  appUrl: string
  /** Emits "tick" from outside the workspace, the way a mail library fires socket events. */
  bus: EventEmitter
  rounds: number
}

export interface ProbeReport {
  name: string
  secretPrint: string
  sealed: string
  steps: number
}

const BLOB_KEY = 'probe/file.txt'
const WAIT_MS = 10_000

// Shared by every workspace in the process or isolate, like the globals the tenant replaces.
export const journal: string[] = []
const running = new Set<string>()

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean) {
  const deadline = Date.now() + WAIT_MS
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await sleep(1)
  }
}

type Hop = (work: () => void) => Promise<void>

const settled = (defer: (callback: () => void) => void): Hop => (work) =>
  new Promise<void>((resolve, reject) =>
    defer(() => {
      try {
        work()
        resolve()
      } catch (err) {
        reject(err)
      }
    }),
  )

const hopsFor = (bus: EventEmitter): Record<string, Hop> => ({
  await: async (work) => {
    await null
    work()
  },
  'promise chain': (work) =>
    Promise.resolve()
      .then(() => sleep(0))
      .then(work),
  setImmediate: settled((callback) => setImmediate(callback)),
  setTimeout: settled((callback) => setTimeout(callback, 1)),
  setInterval: settled((callback) => {
    const timer = setInterval(() => {
      clearInterval(timer)
      callback()
    }, 1)
  }),
  queueMicrotask: settled((callback) => queueMicrotask(callback)),
  'emitter callback': settled((callback) => bus.once('tick', bindTenant(callback))),
})

export async function probe({ name, appUrl, bus, rounds }: ProbeInput): Promise<ProbeReport> {
  const secret = config.secret
  const sealed = encrypt(name)
  const seen: AppEvent[] = []
  const unsubscribe = subscribe((event) => seen.push(event))
  let published = 0

  setSetting('probe', name)
  blobs.put(BLOB_KEY, new TextEncoder().encode(name))
  const mailboxId = run(`INSERT INTO mailboxes (name, email, created_at) VALUES (?, 'support@shared.test', 1)`, name).id
  const agentId = run(`INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, 'agent@shared.test', 'x', 'admin', 1)`, name).id
  const conversation = createConversation({ mailboxId, customerEmail: 'customer@shared.test', subject: name, bodyHtml: `<p>${name}</p>`, kind: 'customer' }, { userId: null, via: 'email' })

  const mine = (where: string) => {
    assert.equal(config.appUrl, appUrl, `${name}: its own public URL after ${where}`)
    assert.equal(config.secret, secret, `${name}: its own secret after ${where}`)
    assert.equal(decrypt(sealed), name, `${name}: opens what it sealed after ${where}`)
    assert.equal(getSetting('probe', ''), name, `${name}: its own setting after ${where}`)
    assert.deepEqual(all<{ subject: string }>('SELECT subject FROM conversations').map((row) => row.subject), [name], `${name}: only its own conversations after ${where}`)
    assert.deepEqual(all<{ name: string }>('SELECT name FROM mailboxes').map((row) => row.name), [name], `${name}: only its own mailboxes after ${where}`)
    assert.equal(new TextDecoder().decode(blobs.get(BLOB_KEY) ?? new Uint8Array()), name, `${name}: its own file after ${where}`)
    const refreshes = seen.flatMap((event) => (event.type === 'refresh' ? [event.scope] : []))
    assert.deepEqual(refreshes, Array(published).fill(name), `${name}: only its own live events after ${where}`)
  }

  running.add(name)
  try {
    await until('the other workspace to start in the same process', () => running.size > 1)
    let steps = 0
    for (let round = 0; round < rounds; round++) {
      for (const [where, hop] of Object.entries(hopsFor(bus))) {
        await hop(() => {
          mine(where)
          setSetting('probe', name)
          blobs.put(BLOB_KEY, new TextEncoder().encode(name))
          publish({ type: 'refresh', scope: name })
          published++
          journal.push(name)
          steps++
        })
        await until('the other workspace to take a turn', () => journal.at(-1) !== name || running.size < 2)
      }
    }

    const threadId = addReply(conversation.id, { bodyHtml: `<p>Reply from ${name}</p>` }, { userId: agentId, via: 'web' })
    const state = () => get<{ state: string; error: string | null }>('SELECT state, error FROM threads WHERE id = ?', threadId)!
    assert.equal(state().state, 'sending', `${name}: the reply is queued for delivery`)
    await until('the queued delivery to finish', () => state().state !== 'sending')
    assert.match(state().error ?? '', /no SMTP server/, `${name}: the queued delivery ran against its own mailbox`)
    assert.ok(
      seen.some((event) => event.type === 'conversation' && event.reason === 'send_failed'),
      `${name}: the delivery result reached its own live stream`,
    )
    mine('the queued delivery')
    return { name, secretPrint: sha256(secret), sealed, steps }
  } finally {
    running.delete(name)
    unsubscribe()
  }
}

export const openSealed = (sealed: string) => decrypt(sealed)

export const interleavings = () => journal.filter((name, index) => index > 0 && journal[index - 1] !== name).length
