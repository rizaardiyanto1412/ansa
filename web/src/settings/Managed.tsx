import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, CircleCheck, Copy, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import { brand } from '../lib/workspace'
import type { Mailbox, ManagedMailbox } from '../lib/types'
import { Banner, Button, Card, Field, Input, cx, useFeedback } from '../ui'

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const { toast } = useFeedback()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast('Could not copy. Select the text and copy it by hand.', { kind: 'error' })
    }
  }
  return (
    <Button size="sm" onClick={() => void copy()} aria-label={`Copy ${label}`} icon={copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function Copyable({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 rounded-lg bg-sunken px-3 py-2 font-mono text-[13px] [overflow-wrap:anywhere] select-all">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  )
}

function Step({ number, title, done, children }: { number: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={cx('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', done ? 'bg-ok-soft text-ok' : 'bg-accent-soft text-accent-fg')} aria-hidden>
        {done ? <Check className="size-3.5" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="mt-2 flex flex-col gap-3 text-[13px] text-fg-2">{children}</div>
      </div>
    </li>
  )
}

export function ManagedMailboxStart({ onCreated, onAdvanced }: { onCreated: (mailbox: Mailbox) => void; onAdvanced?: () => void }) {
  const client = useQueryClient()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () => api.post<{ mailbox: Mailbox }>('/mailboxes', { kind: 'managed', email, name: name.trim() || 'Support' }),
    onSuccess: async ({ mailbox }) => {
      await client.invalidateQueries({ queryKey: ['mailboxes'] })
      onCreated(mailbox)
    },
    onError: (err: Error) => setError(err.message),
  })
  return (
    <Card className="p-5">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          create.mutate()
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Support address" hint="The address your customers write to. It stays yours.">
            {(id) => <Input id={id} type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="support@yourcompany.com" />}
          </Field>
          <Field label="Mailbox name" hint="Shown in the sidebar.">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Support" />}
          </Field>
        </div>
        {error && <Banner kind="danger">{error}</Banner>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {onAdvanced ? (
            <button type="button" className="text-[13px] text-fg-3 underline hover:text-fg" onClick={onAdvanced}>
              Advanced: connect with IMAP and SMTP instead
            </button>
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" loading={create.isPending}>
            Continue
          </Button>
        </div>
      </form>
    </Card>
  )
}

type Provider = 'gmail' | 'workspace' | 'microsoft' | 'other'
const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'gmail', label: 'Gmail' },
  { id: 'workspace', label: 'Google Workspace' },
  { id: 'microsoft', label: 'Microsoft 365' },
  { id: 'other', label: 'Other' },
]

function Guide({ provider, email }: { provider: Provider; email: string }) {
  const list = 'flex list-decimal flex-col gap-1.5 pl-5'
  if (provider === 'gmail') {
    return (
      <ol className={list}>
        <li>Sign in to Gmail as {email}. Open Settings, then “See all settings”, then “Forwarding and POP/IMAP”.</li>
        <li>Choose “Add a forwarding address” and paste the address above.</li>
        <li>Gmail sends a confirmation email to that address. It arrives here, and the code shows below.</li>
        <li>Back in Gmail, choose “Forward a copy of incoming mail to” the new address, and save.</li>
      </ol>
    )
  }
  if (provider === 'workspace') {
    return (
      <ol className={list}>
        <li>If {email} is a user’s mailbox, follow the Gmail steps while signed in as that user.</li>
        <li>If it is a group or an alias, open the Google Admin console, then Apps, Google Workspace, Gmail, Routing.</li>
        <li>Add a routing rule for {email} with “Also deliver to” set to the address above. No confirmation is needed.</li>
      </ol>
    )
  }
  if (provider === 'microsoft') {
    return (
      <ol className={list}>
        <li>Open the Microsoft 365 admin center, then Users, Active users, and pick the mailbox for {email}.</li>
        <li>On the Mail tab, choose “Manage email forwarding”.</li>
        <li>Turn on “Forward all email sent to this mailbox”, paste the address above, and keep a copy if you want one.</li>
        <li>If forwarding to outside addresses is blocked, allow it for this mailbox in the outbound spam policy.</li>
      </ol>
    )
  }
  return (
    <ol className={list}>
      <li>Open the mail settings for {email} at your email provider or web host.</li>
      <li>Find “Forwarding” (sometimes “Forwarders” or “Redirect”).</li>
      <li>Forward all incoming mail to the address above. Keep a copy in the original mailbox if the provider offers it.</li>
    </ol>
  )
}

export function ForwardingSetup({ mailbox, managed }: { mailbox: Mailbox; managed: ManagedMailbox }) {
  const [provider, setProvider] = useState<Provider>(/@gmail\.com$/i.test(mailbox.email) ? 'gmail' : 'workspace')
  const confirmation = managed.forwardingConfirmation
  if (managed.receiving) {
    return (
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">Receiving email</h2>
        <div className="mt-3 flex flex-col gap-3">
          <Banner kind="ok">
            Connected. Mail sent to <strong>{mailbox.email}</strong> arrives in {brand()}.
          </Banner>
          <p className="text-[13px] text-fg-3">Your provider forwards it to this address. Keep that forwarding rule in place.</p>
          <Copyable value={managed.inboundAddress} label="forwarding address" />
        </div>
      </Card>
    )
  }
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-semibold">Forward your email to {brand()}</h2>
      <p className="mt-0.5 text-[13px] text-fg-3">
        Customers keep writing to {mailbox.email}. Your email provider passes each message on to {brand()}.
      </p>
      <ol className="mt-5 flex flex-col gap-6">
        <Step number={1} title="Copy your forwarding address">
          <Copyable value={managed.inboundAddress} label="forwarding address" />
        </Step>
        <Step number={2} title={`Set up forwarding for ${mailbox.email}`}>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Email provider">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={provider === p.id}
                onClick={() => setProvider(p.id)}
                className={cx('h-8 rounded-lg border px-3 text-[13px] font-medium transition-colors', provider === p.id ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong hover:bg-sunken')}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Guide provider={provider} email={mailbox.email} />
          {confirmation ? (
            <Banner kind="ok">
              <p className="font-medium">Gmail’s confirmation email arrived {ago(confirmation.at).toLowerCase()}.</p>
              {confirmation.code && (
                <div className="mt-2 flex items-center gap-2">
                  <span>Confirmation code:</span>
                  <code className="rounded bg-surface px-2 py-0.5 font-mono text-sm font-semibold tracking-wider select-all">{confirmation.code}</code>
                  <CopyButton value={confirmation.code} label="confirmation code" />
                </div>
              )}
              {confirmation.link && (
                <a className="mt-2 inline-flex items-center gap-1 font-medium underline" href={confirmation.link} target="_blank" rel="noreferrer">
                  Or confirm with Google’s link <ExternalLink className="size-3.5" aria-hidden />
                </a>
              )}
            </Banner>
          ) : (
            (provider === 'gmail' || provider === 'workspace') && <p className="text-fg-3">Gmail’s confirmation code shows up here a few seconds after you add the address.</p>
          )}
        </Step>
        <Step number={3} title="Send a test email">
          <p>
            Send any email to <strong>{mailbox.email}</strong> from another account.
          </p>
          <p className="flex items-center gap-2 text-fg-3" role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Waiting for the first email…
          </p>
        </Step>
      </ol>
    </Card>
  )
}

const SENDING_LABEL: Record<ManagedMailbox['sendingStatus'], string> = { none: 'Not set up', pending: 'Waiting for DNS', verified: 'Verified', failed: 'Not verified' }

export function SendingDomain({ mailbox, managed }: { mailbox: Mailbox; managed: ManagedMailbox }) {
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const domain = mailbox.email.split('@')[1] ?? ''
  const call = useMutation({
    mutationFn: (action: 'add' | 'check') => api.post<{ mailbox: Mailbox }>(`/mailboxes/${mailbox.id}/sending-domain${action === 'check' ? '/check' : ''}`),
    onMutate: () => setError(null),
    onSuccess: () => client.invalidateQueries({ queryKey: ['mailboxes'] }),
    onError: (err: Error) => setError(err.message),
  })
  const status = managed.sendingStatus
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Send as {mailbox.email}</h2>
        <span
          className={cx(
            'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium',
            status === 'verified' ? 'bg-ok-soft text-ok' : status === 'failed' ? 'bg-danger-soft text-danger' : status === 'pending' ? 'bg-warn-soft text-warn' : 'bg-sunken text-fg-3',
          )}
        >
          {status === 'verified' && <CircleCheck className="size-3.5" aria-hidden />}
          {SENDING_LABEL[status]}
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-4 text-[13px] text-fg-2">
        {status === 'verified' ? (
          <p>
            Replies go out from <strong>{mailbox.email}</strong>, signed for {managed.sendingDomain}.
          </p>
        ) : (
          <p>
            Until <strong>{domain}</strong> is verified, replies go out as “{mailbox.fromName || mailbox.name} via {brand()}” from a {brand()} address, with a lower hourly limit. Customers who answer still reach {mailbox.email}.
          </p>
        )}
        {status === 'none' && (
          <div>
            <Button variant="primary" loading={call.isPending} onClick={() => call.mutate('add')}>
              Set up {domain}
            </Button>
          </div>
        )}
        {status !== 'none' && managed.sendingRecords.length > 0 && (
          <>
            {status !== 'verified' && <p>Add these records where you manage DNS for {managed.sendingDomain}. Changes can take up to an hour to show.</p>}
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-sunken text-xs text-fg-3">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Type</th>
                    <th scope="col" className="px-3 py-2 font-medium">Name</th>
                    <th scope="col" className="px-3 py-2 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {managed.sendingRecords.map((record) => (
                    <tr key={`${record.type}:${record.host}`} className="align-top">
                      <td className="px-3 py-2 font-medium">{record.type}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-2">
                          <code className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">{record.host}</code>
                          <CopyButton value={record.host} label={`${record.type} name`} />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-2">
                          <code className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">{record.value}</code>
                          <CopyButton value={record.value} label={`${record.type} value`} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {status === 'failed' && <Banner kind="danger">{brand()} could not verify {managed.sendingDomain}. Compare the records above with your DNS, then check again.</Banner>}
        {status !== 'none' && status !== 'verified' && (
          <div className="flex flex-wrap items-center gap-3">
            <Button loading={call.isPending} onClick={() => call.mutate('check')} icon={<RefreshCw className="size-3.5" aria-hidden />}>
              Check now
            </Button>
            <span className="text-fg-3">
              {managed.sendingCheckedAt ? `Last checked ${ago(managed.sendingCheckedAt).toLowerCase()}. ` : ''}
              {brand()} also checks by itself.
            </span>
          </div>
        )}
        {error && <Banner kind="danger">{error}</Banner>}
      </div>
    </Card>
  )
}
