import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { brand, type Workspace } from './workspace'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { Mailbox, SavedReply, Tag, User, Viewer } from './types'

export interface Session {
  user: User
  appUrl: string
  workspace: Workspace
  refresh: () => void
}
export const SessionContext = createContext<Session | null>(null)
export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside provider')
  return session
}

export const useMailboxes = () => useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/mailboxes').then((r) => r.mailboxes), staleTime: 15_000 })
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: User[] }>('/users').then((r) => r.users), staleTime: 60_000 })
export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: () => api.get<{ tags: Tag[] }>('/tags').then((r) => r.tags), staleTime: 30_000 })
export const useSavedReplies = () =>
  useQuery({ queryKey: ['saved-replies'], queryFn: () => api.get<{ savedReplies: SavedReply[] }>('/saved-replies').then((r) => r.savedReplies), staleTime: 60_000 })

/** Who has which conversation open. Events keep it current; the slow refetch drops people whose tab closed. */
export const usePresence = () =>
  useQuery({ queryKey: ['presence-all'], queryFn: () => api.get<{ viewers: Record<number, Viewer[]> }>('/presence').then((r) => r.viewers), staleTime: 30_000, refetchInterval: 60_000 }).data ?? {}

/** Keep lists and open conversations fresh from the server's event stream. */
export function useLiveEvents() {
  const client = useQueryClient()
  useEffect(() => {
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let pending: ReturnType<typeof setTimeout> | undefined
    const refreshLists = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = undefined
        void client.invalidateQueries({ queryKey: ['conversations'] })
        void client.invalidateQueries({ queryKey: ['mailboxes'] })
      }, 150)
    }
    const connect = () => {
      if (closed || source || document.visibilityState === 'hidden') return
      source = new EventSource('/api/events')
      source.onmessage = (message) => {
        let event: any
        try {
          event = JSON.parse(message.data)
        } catch {
          return
        }
        if (event.type === 'conversation') {
          refreshLists()
          void client.invalidateQueries({ queryKey: ['conversation', event.id] })
          if (event.reason === 'created' || event.reason === 'customer_reply') window.dispatchEvent(new CustomEvent('ansa:incoming', { detail: event }))
        } else if (event.type === 'presence') {
          client.setQueryData(['presence', event.conversationId], event.viewers as Viewer[])
          client.setQueryData(['presence-all'], (old: Record<number, Viewer[]> | undefined) => ({ ...old, [event.conversationId]: event.viewers as Viewer[] }))
        } else if (event.type === 'mailbox') {
          void client.invalidateQueries({ queryKey: ['mailboxes'] })
        } else if (event.type === 'refresh' && event.scope === 'workspace') {
          // An admin changed branding or features: reload them for everyone who is signed in.
          void client.invalidateQueries({ queryKey: ['bootstrap'] })
        } else if (event.type === 'hello') {
          refreshLists()
          void client.invalidateQueries({ queryKey: ['presence-all'] })
        }
      }
      source.onerror = () => {
        disconnect()
        if (!closed) retry = setTimeout(connect, 4000)
      }
    }
    const disconnect = () => {
      source?.close()
      source = null
      clearTimeout(retry)
    }
    // A hidden tab gives its connection back. Browsers allow only six per site over plain HTTP,
    // so many open tabs would otherwise starve each other. Reconnecting refreshes everything.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') disconnect()
      else {
        connect()
        void client.invalidateQueries({ queryKey: ['conversation'] })
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', disconnect)
    window.addEventListener('pageshow', connect)
    connect()
    return () => {
      closed = true
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', disconnect)
      window.removeEventListener('pageshow', connect)
      source?.close()
      clearTimeout(retry)
      clearTimeout(pending)
    }
  }, [client])
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * Global keyboard shortcuts. Keys: "j", "?", "mod+k", "mod+enter", "escape".
 * Plain keys are ignored while the user types in a field or a dialog is open.
 */
export function useHotkeys(bindings: Record<string, (event: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(bindings)
  ref.current = bindings
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
      const combo = `${mod ? 'mod+' : ''}${key}`
      const handler = ref.current[combo]
      if (!handler) return
      if (!mod && key !== 'escape' && (isTyping(e.target) || e.altKey || document.querySelector('[role=dialog]'))) return
      handler(e)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled])
}

export type Theme = 'system' | 'light' | 'dark'
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('ansa-theme') as Theme) || 'system'
    } catch {
      return 'system'
    }
  })
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'dark' || (theme === 'system' && media.matches) ? 'dark' : 'light'
    }
    apply()
    try {
      localStorage.setItem('ansa-theme', theme)
    } catch {
      /* private mode */
    }
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  return [theme, setTheme]
}

export function useLocalState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  return [
    value,
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* private mode */
      }
    },
  ]
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function useDocumentTitle(title: string) {
  const name = brand()
  useEffect(() => {
    document.title = title ? `${title} · ${name}` : name
  }, [title, name])
}
