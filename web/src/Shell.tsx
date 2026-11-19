import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  AlarmClock,
  Archive,
  AtSign,
  Hourglass,
  ChartNoAxesColumn,
  ChevronDown,
  Inbox,
  Keyboard,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  Sun,
  TriangleAlert,
  UserRound,
  Users,
  UsersRound,
} from 'lucide-react'
import { api, qs } from './lib/api'
import { useDebounced, useHotkeys, useMailboxes, useSession, useTheme, type Theme } from './lib/hooks'
import type { ConversationSummary, Customer, Folder, Mailbox } from './lib/types'
import { Avatar, Kbd, MenuDivider, MenuItem, MenuLabel, Modal, Popover, StatusBadge, cx } from './ui'
import { Logo } from './pages/Auth'
import { brand, workspace } from './lib/workspace'
import { NewConversation, type ComposePrefill } from './inbox/NewConversation'
import { PlanBanner } from './settings/Billing'

interface ShellActions {
  compose: (prefill?: ComposePrefill) => void
  openPalette: () => void
  openShortcuts: () => void
}
const ShellContext = createContext<ShellActions>({ compose: () => {}, openPalette: () => {}, openShortcuts: () => {} })
export const useShell = () => useContext(ShellContext)

export const FOLDERS: { id: Folder; label: string; icon: typeof Inbox; countKey?: 'unassigned' | 'mine' | 'mentioned' | 'assigned' | 'snoozed' | 'spam' }[] = [
  { id: 'unassigned', label: 'Unassigned', icon: Inbox, countKey: 'unassigned' },
  { id: 'mine', label: 'Mine', icon: UserRound, countKey: 'mine' },
  { id: 'mentioned', label: 'Mentioned', icon: AtSign, countKey: 'mentioned' },
  { id: 'assigned', label: 'Assigned', icon: Users, countKey: 'assigned' },
  { id: 'pending', label: 'Waiting on customer', icon: Hourglass },
  { id: 'snoozed', label: 'Snoozed', icon: AlarmClock },
  { id: 'closed', label: 'Closed', icon: Archive },
  { id: 'spam', label: 'Spam', icon: ShieldAlert },
]

/**
 * The Mentioned folder is shown only when the workspace turned it on. With four statuses there is
 * also a folder for conversations that wait on the customer, because they leave the working folders.
 */
export const visibleFolders = () => FOLDERS.filter((f) => (f.id !== 'mentioned' || workspace().mentions) && (f.id !== 'pending' || workspace().fourStatuses))

const folderItem = (active: boolean) =>
  cx(
    'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
    active ? 'bg-surface text-accent-fg shadow-card' : 'text-fg-2 hover:bg-hover hover:text-fg [&>svg]:text-fg-3',
  )

const topLink = (active: boolean) =>
  cx(
    'flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-white',
    active ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white',
  )
const topIcon =
  'flex size-8 shrink-0 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-white disabled:opacity-40 [&>svg]:size-[18px]'

/** The dark bar across the top: product areas on the left, tools and the account menu on the right. */
function TopBar({ mailboxes, current, onMenu }: { mailboxes: Mailbox[]; current?: Mailbox; onMenu?: () => void }) {
  const { user, refresh } = useSession()
  const shell = useShell()
  const navigate = useNavigate()
  const location = useLocation()
  const [theme, setTheme] = useTheme()
  const themes: { id: Theme; label: string; icon: ReactNode }[] = [
    { id: 'light', label: 'Light', icon: <Sun /> },
    { id: 'dark', label: 'Dark', icon: <Moon /> },
    { id: 'system', label: 'Match system', icon: <Monitor /> },
  ]
  const signOut = async () => {
    await api.post('/logout')
    refresh()
  }
  const inInbox = location.pathname.startsWith('/m/') || location.pathname.startsWith('/search')

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 bg-nav px-2 md:px-3">
      {onMenu && (
        <button type="button" aria-label="Open folders" onClick={onMenu} className={cx(topIcon, 'md:hidden')}>
          <MenuIcon />
        </button>
      )}
      <NavLink to="/" aria-label={`${brand()} home`} className="mr-1 flex h-8 items-center gap-2 rounded-md px-1.5 focus-visible:outline-white">
        <Logo size={22} />
        <span className="hidden max-w-40 truncate text-[15px] font-semibold tracking-tight text-white sm:block">{brand()}</span>
      </NavLink>

      <nav className="flex min-w-0 items-center gap-0.5" aria-label="Main">
        <Popover
          width={256}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} className={topLink(inInbox)}>
              Inboxes
              <ChevronDown className="size-3.5 opacity-70" aria-hidden />
            </button>
          )}
        >
          {(close) =>
            mailboxes.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-3">No mailboxes yet.</p>
            ) : (
              <>
                {mailboxes.map((m) => (
                  <MenuItem
                    key={m.id}
                    checked={m.id === current?.id}
                    icon={<span className="size-2 rounded-full" style={{ background: m.color }} />}
                    hint={m.counts.unassigned > 0 ? <span className="text-xs font-semibold tabular-nums">{m.counts.unassigned}</span> : undefined}
                    onSelect={() => {
                      close()
                      navigate(`/m/${m.id}/unassigned`)
                    }}
                  >
                    {m.name}
                  </MenuItem>
                ))}
                {user.role === 'admin' && (
                  <>
                    <MenuDivider />
                    <MenuItem
                      icon={<Settings />}
                      onSelect={() => {
                        close()
                        navigate('/settings/mailboxes')
                      }}
                    >
                      Manage mailboxes
                    </MenuItem>
                  </>
                )}
              </>
            )
          }
        </Popover>
        <NavLink to="/reports" className={({ isActive }) => cx(topLink(isActive), 'hidden sm:flex')}>
          Reports
        </NavLink>
        <NavLink to="/customers" className={({ isActive }) => cx(topLink(isActive), 'hidden sm:flex')}>
          Customers
        </NavLink>
      </nav>

      <span className="flex-1" />

      <button type="button" aria-label="New conversation" title="New conversation (C)" onClick={() => shell.compose()} disabled={mailboxes.length === 0} className={cx(topIcon, 'md:hidden')}>
        <SquarePen />
      </button>
      <button type="button" aria-label="Search" title="Search (⌘K)" onClick={shell.openPalette} className={topIcon}>
        <Search />
      </button>
      <button type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={shell.openShortcuts} className={cx(topIcon, 'hidden sm:flex')}>
        <Keyboard />
      </button>
      <NavLink to="/settings" aria-label="Settings" title="Settings" className={({ isActive }) => cx(topIcon, isActive && 'bg-white/15 text-white')}>
        <Settings />
      </NavLink>
      <Popover
        align="end"
        width={232}
        trigger={({ ref, ...props }) => (
          <button ref={ref} type="button" {...props} aria-label="Account menu" className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-full focus-visible:outline-white">
            <Avatar name={user.name} color={user.color} size={28} />
          </button>
        )}
      >
        {(close) => {
          const go = (path: string) => {
            close()
            navigate(path)
          }
          return (
            <>
              <div className="px-2.5 pt-1.5 pb-2">
                <p className="truncate text-[13px] font-medium">{user.name}</p>
                <p className="truncate text-xs text-fg-3">{user.email}</p>
              </div>
              <MenuDivider />
              <MenuItem icon={<UserRound />} onSelect={() => go('/settings/profile')}>
                Your profile
              </MenuItem>
              <div className="sm:hidden">
                <MenuItem icon={<ChartNoAxesColumn />} onSelect={() => go('/reports')}>
                  Reports
                </MenuItem>
                <MenuItem icon={<UsersRound />} onSelect={() => go('/customers')}>
                  Customers
                </MenuItem>
              </div>
              <MenuDivider />
              <MenuLabel>Theme</MenuLabel>
              {themes.map((t) => (
                <MenuItem key={t.id} icon={t.icon} checked={theme === t.id} onSelect={() => setTheme(t.id)}>
                  {t.label}
                </MenuItem>
              ))}
              <MenuDivider />
              <MenuItem icon={<LogOut />} onSelect={() => void signOut()}>
                Sign out
              </MenuItem>
            </>
          )
        }}
      </Popover>
    </header>
  )
}

/** Folders of the mailbox that is open. Shown beside the conversation list. */
function FolderSidebar({ mailbox, onNavigate }: { mailbox: Mailbox; onNavigate?: () => void }) {
  const shell = useShell()
  return (
    <div className="flex h-full w-[212px] flex-col bg-canvas">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">{mailbox.name}</h2>
        {mailbox.syncStatus === 'error' && (
          <NavLink to={`/settings/mailboxes/${mailbox.id}`} onClick={onNavigate} title={`Cannot fetch mail: ${mailbox.syncError ?? 'unknown error'}`} aria-label="Mailbox connection problem">
            <TriangleAlert className="size-4 text-warn" />
          </NavLink>
        )}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3" aria-label={`${mailbox.name} folders`}>
        <ul className="flex flex-col gap-px">
          {visibleFolders().map((folder) => {
            const count = folder.countKey ? mailbox.counts[folder.countKey] : 0
            const showCount = count > 0 && folder.id !== 'spam'
            return (
              <li key={folder.id}>
                <NavLink to={`/m/${mailbox.id}/${folder.id}`} onClick={onNavigate} className={({ isActive }) => folderItem(isActive)}>
                  <folder.icon aria-hidden />
                  <span className="flex-1">{folder.label}</span>
                  {showCount && <span className="text-xs font-semibold tabular-nums">{count}</span>}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="shrink-0 p-1.5">
        <button
          type="button"
          onClick={() => {
            onNavigate?.()
            shell.compose({ mailboxId: mailbox.id })
          }}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-surface text-[13px] font-medium text-fg-2 shadow-card transition-colors hover:text-fg"
        >
          <SquarePen className="size-4" aria-hidden />
          New conversation
        </button>
      </div>
    </div>
  )
}

export function Shell() {
  const mailboxes = useMailboxes()
  const list = useMemo(() => mailboxes.data ?? [], [mailboxes.data])
  const [compose, setCompose] = useState<ComposePrefill | null>(null)
  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const location = useLocation()
  useEffect(() => setDrawer(false), [location.pathname])
  const match = useMatch('/m/:mailboxId/*')
  const current = list.find((m) => m.id === Number(match?.params.mailboxId))

  const actions = useMemo<ShellActions>(
    () => ({ compose: (prefill) => setCompose(prefill ?? {}), openPalette: () => setPalette(true), openShortcuts: () => setShortcuts(true) }),
    [],
  )

  useHotkeys({
    'mod+k': (e) => {
      e.preventDefault()
      setPalette((open) => !open)
    },
    '/': (e) => {
      e.preventDefault()
      setPalette(true)
    },
    c: (e) => {
      if (list.length === 0) return
      e.preventDefault()
      setCompose(current ? { mailboxId: current.id } : {})
    },
    '?': () => setShortcuts(true),
  })

  return (
    <ShellContext.Provider value={actions}>
      <div className="flex h-full flex-col">
        <TopBar mailboxes={list} current={current} onMenu={current ? () => setDrawer(true) : undefined} />
        <PlanBanner />
        <div className="flex min-h-0 flex-1">
          {current && (
            <aside className="hidden shrink-0 border-r border-line md:block">
              <FolderSidebar mailbox={current} />
            </aside>
          )}
          {current && drawer && (
            <div className="safe-pad animate-fade fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setDrawer(false)}>
              <aside className="h-full w-[212px] border-r border-line shadow-pop" onClick={(e) => e.stopPropagation()}>
                <FolderSidebar mailbox={current} onNavigate={() => setDrawer(false)} />
              </aside>
            </div>
          )}
          <main className="min-h-0 min-w-0 flex-1 bg-surface">
            <Outlet />
          </main>
        </div>
      </div>
      {compose && <NewConversation prefill={compose} mailboxes={list} onClose={() => setCompose(null)} />}
      {palette && <CommandPalette mailboxes={list} onClose={() => setPalette(false)} />}
      <ShortcutsHelp open={shortcuts} onClose={() => setShortcuts(false)} />
    </ShellContext.Provider>
  )
}

// ---------------------------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------------------------

const ITEM =
  'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-fg data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-fg [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-3'
const GROUP = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3'

function CommandPalette({ mailboxes, onClose }: { mailboxes: Mailbox[]; onClose: () => void }) {
  const navigate = useNavigate()
  const shell = useShell()
  const [, setTheme] = useTheme()
  const [query, setQuery] = useState('')
  const term = useDebounced(query.trim(), 180)
  const conversations = useQuery({
    queryKey: ['palette', 'conversations', term],
    queryFn: () => api.get<{ items: ConversationSummary[] }>(`/conversations${qs({ q: term, limit: 6 })}`).then((r) => r.items),
    enabled: term.length > 1,
  })
  const customers = useQuery({
    queryKey: ['palette', 'customers', term],
    queryFn: () => api.get<{ items: Customer[] }>(`/customers${qs({ q: term, limit: 4 })}`).then((r) => r.items),
    enabled: term.length > 1,
  })
  const go = (path: string) => {
    onClose()
    navigate(path)
  }
  const lower = query.trim().toLowerCase()
  const shows = (label: string) => !lower || label.toLowerCase().includes(lower)

  const pages = [
    ...mailboxes.flatMap((m) => visibleFolders().map((f) => ({ label: `${m.name}: ${f.label}`, icon: <f.icon />, path: `/m/${m.id}/${f.id}` }))),
    { label: 'Customers', icon: <UsersRound />, path: '/customers' },
    { label: 'Reports', icon: <ChartNoAxesColumn />, path: '/reports' },
    { label: 'Settings', icon: <Settings />, path: '/settings' },
  ].filter((p) => shows(p.label))
  const commands = [
    { label: 'New conversation', icon: <SquarePen />, run: () => shell.compose() },
    { label: 'Use light theme', icon: <Sun />, run: () => setTheme('light') },
    { label: 'Use dark theme', icon: <Moon />, run: () => setTheme('dark') },
    { label: 'Keyboard shortcuts', icon: <Keyboard />, run: () => shell.openShortcuts() },
  ].filter((c) => shows(c.label))

  return (
    <div className="animate-fade fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Command
        label="Search and commands"
        shouldFilter={false}
        loop
        className="animate-pop w-full max-w-xl overflow-hidden rounded-2xl bg-surface shadow-pop"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-fg-3" aria-hidden />
          <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Search conversations, customers and pages" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-3" />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-sm text-fg-3">{conversations.isFetching ? 'Searching…' : 'Nothing matches that search.'}</Command.Empty>
          {term.length > 1 && (
            <Command.Group heading="Conversations" className={GROUP}>
              {conversations.data?.map((c) => (
                <Command.Item key={c.id} value={`conversation-${c.id}`} onSelect={() => go(`/c/${c.id}`)} className={cx(ITEM, 'h-auto py-1.5')}>
                  <Inbox />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.subject}</span>
                    <span className="block truncate text-xs text-fg-3">
                      {c.customer.name} · {c.preview}
                    </span>
                  </span>
                  <StatusBadge status={c.status} />
                </Command.Item>
              ))}
              <Command.Item value="search-all" onSelect={() => go(`/search${qs({ q: query.trim() })}`)} className={ITEM}>
                <Search />
                <span>
                  Search all conversations for <span className="font-medium">“{query.trim()}”</span>
                </span>
              </Command.Item>
            </Command.Group>
          )}
          {term.length > 1 && !!customers.data?.length && (
            <Command.Group heading="Customers" className={GROUP}>
              {customers.data.map((c) => (
                <Command.Item key={c.id} value={`customer-${c.id}`} onSelect={() => go(`/customers/${c.id}`)} className={ITEM}>
                  <Avatar name={c.name || c.email} size={20} />
                  <span className="truncate">{c.name || c.email}</span>
                  <span className="truncate text-xs text-fg-3">{c.email}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {commands.length > 0 && (
            <Command.Group heading="Actions" className={GROUP}>
              {commands.map((c) => (
                <Command.Item
                  key={c.label}
                  value={c.label}
                  onSelect={() => {
                    onClose()
                    c.run()
                  }}
                  className={ITEM}
                >
                  {c.icon}
                  {c.label}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {pages.length > 0 && (
            <Command.Group heading="Go to" className={GROUP}>
              {pages.map((p) => (
                <Command.Item key={p.path} value={p.path} onSelect={() => go(p.path)} className={ITEM}>
                  {p.icon}
                  {p.label}
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  )
}

const SHORTCUTS: { group: string; items: [string[], string][] }[] = [
  {
    group: 'Anywhere',
    items: [
      [['⌘', 'K'], 'Search and commands'],
      [['C'], 'New conversation'],
      [['?'], 'Show this list'],
    ],
  },
  {
    group: 'Conversation list',
    items: [
      [['J'], 'Next conversation'],
      [['K'], 'Previous conversation'],
      [['Esc'], 'Back to the list'],
    ],
  },
  {
    group: 'Open conversation',
    items: [
      [['R'], 'Reply'],
      [['N'], 'Add a note'],
      [['A'], 'Assign to me'],
      [['E'], 'Close conversation'],
      [['⌘', 'Enter'], 'Send'],
    ],
  },
]

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width={440}>
      <div className="flex flex-col gap-5">
        {SHORTCUTS.map((section) => (
          <section key={section.group}>
            <h3 className="mb-1.5 text-xs font-medium text-fg-3">{section.group}</h3>
            <dl className="flex flex-col">
              {section.items.map(([keys, label]) => (
                <div key={label} className="flex h-8 items-center justify-between border-b border-line last:border-0">
                  <dt className="text-[13px]">{label}</dt>
                  <dd className="flex gap-1">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}
