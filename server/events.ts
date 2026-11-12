/** In-process event bus that feeds the browser over Server-Sent Events, plus viewer presence. */

export type AppEvent =
  | { type: 'conversation'; id: number; mailboxId: number; reason: string; actorId?: number | null }
  | { type: 'presence'; conversationId: number; viewers: Viewer[] }
  | { type: 'mailbox'; id: number }
  | { type: 'refresh'; scope: string }

export interface Viewer {
  userId: number
  name: string
  color: string
  state: 'viewing' | 'replying'
}

type Listener = (event: AppEvent) => void
const listeners = new Set<Listener>()

export function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publish(event: AppEvent) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      /* a broken stream must not stop the others */
    }
  }
}

interface PresenceEntry extends Viewer {
  seenAt: number
}
const presence = new Map<number, Map<number, PresenceEntry>>()
const PRESENCE_TTL = 45_000

export function viewersOf(conversationId: number): Viewer[] {
  const entries = presence.get(conversationId)
  if (!entries) return []
  return [...entries.values()].map(({ seenAt: _seenAt, ...viewer }) => viewer)
}

/** Everyone who has a conversation open, by conversation. The conversation list shows them on its rows. */
export function allViewers(): Record<number, Viewer[]> {
  prunePresence()
  const all: Record<number, Viewer[]> = {}
  for (const conversationId of presence.keys()) all[conversationId] = viewersOf(conversationId)
  return all
}

export function touchPresence(conversationId: number, viewer: Viewer) {
  let entries = presence.get(conversationId)
  if (!entries) presence.set(conversationId, (entries = new Map()))
  const before = entries.get(viewer.userId)
  entries.set(viewer.userId, { ...viewer, seenAt: Date.now() })
  // On Cloudflare no timer runs between requests, so each heartbeat also clears out people who left.
  prunePresence()
  if (!before || before.state !== viewer.state) publish({ type: 'presence', conversationId, viewers: viewersOf(conversationId) })
}

export function leavePresence(conversationId: number, userId: number) {
  const entries = presence.get(conversationId)
  if (!entries?.delete(userId)) return
  if (entries.size === 0) presence.delete(conversationId)
  publish({ type: 'presence', conversationId, viewers: viewersOf(conversationId) })
}

/** Forget viewers who stopped sending heartbeats. The platform calls this every few seconds. */
export function prunePresence() {
  const cutoff = Date.now() - PRESENCE_TTL
  for (const [conversationId, entries] of presence) {
    let changed = false
    for (const [userId, entry] of entries) {
      if (entry.seenAt < cutoff) {
        entries.delete(userId)
        changed = true
      }
    }
    if (entries.size === 0) presence.delete(conversationId)
    if (changed) publish({ type: 'presence', conversationId, viewers: viewersOf(conversationId) })
  }
}
