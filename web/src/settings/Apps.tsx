import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, BookOpen, CircleAlert, CircleCheck, Plus, Puzzle, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { brand } from '../lib/workspace'
import { ago } from '../lib/format'
import { useMailboxes } from '../lib/hooks'
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Switch, Textarea, cx, useFeedback } from '../ui'
import { CodeBlock } from './ApiMcp'

export const APPS_GUIDE = 'https://github.com/rizaardiyanto1412/ansa/blob/main/docs/apps.md'

type SidebarMode = 'none' | 'static' | 'dynamic'
interface App {
  id: number
  name: string
  enabled: boolean
  sidebarMode: SidebarMode
  sidebarContent: string
  sidebarUrl: string
  webhookUrl: string
  events: string[]
  mailboxId: number | null
  secret: string
}
interface Delivery {
  id: number
  kind: 'webhook' | 'sidebar'
  event: string
  conversationId: number | null
  ok: boolean
  status: number | null
  detail: string
  durationMs: number
  createdAt: number
}
interface TestResult {
  sidebar?: { ok: boolean; message: string; html?: string }
  webhook?: { ok: boolean; message: string }
}

const EVENT_LABELS: Record<string, string> = {
  'conversation.created': 'A conversation starts',
  'conversation.customer_replied': 'The customer replies',
  'conversation.agent_replied': 'A teammate replies',
  'conversation.note_added': 'A note is added',
  'conversation.status_changed': 'The status changes',
  'conversation.assigned': 'The assignee changes',
  'conversation.tags_changed': 'Tags change',
}

const SIDEBAR_CHOICES: { id: SidebarMode; label: string }[] = [
  { id: 'none', label: 'Nothing' },
  { id: 'static', label: 'Text and links (no code)' },
  { id: 'dynamic', label: 'Content from your server' },
]

const STATIC_EXAMPLE = `[Open in admin](https://admin.example.com/users?email={{customer.email|url}})

Company: {{customer.company}}`

const PLACEHOLDERS = ['customer.name', 'customer.firstName', 'customer.email', 'customer.company', 'customer.phone', 'customer.location', 'customer.id', 'conversation.id', 'conversation.subject', 'conversation.status', 'conversation.url', 'mailbox.name']

const summary = (app: App) => {
  const parts: string[] = []
  if (app.sidebarMode === 'static') parts.push('Sidebar: text and links')
  if (app.sidebarMode === 'dynamic') parts.push('Sidebar: from your server')
  if (app.webhookUrl) parts.push(`Webhook: ${app.events.length} event${app.events.length === 1 ? '' : 's'}`)
  return parts.join(' · ') || 'Not set up yet'
}

export function AppsSettings() {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const query = useQuery({ queryKey: ['apps'], queryFn: () => api.get<{ apps: App[]; events: string[] }>('/apps') })
  const [open, setOpen] = useState<number | 'new' | null>(null)
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['apps'] })
    void client.invalidateQueries({ queryKey: ['conversation-apps'] })
  }
  const toggle = useMutation({
    mutationFn: (app: App) => api.patch(`/apps/${app.id}`, { enabled: !app.enabled }),
    onSuccess: refresh,
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })

  if (open !== null && query.data) {
    const app = open === 'new' ? null : (query.data.apps.find((a) => a.id === open) ?? null)
    return (
      <AppEditor
        key={open}
        app={app}
        events={query.data.events}
        onBack={() => setOpen(null)}
        onSaved={(saved) => {
          refresh()
          setOpen(saved ? saved.id : null)
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Apps"
        description={`Connect ${brand()} to your own tools. Show customer data beside a conversation, and tell your systems when something happens.`}
        action={
          <Button variant="primary" icon={<Plus />} onClick={() => setOpen('new')}>
            New app
          </Button>
        }
      />
      <Banner
        action={
          <a href={APPS_GUIDE} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap underline">
            <BookOpen className="size-3.5" aria-hidden />
            Read the guide
          </a>
        }
      >
        An app is a web address you own. You do not install code into {brand()}. The simplest app needs no code at all: a few links that open the customer in your other tools.
      </Banner>
      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <Banner kind="danger">{(query.error as Error).message}</Banner>
      ) : query.data.apps.length === 0 ? (
        <Card>
          <EmptyState icon={<Puzzle />} title="No apps yet" body="Create your first app. Start with “Text and links” to see how it looks in a conversation." action={<Button onClick={() => setOpen('new')}>New app</Button>} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.apps.map((app) => (
              <li key={app.id} className="flex items-center gap-3 px-4 py-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(app.id)}>
                  <span className="block truncate text-sm font-medium">{app.name}</span>
                  <span className="block truncate text-[13px] text-fg-3">{summary(app)}</span>
                </button>
                <Switch checked={app.enabled} onChange={() => toggle.mutate(app)} label={app.enabled ? "On" : "Off"} />
                <Button size="sm" onClick={() => setOpen(app.id)}>
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-fg-3">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </Card>
  )
}

function Result({ ok, label, message }: { ok: boolean; label: string; message: string }) {
  return (
    <p className={cx('flex items-start gap-2 text-[13px]', ok ? 'text-ok' : 'text-danger')}>
      {ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span>
        <span className="font-medium">{label}:</span> {message}
      </span>
    </p>
  )
}

function AppEditor({ app, events, onBack, onSaved }: { app: App | null; events: string[]; onBack: () => void; onSaved: (app: App | null) => void }) {
  const { toast, confirm } = useFeedback()
  const mailboxes = useMailboxes()
  const [form, setForm] = useState({
    name: app?.name ?? '',
    sidebarMode: app?.sidebarMode ?? ('static' as SidebarMode),
    sidebarContent: app?.sidebarContent ?? '',
    sidebarUrl: app?.sidebarUrl ?? '',
    webhookUrl: app?.webhookUrl ?? '',
    events: app?.events ?? ['conversation.created'],
    mailboxId: app?.mailboxId ?? null,
  })
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }))
  const dirty = !app || JSON.stringify({ ...form }) !== JSON.stringify({ name: app.name, sidebarMode: app.sidebarMode, sidebarContent: app.sidebarContent, sidebarUrl: app.sidebarUrl, webhookUrl: app.webhookUrl, events: app.events, mailboxId: app.mailboxId })

  const save = useMutation({
    mutationFn: () => (app ? api.patch<{ app: App }>(`/apps/${app.id}`, form) : api.post<{ app: App }>('/apps', form)),
    onSuccess: (data) => {
      setError(null)
      toast(app ? 'App saved' : 'App created')
      onSaved(data.app)
    },
    onError: (err: Error) => setError(err.message),
  })
  const test = useMutation({
    mutationFn: () => api.post<TestResult>(`/apps/${app!.id}/test`),
    onSuccess: (data) => {
      setResult(data)
      void deliveries.refetch()
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const rotate = useMutation({
    mutationFn: () => api.patch<{ app: App }>(`/apps/${app!.id}`, { rotateSecret: true }),
    onSuccess: (data) => {
      toast('New secret created')
      onSaved(data.app)
    },
  })
  const deliveries = useQuery({
    queryKey: ['app-deliveries', app?.id],
    queryFn: () => api.get<{ deliveries: Delivery[] }>(`/apps/${app!.id}/deliveries`).then((r) => r.deliveries),
    enabled: !!app,
  })
  const remove = async () => {
    if (!app) return
    const ok = await confirm({ title: `Delete “${app.name}”?`, body: 'Its sidebar content disappears and its webhooks stop. You cannot undo this.', confirmLabel: 'Delete app', danger: true })
    if (!ok) return
    await api.del(`/apps/${app.id}`)
    toast('App deleted')
    onSaved(null)
  }
  const usesServer = form.sidebarMode === 'dynamic' || form.webhookUrl.trim() !== ''

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div>
        <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-fg-2 hover:text-fg">
          <ArrowLeft className="size-4" aria-hidden />
          All apps
        </button>
        <PageHeader
          title={app ? app.name : 'New app'}
          description="Fill in what you need. An app can show sidebar content, receive events, or both."
          action={
            <a href={APPS_GUIDE} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent-fg underline">
              <BookOpen className="size-3.5" aria-hidden />
              Guide
            </a>
          }
        />
      </div>
      {error && <Banner kind="danger">{error}</Banner>}

      <Section title="Basics">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Shown as the heading in the sidebar.">
            {(id) => <Input id={id} autoFocus={!app} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Orders" />}
          </Field>
          <Field label="Mailbox" hint="Limit the app to one mailbox, or use it everywhere.">
            {(id) => (
              <Select id={id} value={form.mailboxId ?? ''} onChange={(e) => set('mailboxId', e.target.value ? Number(e.target.value) : null)}>
                <option value="">All mailboxes</option>
                {mailboxes.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Section>

      <Section title="Sidebar" description="What teammates see beside a conversation, under the customer profile.">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Sidebar content">
          {SIDEBAR_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={form.sidebarMode === choice.id}
              onClick={() => set('sidebarMode', choice.id)}
              className={cx('h-8 rounded-lg border px-3 text-[13px] font-medium transition-colors', form.sidebarMode === choice.id ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong hover:bg-sunken')}
            >
              {choice.label}
            </button>
          ))}
        </div>
        {form.sidebarMode === 'static' && (
          <>
            <Field label="Content" hint="Write plain text. Make a link with [label](https://…). Simple HTML works too. Placeholders are filled in for each conversation.">
              {(id) => <Textarea id={id} rows={6} className="font-mono text-[13px]" value={form.sidebarContent} onChange={(e) => set('sidebarContent', e.target.value)} placeholder={STATIC_EXAMPLE} />}
            </Field>
            <div>
              <p className="mb-1.5 text-xs font-medium text-fg-3">Placeholders. Click one to add it. Inside a link, add |url, like {'{{customer.email|url}}'}.</p>
              <div className="flex flex-wrap gap-1.5">
                {PLACEHOLDERS.map((p) => (
                  <button key={p} type="button" onClick={() => set('sidebarContent', `${form.sidebarContent}{{${p}}}`)} className="rounded-md bg-sunken px-1.5 py-0.5 font-mono text-xs text-fg-2 hover:bg-hover hover:text-fg">
                    {`{{${p}}}`}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {form.sidebarMode === 'dynamic' && (
          <Field label="Sidebar URL" hint={`When a conversation opens, ${brand()} sends the customer and conversation to this address. Answer with JSON: {"html": "<p>…</p>"}.`}>
            {(id) => <Input id={id} type="url" value={form.sidebarUrl} onChange={(e) => set('sidebarUrl', e.target.value)} placeholder="https://your-app.example.com/sidebar" />}
          </Field>
        )}
      </Section>

      <Section title="Events (webhook)" description={`${brand()} sends a message to your address when these things happen. Leave the address empty if you do not need this.`}>
        <Field label="Webhook URL">{(id) => <Input id={id} type="url" value={form.webhookUrl} onChange={(e) => set('webhookUrl', e.target.value)} placeholder="https://your-app.example.com/webhook" />}</Field>
        {form.webhookUrl.trim() !== '' && (
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Send when</legend>
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {events.map((event) => (
                <label key={event} className="flex items-center gap-2.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={form.events.includes(event)}
                    onChange={(e) => set('events', e.target.checked ? [...form.events, event] : form.events.filter((x) => x !== event))}
                  />
                  <span>
                    {EVENT_LABELS[event] ?? event}
                    <span className="ml-1.5 font-mono text-xs text-fg-3">{event}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </Section>

      <div className="flex items-center justify-between gap-3">
        {app ? (
          <Button variant="ghost" onClick={() => void remove()} className="text-danger">
            Delete app
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button onClick={onBack}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
            {app ? 'Save changes' : 'Create app'}
          </Button>
        </div>
      </div>

      {app && (
        <>
          <Section title="Test" description={`${brand()} calls your app with made-up data, so you see right away if it answers correctly. Save your changes first.`}>
            <div>
              <Button icon={<RefreshCw />} loading={test.isPending} disabled={dirty} onClick={() => test.mutate()}>
                Send a test
              </Button>
            </div>
            {result && (
              <div className="flex flex-col gap-2">
                {result.sidebar && <Result ok={result.sidebar.ok} label="Sidebar" message={result.sidebar.message} />}
                {result.webhook && <Result ok={result.webhook.ok} label="Webhook" message={result.webhook.message} />}
                {!result.sidebar && !result.webhook && <p className="text-[13px] text-fg-3">This app has nothing to test yet.</p>}
                {result.sidebar?.html && (
                  <div className="rounded-lg border border-line p-3.5">
                    <p className="mb-1.5 text-xs font-medium text-fg-3">{app.name}</p>
                    <div className="app-html prose-mail text-[13px]" dangerouslySetInnerHTML={{ __html: result.sidebar.html }} />
                  </div>
                )}
              </div>
            )}
          </Section>

          {usesServer && (
            <Section title="Signing secret" description={`${brand()} signs every request with this secret. Your server uses it to check that a request really comes from ${brand()}. The guide shows how.`}>
              <CodeBlock code={app.secret} label="signing secret" />
              <div>
                <Button size="sm" loading={rotate.isPending} onClick={() => rotate.mutate()}>
                  Create a new secret
                </Button>
              </div>
            </Section>
          )}

          {usesServer && (
            <Section title="Recent activity" description="The last 50 webhook deliveries, and sidebar requests that failed.">
              {deliveries.isPending ? (
                <Spinner />
              ) : deliveries.data?.length ? (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {deliveries.data.map((d) => (
                    <li key={d.id} className="flex items-start gap-2.5 px-3.5 py-2">
                      {d.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-label="Delivered" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px]">
                          <span className="font-mono text-xs">{d.event}</span>
                          {d.conversationId ? <span className="text-fg-3"> · conversation #{d.conversationId}</span> : null}
                        </p>
                        {!d.ok && <p className="text-[13px] break-words text-danger">{d.detail}</p>}
                      </div>
                      <span className="shrink-0 text-xs text-fg-3 tabular-nums">
                        {d.status ?? '—'} · {d.durationMs} ms · {ago(d.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-fg-3">Nothing yet. Send a test to see the first entry.</p>
              )}
            </Section>
          )}
        </>
      )}
    </form>
  )
}
