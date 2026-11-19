/** In-process event bus that feeds the browser over Server-Sent Events, plus viewer presence. */
import { currentTenant } from './tenant.ts'

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

export type Listener = (event: AppEvent) => void

export function subscribe(listener: Listener) {
  const { listeners } = currentTenant()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publish(event: AppEvent) {
  for (const listener of currentTenant().listeners) {
    try {
      listener(event)
    } catch {
      /* a broken stream must not stop the others */
    }
  }
}

export interface PresenceEntry extends Viewer {
  seenAt: number
}
const PRESENCE_TTL = 45_000

export function viewersOf(conversationId: number): Viewer[] {
  const { liveEvents } = currentTenant()
  if (liveEvents.kind === 'websocket') return liveEvents.viewers()[conversationId] ?? []
  const entries = currentTenant().presence.get(conversationId)
  if (!entries) return []
  return [...entries.values()].map(({ seenAt: _seenAt, ...viewer }) => viewer)
}

/** Everyone who has a conversation open, by conversation. The conversation list shows them on its rows. */
export function allViewers(): Record<number, Viewer[]> {
  const { liveEvents } = currentTenant()
  if (liveEvents.kind === 'websocket') return liveEvents.viewers()
  prunePresence()
  const all: Record<number, Viewer[]> = {}
  for (const conversationId of currentTenant().presence.keys()) all[conversationId] = viewersOf(conversationId)
  return all
}

export function touchPresence(conversationId: number, viewer: Viewer) {
  const { presence } = currentTenant()
  let entries = presence.get(conversationId)
  if (!entries) presence.set(conversationId, (entries = new Map()))
  const before = entries.get(viewer.userId)
  entries.set(viewer.userId, { ...viewer, seenAt: Date.now() })
  prunePresence()
  if (!before || before.state !== viewer.state) publish({ type: 'presence', conversationId, viewers: viewersOf(conversationId) })
}

export function leavePresence(conversationId: number, userId: number) {
  const { presence } = currentTenant()
  const entries = presence.get(conversationId)
  if (!entries?.delete(userId)) return
  if (entries.size === 0) presence.delete(conversationId)
  publish({ type: 'presence', conversationId, viewers: viewersOf(conversationId) })
}

/** Forget viewers who stopped sending heartbeats. The platform calls this every few seconds. */
export function prunePresence() {
  const { presence } = currentTenant()
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
