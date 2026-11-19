import { useNavigate } from 'react-router-dom'
import { useDocumentTitle, useSession } from '../lib/hooks'
import { EmptyState } from '../ui'
import { Inbox } from 'lucide-react'
import { MailboxForm } from '../settings/Mailboxes'
import { ManagedMailboxStart } from '../settings/Managed'
import { brand } from '../lib/workspace'

/** First run: no mailbox exists yet. */
export function Welcome() {
  useDocumentTitle('Connect your mailbox')
  const { user, hosted } = useSession()
  const navigate = useNavigate()
  if (user.role !== 'admin') {
    return <EmptyState icon={<Inbox />} title="No mailboxes yet" body="Ask an admin to connect your team's email address. Conversations show up here once they do." />
  }
  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Connect your support mailbox</h1>
        {hosted ? (
          <>
            <p className="mt-1 mb-6 text-sm text-fg-2">Enter the address your customers write to. Next, {brand()} shows you how to forward its mail here. No passwords needed.</p>
            <ManagedMailboxStart onCreated={(m) => navigate(`/settings/mailboxes/${m.id}`)} onAdvanced={() => navigate('/settings/mailboxes/new?advanced=1')} />
          </>
        ) : (
          <>
            <p className="mt-1 mb-6 text-sm text-fg-2">{brand()} reads new email from this address and sends your replies through it. You can change every setting later.</p>
            <MailboxForm compact onSaved={(m) => navigate(`/m/${m.id}/unassigned`)} />
          </>
        )}
      </div>
    </div>
  )
}
