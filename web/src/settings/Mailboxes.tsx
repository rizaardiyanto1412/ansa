import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, CircleAlert, CircleCheck, Mail, Plus, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { brand } from '../lib/workspace'
import { ago } from '../lib/format'
import { useMailboxes, useSession } from '../lib/hooks'
import type { Mailbox } from '../lib/types'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Switch, Textarea, cx, useFeedback } from '../ui'
import { RichField } from '../inbox/Editor'
import { ForwardingSetup, ManagedMailboxStart, SendingDomain } from './Managed'

type Security = 'starttls' | 'ssl' | 'none'
interface FormState {
  name: string
  email: string
  fromName: string
  color: string
  smtpHost: string
  smtpPort: number
  smtpSecurity: Security
  smtpUser: string
  smtpPassword: string
  imapEnabled: boolean
  imapHost: string
  imapPort: number
  imapSecurity: Security
  imapUser: string
  imapPassword: string
  imapFolder: string
  importExisting: boolean
  sameLogin: boolean
  signature: string
  autoReplyEnabled: boolean
  autoReplyBody: string
}

const PRESETS: { id: string; label: string; smtpHost: string; smtpPort: number; smtpSecurity: Security; imapHost: string; imapPort: number }[] = [
  { id: 'google', label: 'Google Workspace or Gmail', smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecurity: 'starttls', imapHost: 'imap.gmail.com', imapPort: 993 },
  { id: 'microsoft', label: 'Microsoft 365', smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecurity: 'starttls', imapHost: 'outlook.office365.com', imapPort: 993 },
  { id: 'fastmail', label: 'Fastmail', smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSecurity: 'ssl', imapHost: 'imap.fastmail.com', imapPort: 993 },
]
const COLORS = ['#5448e2', '#0ea5e9', '#0d9488', '#16a34a', '#d97706', '#dc2626', '#db2777', '#64748b']

const initial = (m?: Mailbox): FormState => ({
  name: m?.name ?? '',
  email: m?.email ?? '',
  fromName: m?.fromName ?? '',
  color: m?.color ?? COLORS[0],
  smtpHost: m?.smtpHost ?? '',
  smtpPort: m?.smtpPort ?? 587,
  smtpSecurity: m?.smtpSecurity ?? 'starttls',
  smtpUser: m?.smtpUser ?? '',
  smtpPassword: '',
  imapEnabled: m?.imapEnabled ?? true,
  imapHost: m?.imapHost ?? '',
  imapPort: m?.imapPort ?? 993,
  imapSecurity: m?.imapSecurity ?? 'ssl',
  imapUser: m?.imapUser ?? '',
  imapPassword: '',
  imapFolder: m?.imapFolder ?? 'INBOX',
  importExisting: m?.importExisting ?? false,
  sameLogin: m ? m.imapUser === m.smtpUser : true,
  signature: m?.signature ?? '',
  autoReplyEnabled: m?.autoReplyEnabled ?? false,
  autoReplyBody: m?.autoReplyBody ?? '',
})

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-fg-3">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </Card>
  )
}

function TestButton({ payload }: { payload: () => Record<string, unknown> }) {
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; message: string }>('/mailboxes/test', payload()) })
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button loading={test.isPending} onClick={() => test.mutate()}>
        Test connection
      </Button>
      {test.data && !test.isPending && (
        <p role="status" className={cx('flex min-w-0 flex-1 items-start gap-1.5 text-[13px]', test.data.ok ? 'text-ok' : 'text-danger')}>
          {test.data.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          {test.data.message}
        </p>
      )}
      {test.isError && <p className="text-[13px] text-danger">{(test.error as Error).message}</p>}
    </div>
  )
}

export function MailboxForm({ mailbox, onSaved, compact = false }: { mailbox?: Mailbox; onSaved: (mailbox: Mailbox) => void; compact?: boolean }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [form, setForm] = useState<FormState>(() => initial(mailbox))
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))
  const text = (key: keyof FormState) => (e: { target: { value: string } }) => set(key, e.target.value as never)

  // Follows the host field, so typing your own server clears the highlighted provider.
  const managed = mailbox?.kind === 'managed'
  const preset = PRESETS.find((p) => p.smtpHost === form.smtpHost.trim().toLowerCase())?.id ?? null
  const [pickedOther, setPickedOther] = useState(false)
  const other = !preset && (pickedOther || form.smtpHost.trim() !== '')
  /** "Other" clears a filled-in provider so you can type your own server. Your own entries are kept. */
  const applyOther = () => {
    setPickedOther(true)
    if (preset) setForm((f) => ({ ...f, smtpHost: '', imapHost: '', smtpUser: f.smtpUser || f.email }))
  }
  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!
    setPickedOther(false)
    setForm((f) => ({ ...f, smtpHost: p.smtpHost, smtpPort: p.smtpPort, smtpSecurity: p.smtpSecurity, imapHost: p.imapHost, imapPort: p.imapPort, imapSecurity: 'ssl', smtpUser: f.smtpUser || f.email, sameLogin: true }))
  }
  const payload = () => ({
    ...form,
    id: mailbox?.id,
    kind: mailbox?.kind ?? 'imap',
    imapUser: form.sameLogin ? form.smtpUser : form.imapUser,
    imapPassword: form.sameLogin ? form.smtpPassword : form.imapPassword,
    // With a shared login and no new password typed, the server reuses the saved SMTP password.
    copySmtpPassword: form.sameLogin,
  })

  const save = useMutation({
    mutationFn: () => (mailbox ? api.patch<{ mailbox: Mailbox }>(`/mailboxes/${mailbox.id}`, payload()) : api.post<{ mailbox: Mailbox }>('/mailboxes', payload())),
    onSuccess: async ({ mailbox: saved }) => {
      await client.invalidateQueries({ queryKey: ['mailboxes'] })
      toast(mailbox ? 'Mailbox saved' : 'Mailbox added')
      setForm((f) => ({ ...f, smtpPassword: '', imapPassword: '' }))
      onSaved(saved)
    },
    onError: (err: Error) => setError(err.message),
  })

  const google = preset === 'google'
  const passwordHint = (isSet?: boolean) => (isSet ? 'Saved. Leave blank to keep the current password.' : google ? 'Paste the 16-character app password.' : undefined)

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        save.mutate()
      }}
    >
      <Section title="Mailbox" description="The address customers write to, and the name they see on your replies.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mailbox name" hint="Shown in the sidebar, for example Support.">
            {(id) => <Input id={id} required value={form.name} onChange={text('name')} placeholder="Support" />}
          </Field>
          <Field label="Email address">{(id) => <Input id={id} type="email" required value={form.email} onChange={text('email')} placeholder="support@yourcompany.com" />}</Field>
          <Field label="Sender name" hint="Customers see this in their inbox. Defaults to the mailbox name.">
            {(id) => <Input id={id} value={form.fromName} onChange={text('fromName')} placeholder={form.name || 'Acme Support'} />}
          </Field>
          {!compact && (
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium">Color</legend>
              <div className="flex h-9 items-center gap-2">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Color ${color}`}
                    aria-pressed={form.color === color}
                    onClick={() => set('color', color)}
                    className={cx('size-6 rounded-full ring-offset-2 ring-offset-surface transition-shadow', form.color === color && 'ring-2 ring-fg')}
                    style={{ background: color }}
                  />
                ))}
              </div>
            </fieldset>
          )}
        </div>
      </Section>

      {!managed && (
        <>
      <Section title="Email provider" description="Pick your provider to fill in the server details, or choose Other to enter your own.">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              onClick={() => applyPreset(p.id)}
              className={cx('h-8 rounded-lg border px-3 text-[13px] font-medium transition-colors', preset === p.id ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong hover:bg-sunken')}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={other}
            onClick={applyOther}
            className={cx('h-8 rounded-lg border px-3 text-[13px] font-medium transition-colors', other ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong hover:bg-sunken')}
          >
            Other (custom SMTP)
          </button>
        </div>
        {other && (
          <Banner>
            Any mail server works, including the one from your web hosting. Enter the host, port and login from your provider&rsquo;s email settings. The host is often <strong>mail.yourdomain.com</strong>, with port 465 (SSL/TLS) or 587 (STARTTLS), and the full email address as the username.
          </Banner>
        )}
        {google && (
          <Banner>
            Google needs an <strong>app password</strong>, not your normal one. Turn on 2-Step Verification, then create one at{' '}
            <a className="font-medium underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
              myaccount.google.com/apppasswords
            </a>
            . Use the full email address as the username.
          </Banner>
        )}
      </Section>

      <Section title="Sending (SMTP)" description={`${brand()} sends replies through this server, so they come from your own address.`}>
        <div className="grid gap-4 sm:grid-cols-[1fr_110px_150px]">
          <Field label="SMTP host">{(id) => <Input id={id} value={form.smtpHost} onChange={text('smtpHost')} placeholder={other ? "mail.yourdomain.com" : "smtp.gmail.com"} />}</Field>
          <Field label="Port">{(id) => <Input id={id} type="number" value={form.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} />}</Field>
          <Field label="Security">
            {(id) => (
              <Select id={id} value={form.smtpSecurity} onChange={(e) => set('smtpSecurity', e.target.value as Security)}>
                <option value="starttls">STARTTLS</option>
                <option value="ssl">SSL/TLS</option>
                <option value="none">None</option>
              </Select>
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username">{(id) => <Input id={id} autoComplete="off" value={form.smtpUser} onChange={text('smtpUser')} placeholder={form.email || 'support@yourcompany.com'} />}</Field>
          <Field label="Password" hint={passwordHint(mailbox?.smtpPasswordSet)}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={form.smtpPassword} onChange={text('smtpPassword')} />}
          </Field>
        </div>
        <TestButton payload={() => ({ ...payload(), kind: 'smtp' })} />
      </Section>

      <Section title="Receiving (IMAP)" description={`${brand()} watches this inbox and turns new email into conversations. Mail stays in your account too.`}>
        <Switch checked={form.imapEnabled} onChange={(v) => set('imapEnabled', v)} label="Fetch incoming email" />
        {form.imapEnabled && (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_110px_150px]">
              <Field label="IMAP host">{(id) => <Input id={id} value={form.imapHost} onChange={text('imapHost')} placeholder={other ? "mail.yourdomain.com" : "imap.gmail.com"} />}</Field>
              <Field label="Port">{(id) => <Input id={id} type="number" value={form.imapPort} onChange={(e) => set('imapPort', Number(e.target.value))} />}</Field>
              <Field label="Security">
                {(id) => (
                  <Select id={id} value={form.imapSecurity} onChange={(e) => set('imapSecurity', e.target.value as Security)}>
                    <option value="ssl">SSL/TLS</option>
                    <option value="starttls">STARTTLS</option>
                    <option value="none">None</option>
                  </Select>
                )}
              </Field>
            </div>
            <Switch checked={form.sameLogin} onChange={(v) => set('sameLogin', v)} label="Use the same username and password as SMTP" />
            {!form.sameLogin && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Username">{(id) => <Input id={id} autoComplete="off" value={form.imapUser} onChange={text('imapUser')} />}</Field>
                <Field label="Password" hint={passwordHint(mailbox?.imapPasswordSet)}>
                  {(id) => <Input id={id} type="password" autoComplete="new-password" value={form.imapPassword} onChange={text('imapPassword')} />}
                </Field>
              </div>
            )}
            {!compact && (
              <Field label="Folder" hint="Usually INBOX.">
                {(id) => <Input id={id} value={form.imapFolder} onChange={text('imapFolder')} className="max-w-60" />}
              </Field>
            )}
            {!mailbox && <Switch checked={form.importExisting} onChange={(v) => set('importExisting', v)} label="Import the last 30 days of email" description="Off: only email that arrives from now on becomes a conversation." />}
            <TestButton payload={() => ({ ...payload(), kind: 'imap' })} />
          </>
        )}
      </Section>
        </>
      )}

      {!compact && (
        <>
          <Section title="Signature" description="Added under every reply from this mailbox, unless the teammate has a personal signature.">
            <RichField value={form.signature} onChange={(html) => set('signature', html)} placeholder="Best regards, the Acme team" minHeight={72} />
          </Section>
          <Section title="Auto reply" description="Send an automatic acknowledgement when a customer starts a new conversation.">
            <Switch checked={form.autoReplyEnabled} onChange={(v) => set('autoReplyEnabled', v)} label="Send an auto reply to new conversations" />
            {form.autoReplyEnabled && (
              <Field label="Message" hint="You can use {{customer.firstName}}, {{mailbox.name}} and {{conversation.id}}.">
                {(id) => <Textarea id={id} rows={5} value={form.autoReplyBody} onChange={text('autoReplyBody')} placeholder={'Hi {{customer.firstName}},\n\nThanks for writing in. We got your message and will reply within one business day.'} />}
              </Field>
            )}
          </Section>
        </>
      )}

      {error && <Banner kind="danger">{error}</Banner>}
      <div className="flex justify-end gap-2">
        <Button type="submit" variant="primary" size={compact ? 'lg' : 'md'} loading={save.isPending}>
          {mailbox ? 'Save changes' : 'Add mailbox'}
        </Button>
      </div>
    </form>
  )
}

function SyncStatus({ mailbox }: { mailbox: Mailbox }) {
  const client = useQueryClient()
  const sync = useMutation({ mutationFn: () => api.post(`/mailboxes/${mailbox.id}/sync`), onSettled: () => void client.invalidateQueries({ queryKey: ['mailboxes'] }) })
  if (!mailbox.imapEnabled) return <Banner kind="warn">This mailbox does not fetch incoming email. Turn on “Fetch incoming email” below to receive conversations.</Banner>
  if (mailbox.syncStatus === 'error') {
    return (
      <Banner kind="danger" action={<Button size="sm" loading={sync.isPending} onClick={() => sync.mutate()} icon={<RefreshCw className="size-3.5" aria-hidden />}>Retry</Button>}>
        <strong>Cannot fetch email.</strong> {mailbox.syncError} {brand()} keeps retrying.
      </Banner>
    )
  }
  if (mailbox.syncStatus === 'ok') {
    return (
      <Banner kind="ok" action={<Button size="sm" loading={sync.isPending} onClick={() => sync.mutate()} icon={<RefreshCw className="size-3.5" aria-hidden />}>Check now</Button>}>
        Receiving email. {mailbox.lastSyncAt ? `Last checked ${ago(mailbox.lastSyncAt).toLowerCase()}.` : ''}
      </Banner>
    )
  }
  return <Banner>Connecting to the mail server…</Banner>
}

const receivingLabel = (m: Mailbox) =>
  m.kind === 'managed' ? (m.receiving ? 'Receiving email' : 'Waiting for forwarding') : m.syncStatus === 'error' ? 'Connection problem' : !m.imapEnabled ? 'Not receiving' : m.syncStatus === 'ok' ? 'Receiving email' : 'Connecting…'

export function MailboxesSettings() {
  const { mailboxId } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { toast, confirm } = useFeedback()
  const { hosted } = useSession()
  const [search] = useSearchParams()
  const [advanced, setAdvanced] = useState(search.get('advanced') === '1')
  const mailboxes = useMailboxes()
  if (mailboxes.isPending) return <Spinner />
  const list = mailboxes.data ?? []

  if (mailboxId === 'new') {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Add a mailbox" description="Connect a shared address such as support@ or billing@." />
        {hosted && !advanced ? (
          <ManagedMailboxStart onCreated={(m) => navigate(`/settings/mailboxes/${m.id}`)} onAdvanced={() => setAdvanced(true)} />
        ) : (
          <MailboxForm onSaved={(m) => navigate(`/settings/mailboxes/${m.id}`)} />
        )}
      </div>
    )
  }

  const current = list.find((m) => String(m.id) === mailboxId)
  if (mailboxId && current) {
    const remove = async () => {
      const ok = await confirm({
        title: `Delete ${current.name}?`,
        body: `Every conversation in this mailbox is deleted with it. Email in your own mail account is not touched. ${current.kind === 'managed' ? 'Turn off forwarding at your email provider too: mail sent to the old forwarding address is refused. ' : ''}You cannot undo this.`,
        confirmLabel: 'Delete mailbox',
        danger: true,
      })
      if (!ok) return
      await api.del(`/mailboxes/${current.id}`)
      await client.invalidateQueries({ queryKey: ['mailboxes'] })
      toast('Mailbox deleted')
      navigate('/settings/mailboxes')
    }
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title={current.name}
          description={
            <>
              <Link to="/settings/mailboxes" className="hover:underline">
                Mailboxes
              </Link>{' '}
              / {current.email}
            </>
          }
        />
        {current.managed ? (
          <>
            <ForwardingSetup mailbox={current} managed={current.managed} />
            <SendingDomain mailbox={current} managed={current.managed} />
          </>
        ) : (
          <SyncStatus mailbox={current} />
        )}
        <MailboxForm key={current.id} mailbox={current} onSaved={() => {}} />
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <h2 className="text-[15px] font-semibold">Delete this mailbox</h2>
            <p className="text-[13px] text-fg-3">Removes the mailbox and all of its conversations from {brand()}.</p>
          </div>
          <Button variant="danger" onClick={() => void remove()}>
            Delete mailbox
          </Button>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Mailboxes"
        description="Each mailbox is a shared email address your team answers together."
        action={
          <Link to="/settings/mailboxes/new">
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />}>
              Add mailbox
            </Button>
          </Link>
        }
      />
      {list.length === 0 ? (
        <Card>
          <EmptyState icon={<Mail />} title="No mailboxes yet" body="Add your support address to start receiving and answering email." />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {list.map((m) => (
            <Link key={m.id} to={`/settings/mailboxes/${m.id}`} className="flex items-center gap-3 px-5 py-3.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-sunken">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: m.color }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{m.name}</span>
                <span className="block truncate text-[13px] text-fg-3">{m.email}</span>
              </span>
              <span className={cx('text-[13px]', receivingLabel(m) === 'Connection problem' ? 'text-danger' : receivingLabel(m) === 'Receiving email' ? 'text-ok' : 'text-fg-3')}>{receivingLabel(m)}</span>
              <ChevronRight className="size-4 text-fg-3" aria-hidden />
            </Link>
          ))}
        </Card>
      )}
    </div>
  )
}
