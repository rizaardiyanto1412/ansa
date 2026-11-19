import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from './lib/api'
import { SessionContext, useLiveEvents, useMailboxes, useSession } from './lib/hooks'
import type { Conversation, PlanState, User } from './lib/types'
import { Spinner } from './ui'
import { applyWorkspace, brand, workspace, type Workspace } from './lib/workspace'
import { Login, Setup } from './pages/Auth'
import { ForgotPassword, LinkPage } from './pages/Account'
import { Shell } from './Shell'
import { InboxPage } from './inbox/InboxPage'
import { CustomersPage } from './pages/Customers'
import { ReportsPage } from './pages/Reports'
import { SettingsPage } from './settings/SettingsPage'
import { Welcome } from './pages/Welcome'

interface Bootstrap {
  setupRequired: boolean
  user: User | null
  appUrl: string
  workspace: Workspace
  hosted: boolean
  plan: PlanState | null
  passwordMinLength: number
}

const Splash = () => (
  <div className="flex h-full items-center justify-center">
    <Spinner className="size-5" />
  </div>
)

export function App() {
  const { pathname, hash } = useLocation()
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api.get<Bootstrap>('/bootstrap'), staleTime: Infinity, refetchOnWindowFocus: false })
  useEffect(() => {
    const onSignedOut = () => void boot.refetch()
    window.addEventListener('ansa:signed-out', onSignedOut)
    return () => window.removeEventListener('ansa:signed-out', onSignedOut)
  }, [boot])

  if (boot.isPending) return <Splash />
  if (boot.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-fg-2">{brand()} could not reach its server.</p>
        <button className="text-sm font-medium text-accent-fg underline" onClick={() => void boot.refetch()}>
          Try again
        </button>
      </div>
    )
  }
  // Branding and status names must be in place before anything below renders.
  applyWorkspace(boot.data.workspace)
  // Keyed by the token: a second link opened in the same tab changes only the fragment, and must start a fresh form.
  if (pathname === '/link') return <LinkPage key={hash} token={hash.slice(1)} passwordMin={boot.data.passwordMinLength} />
  if (boot.data.setupRequired) return <Setup onDone={() => void boot.refetch()} />
  if (!boot.data.user) return pathname === '/forgot' ? <ForgotPassword /> : <Login onDone={() => void boot.refetch()} />
  return (
    <SessionContext.Provider
      value={{
        user: boot.data.user,
        appUrl: boot.data.appUrl,
        workspace: boot.data.workspace,
        hosted: boot.data.hosted,
        plan: boot.data.plan,
        passwordMin: boot.data.passwordMinLength,
        refresh: () => void boot.refetch(),
      }}
    >
      <Authed />
    </SessionContext.Provider>
  )
}

function Authed() {
  useLiveEvents()
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="m/:mailboxId/:folder" element={<InboxPage />} />
        <Route path="m/:mailboxId/:folder/:conversationId" element={<InboxPage />} />
        <Route path="search" element={<InboxPage search />} />
        <Route path="search/:conversationId" element={<InboxPage search />} />
        <Route path="c/:conversationId" element={<ConversationRedirect />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:customerId" element={<CustomersPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings/*" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

function Home() {
  const mailboxes = useMailboxes()
  const { user } = useSession()
  if (mailboxes.isPending) return <Splash />
  const list = mailboxes.data ?? []
  if (list.length === 0) return <Welcome />
  const first = list[0]
  return <Navigate to={`/m/${first.id}/${first.counts.unassigned === 0 && first.counts.mine > 0 && user ? 'mine' : 'unassigned'}`} replace />
}

/** /c/123 is the stable link used in emails and by the MCP server. Send it to the right folder. */
function ConversationRedirect() {
  const { conversationId } = useParams()
  const { user } = useSession()
  // Same key and same shape as the conversation view, so the two share one cache entry.
  const query = useQuery({ queryKey: ['conversation', Number(conversationId)], queryFn: () => api.get<{ conversation: Conversation }>(`/conversations/${conversationId}`), select: (r) => r.conversation })
  if (query.isPending) return <Splash />
  if (query.isError) return <Navigate to="/" replace />
  const c = query.data
  const folder =
    c.status === 'closed' ? 'closed' : c.status === 'spam' ? 'spam' : c.snoozedUntil ? 'snoozed' : c.status === 'pending' && workspace().fourStatuses ? 'pending' : !c.assignee ? 'unassigned' : c.assignee.id === user.id ? 'mine' : 'assigned'
  return <Navigate to={`/m/${c.mailboxId}/${folder}/${c.id}`} replace />
}
