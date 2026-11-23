import { useEffect, useState, type ReactNode, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Building2, Copy, Lock, Mail, MapPin, Merge, Pencil, Phone, Plus, RefreshCw, SquarePen, X } from 'lucide-react'
import { api } from '../lib/api'
import { ago, dateOnly, plural, STATUS_LABEL } from '../lib/format'
import type { Conversation, Customer } from '../lib/types'
import { Avatar, Banner, Button, Field, IconButton, Input, Modal, useFeedback, cx } from '../ui'
import { useShell } from '../Shell'
import { STATUS_DOT } from '../lib/workspace'

const StatusDot = ({ status, className }: { status: string; className?: string }) => <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status] ?? 'bg-fg-3'} ${className ?? ''}`} aria-hidden />

interface AppPanel {
  id: number
  name: string
  html: string
  error: string | null
}

/** Content from the team's apps (Settings → Apps). The server has already cleaned the HTML. */
function AppPanels({ conversationId, customerId }: { conversationId: number; customerId: number }) {
  const apps = useQuery({
    queryKey: ['conversation-apps', conversationId, customerId],
    queryFn: () => api.get<{ apps: AppPanel[] }>(`/conversations/${conversationId}/apps`).then((r) => r.apps),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  if (!apps.data?.length) return null
  return (
    <>
      {apps.data.map((app) => (
        <section key={app.id} aria-label={app.name} className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex h-5 items-center justify-between">
            <h3 className="font-semibold">{app.name}</h3>
            <IconButton label={`Reload ${app.name}`} size="sm" className="size-6" onClick={() => void apps.refetch()} disabled={apps.isFetching}>
              <RefreshCw className={apps.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </IconButton>
          </div>
          {app.error ? (
            <p className="text-[13px] text-danger">{app.error}</p>
          ) : app.html ? (
            <div className="app-html prose-mail text-[13px]" dangerouslySetInnerHTML={{ __html: app.html }} />
          ) : (
            <p className="text-[13px] text-fg-3">Nothing to show.</p>
          )}
        </section>
      ))}
    </>
  )
}

export function CustomerPanel({ conversation }: { conversation: Conversation }) {
  const customer = conversation.customer
  const shell = useShell()
  const { toast } = useFeedback()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [notes, setNotes] = useState(customer.notes)
  useEffect(() => setNotes(customer.notes), [customer.id, customer.notes])

  const save = useMutation({
    mutationFn: (patch: Partial<Customer>) => api.patch<{ customer: Customer }>(`/customers/${customer.id}`, patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['conversation'] })
      void client.invalidateQueries({ queryKey: ['customers'] })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast('Copied'))
  }
  const details: [ReactNode, string][] = [
    [<Building2 key="c" />, customer.company],
    [<Briefcase key="t" />, customer.title],
    [<Phone key="p" />, customer.phone],
    [<MapPin key="l" />, customer.location],
  ]
  const filled = details.filter(([, value]) => value)

  const displayName = customer.name || customer.email
  const firstName = customer.name.split(' ')[0] || 'them'
  const iconButton = 'flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-sunken hover:text-fg'

  return (
    <div className="flex flex-col gap-2 p-2 text-[13px]">
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <Avatar name={displayName} color="#6fa3e8" size={44} />
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="text-[15px] leading-5 font-semibold [overflow-wrap:anywhere]">
              <Link to={`/customers/${customer.id}`} className="hover:underline">
                {displayName}
              </Link>
            </h2>
            <p className="mt-0.5 text-xs whitespace-nowrap text-fg-3">Customer since {dateOnly(customer.createdAt)}</p>
          </div>
          <button type="button" aria-label="Edit customer" onClick={() => setEditing(true)} className={`${iconButton} -mr-1.5`}>
            <Pencil className="size-3.5" aria-hidden />
          </button>
        </div>

        <dl className="mt-4 flex flex-col gap-0.5">
          {customer.emails.map((email) => (
            <div key={email} className="flex h-8 items-center gap-2.5">
              <dt className="flex w-4 shrink-0 justify-center text-fg-3">
                <Mail className="size-3.5" aria-label="Email" />
              </dt>
              <dd className="min-w-0 flex-1 truncate">
                <a href={`mailto:${email}`} className="text-accent-fg hover:underline">
                  {email}
                </a>
              </dd>
              <button type="button" aria-label={`Copy ${email}`} onClick={() => copy(email)} className={`${iconButton} -mr-1.5`}>
                <Copy className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
          {filled.map(([icon, value]) => (
            <div key={value} className="flex h-8 items-center gap-2.5">
              <dt className="flex w-4 shrink-0 justify-center text-fg-3 [&>svg]:size-3.5">{icon}</dt>
              <dd className="min-w-0 flex-1 truncate text-fg-2">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex h-5 items-center">
          <h3 className="font-semibold">
            <label htmlFor="customer-notes">Notes</label>
          </h3>
          <span className="ml-auto flex items-center gap-1 text-xs text-fg-3">
            <Lock className="size-3" aria-hidden />
            Team only
          </span>
        </div>
        <textarea
          id="customer-notes"
          aria-label="Notes about this customer"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== customer.notes && save.mutate({ notes })}
          placeholder="Plan, preferences, account details"
          className="mt-2.5 block w-full resize-y rounded-lg border border-transparent bg-sunken px-3 py-2 outline-none placeholder:text-fg-3 focus:border-accent focus:bg-surface"
        />
      </section>

      <AppPanels conversationId={conversation.id} customerId={customer.id} />

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex h-5 items-center">
          <h3 className="font-semibold">Conversations</h3>
          <span className="ml-1.5 text-fg-3 tabular-nums">{conversation.previousConversations.length + 1}</span>
        </div>
        <ul className="-mx-2 mt-2.5 flex flex-col gap-0.5">
          <li>
            <div className="flex items-start gap-2.5 rounded-lg bg-accent-soft px-2 py-2" aria-current="true">
              <StatusDot status={conversation.status} className="mt-1.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate font-medium">{conversation.subject}</span>
                  <span className="shrink-0 text-fg-3 tabular-nums">#{conversation.id}</span>
                </span>
                <span className="block text-xs text-fg-3">
                  {STATUS_LABEL[conversation.status]} · {ago(conversation.updatedAt)} · Viewing now
                </span>
              </span>
            </div>
          </li>
          {conversation.previousConversations.map((c) => (
            <li key={c.id}>
              <Link to={`/c/${c.id}`} className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-sunken">
                <StatusDot status={c.status} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate font-medium">{c.subject}</span>
                    <span className="shrink-0 text-fg-3 tabular-nums">#{c.id}</span>
                  </span>
                  <span className="block text-xs text-fg-3">
                    {STATUS_LABEL[c.status]} · {ago(c.updatedAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {conversation.previousConversations.length === 0 && <p className="mt-3 text-fg-3">This is their first conversation.</p>}
        <button
          type="button"
          onClick={() => shell.compose({ customerEmail: customer.email, customerName: customer.name, mailboxId: conversation.mailboxId })}
          className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-line font-medium text-fg-2 transition-colors hover:bg-sunken"
        >
          <SquarePen className="size-3.5" aria-hidden />
          <span className="truncate">New conversation with {firstName}</span>
        </button>
      </section>

      {editing && <CustomerForm customer={customer} onClose={() => setEditing(false)} />}
    </div>
  )
}

interface EmailRow {
  address: string
  /** Set when this address comes from another customer that will be merged in on save. */
  from?: { id: number; name: string }
}
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

export function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved?: (customer: Customer) => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [form, setForm] = useState({ name: customer?.name ?? '', company: customer?.company ?? '', title: customer?.title ?? '', phone: customer?.phone ?? '', location: customer?.location ?? '' })
  // The first address is the primary one: replies go there.
  const [emails, setEmails] = useState<EmailRow[]>(() => (customer?.emails ?? []).map((address) => ({ address })))
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  // Another customer already uses the address that was just typed.
  const [conflict, setConflict] = useState<{ address: string; owner: Customer } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })
  const merging = [...new Map(emails.filter((row) => row.from).map((row) => [row.from!.id, row.from!])).values()]

  const addOne = async (raw: string): Promise<boolean> => {
    const address = raw.trim().toLowerCase()
    if (!address) return true
    if (!EMAIL.test(address)) {
      setDraftError(`“${raw.trim()}” is not an email address.`)
      return false
    }
    if (emails.some((row) => row.address === address)) {
      setDraftError('That address is already in the list.')
      return false
    }
    const { customer: owner } = await api.get<{ customer: Customer | null }>(`/customers/lookup?email=${encodeURIComponent(address)}`)
    if (owner && owner.id !== customer?.id) {
      setConflict({ address, owner })
      return false
    }
    setEmails((rows) => [...rows, { address }])
    return true
  }
  /** Add what is in the field. A pasted list with commas, spaces or line breaks adds every address. */
  const addDraft = async () => {
    if (checking) return true
    setDraftError(null)
    setConflict(null)
    setChecking(true)
    try {
      const parts = draft.split(/[\s,;]+/).filter(Boolean)
      for (let i = 0; i < parts.length; i++) {
        if (!(await addOne(parts[i]))) {
          setDraft(parts.slice(i).join(', '))
          return false
        }
      }
      setDraft('')
      return true
    } catch (err) {
      setDraftError((err as Error).message)
      return false
    } finally {
      setChecking(false)
    }
  }
  const acceptMerge = () => {
    if (!conflict) return
    const { owner } = conflict
    const from = { id: owner.id, name: owner.name || owner.email }
    // Every address of the other customer comes along.
    setEmails((rows) => [...rows, ...owner.emails.filter((address) => !rows.some((row) => row.address === address.toLowerCase())).map((address) => ({ address: address.toLowerCase(), from }))])
    // Fill the blanks from the other profile, so nothing known about the person is lost.
    setForm((f) => ({ name: f.name || owner.name, company: f.company || owner.company, title: f.title || owner.title, phone: f.phone || owner.phone, location: f.location || owner.location }))
    setConflict(null)
    setDraft('')
  }
  const remove = (row: EmailRow) => setEmails((rows) => rows.filter((r) => (row.from ? r.from?.id !== row.from.id : r.address !== row.address)))
  const makePrimary = (row: EmailRow) => setEmails((rows) => [row, ...rows.filter((r) => r.address !== row.address)])

  const save = useMutation({
    mutationFn: async () => {
      // An address still in the field counts: nobody should lose it by pressing Save first.
      if (draft.trim() && !(await addDraftRef.current())) throw new Error('')
      const list = emailsRef.current
      if (list.length === 0) throw new Error('Add at least one email address.')
      const payload = { ...form, emails: list.map((row) => row.address), mergeFrom: [...new Set(list.flatMap((row) => (row.from ? [row.from.id] : [])))] }
      return customer ? api.patch<{ customer: Customer }>(`/customers/${customer.id}`, payload) : api.post<{ customer: Customer }>('/customers', { ...payload, email: payload.emails[0] })
    },
    onSuccess: (data) => {
      void client.invalidateQueries({ queryKey: ['conversation'] })
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['customers'] })
      void client.invalidateQueries({ queryKey: ['customer'] })
      toast(merging.length ? 'Customers merged' : customer ? 'Customer saved' : 'Customer added')
      onSaved?.(data.customer)
      onClose()
    },
    onError: (err: Error) => err.message && setError(err.message),
  })
  // The save handler needs the newest list and add function, not the ones from when it was created.
  const emailsRef = useRef(emails)
  emailsRef.current = emails
  const addDraftRef = useRef(addDraft)
  addDraftRef.current = addDraft

  const displayName = form.name.trim() || emails[0]?.address || 'New customer'
  const rowButton = 'flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40'

  return (
    <Modal
      open
      onClose={onClose}
      title={customer ? 'Edit customer' : 'Add a customer'}
      width={540}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {merging.length ? 'Save and merge' : customer ? 'Save changes' : 'Add customer'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        {error && <Banner kind="danger">{error}</Banner>}

        <div className="flex items-center gap-3.5">
          <Avatar name={displayName} color="#6fa3e8" size={48} />
          <Field label="Name" className="min-w-0 flex-1">
            {(id) => <Input id={id} autoFocus={!customer} value={form.name} onChange={set('name')} placeholder="Jane Doe" className="h-10 text-[15px] font-medium" />}
          </Field>
        </div>

        <section aria-labelledby="customer-emails">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 id="customer-emails" className="text-[13px] font-medium">
              Email addresses
            </h3>
            <p className="text-xs text-fg-3">Mail from any of these lands with this customer</p>
          </div>
          <div className="overflow-hidden rounded-xl border border-line">
            {emails.length > 0 && (
              <ul className="divide-y divide-line">
                {emails.map((row, index) => (
                  <li key={row.address} className={cx('group flex min-h-11 items-center gap-2.5 py-1.5 pr-2 pl-3.5', row.from && 'bg-accent-soft/60')}>
                    <Mail className="size-4 shrink-0 text-fg-3" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{row.address}</p>
                      {row.from && <p className="truncate text-xs text-accent-fg">From {row.from.name}. Merges when you save.</p>}
                    </div>
                    {index === 0 ? (
                      <span className="mr-1 shrink-0 rounded-md bg-sunken px-1.5 py-0.5 text-xs font-medium text-fg-2" title="Replies go to this address">
                        Primary
                      </span>
                    ) : (
                      <button type="button" onClick={() => makePrimary(row)} className="mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-fg-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100">
                        Make primary
                      </button>
                    )}
                    <button type="button" aria-label={`Remove ${row.address}`} title={emails.length === 1 ? 'A customer needs one address' : 'Remove'} disabled={emails.length === 1} onClick={() => remove(row)} className={rowButton}>
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className={cx('flex items-center gap-2 py-1.5 pr-2 pl-3.5', emails.length > 0 && 'border-t border-line')}>
              <Plus className="size-4 shrink-0 text-fg-3" aria-hidden />
              <input
                type="email"
                inputMode="email"
                autoComplete="off"
                aria-label="Add an email address"
                aria-invalid={!!draftError}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setDraftError(null)
                  setConflict(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    void addDraft()
                  }
                }}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text')
                  if (/[\s,;]/.test(text.trim())) {
                    e.preventDefault()
                    setDraft(text)
                    setTimeout(() => void addDraftRef.current(), 0)
                  }
                }}
                placeholder={emails.length ? 'Add another address' : 'name@example.com'}
                className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-3"
              />
              <Button size="sm" loading={checking} disabled={!draft.trim()} onClick={() => void addDraft()}>
                Add
              </Button>
            </div>
          </div>
          {draftError && (
            <p role="alert" className="mt-1.5 text-[13px] text-danger">
              {draftError}
            </p>
          )}
          {conflict && (
            <div role="alert" className="mt-2 rounded-xl border border-accent/25 bg-accent-soft/60 p-3.5">
              <div className="flex items-start gap-3">
                <Avatar name={conflict.owner.name || conflict.owner.email} color="#6fa3e8" size={32} />
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="font-medium [overflow-wrap:anywhere]">
                    {conflict.address} belongs to {conflict.owner.name || 'another customer'}
                  </p>
                  <p className="mt-0.5 text-fg-2">
                    {customer
                      ? `Merge them if this is the same person. ${plural(conflict.owner.conversationCount ?? 0, 'conversation')}${conflict.owner.emails.length > 1 ? ` and ${conflict.owner.emails.length} addresses` : ''} move to this customer, and the other profile is removed.`
                      : `That customer has ${plural(conflict.owner.conversationCount ?? 0, 'conversation')}. Open it to edit it.`}
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {customer ? (
                      <Button size="sm" variant="primary" icon={<Merge />} onClick={acceptMerge}>
                        Merge into this customer
                      </Button>
                    ) : (
                      <Link to={`/customers/${conflict.owner.id}`} onClick={onClose}>
                        <Button size="sm" variant="primary">
                          Open that customer
                        </Button>
                      </Link>
                    )}
                    <Button
                      size="sm"
                      onClick={() => {
                        setConflict(null)
                        setDraft('')
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <section aria-labelledby="customer-details">
          <h3 id="customer-details" className="mb-2 text-[13px] font-medium">
            Details
          </h3>
          <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <Field label="Company">{(id) => <Input id={id} value={form.company} onChange={set('company')} placeholder="Acme" />}</Field>
            <Field label="Job title">{(id) => <Input id={id} value={form.title} onChange={set('title')} placeholder="Operations lead" />}</Field>
            <Field label="Phone">{(id) => <Input id={id} type="tel" value={form.phone} onChange={set('phone')} placeholder="+1 555 0100" />}</Field>
            <Field label="Location">{(id) => <Input id={id} value={form.location} onChange={set('location')} placeholder="Berlin, Germany" />}</Field>
          </div>
        </section>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
