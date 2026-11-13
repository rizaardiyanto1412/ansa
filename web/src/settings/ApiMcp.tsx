import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { brand } from '../lib/workspace'
import { ago, dateOnly } from '../lib/format'
import { useSession } from '../lib/hooks'
import type { ApiToken } from '../lib/types'
import { Banner, Button, Card, EmptyState, Field, IconButton, Input, PageHeader, Spinner, cx, useFeedback } from '../ui'

export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-sunken py-3 pr-12 pl-3.5 font-mono text-xs leading-relaxed text-fg" tabIndex={0} aria-label={label}>
        {code}
      </pre>
      <IconButton
        label={copied ? 'Copied' : `Copy ${label}`}
        size="sm"
        className="absolute top-1.5 right-1.5"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
      </IconButton>
    </div>
  )
}

const ACCESS_OPTIONS: { value: ApiToken['access']; label: string; description: string }[] = [
  { value: 'full', label: 'Full access', description: 'Acts as you, and can email customers.' },
  { value: 'internal', label: 'Internal only', description: "Reads conversations, adds notes, tags and assigns. Can't email customers or change settings." },
]

const CLIENTS = ['Claude Code', 'Claude Desktop', 'Cursor', 'Other'] as const

const TOOLS: [string, string][] = [
  ['list_conversations', 'List or search conversations'],
  ['get_conversation', 'Read a full thread'],
  ['reply_to_conversation', 'Email the customer'],
  ['add_note', 'Add an internal note'],
  ['update_conversation', 'Status, assignee, tags, snooze'],
  ['create_conversation', 'Start a conversation'],
  ['list_customers', 'Find customers'],
  ['get_customer', 'Read a customer profile'],
  ['update_customer', 'Edit a customer profile'],
  ['list_mailboxes', 'Mailboxes and their counts'],
  ['list_saved_replies', 'Reusable answers'],
  ['list_tags', 'Tags and usage'],
  ['list_team', 'Teammates'],
  ['get_report', 'Support metrics'],
]

export function ApiSettings() {
  const { appUrl } = useSession()
  const client = useQueryClient()
  const { toast, confirm } = useFeedback()
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<{ tokens: ApiToken[] }>('/tokens').then((r) => r.tokens) })
  const [name, setName] = useState('')
  const [access, setAccess] = useState<ApiToken['access']>('full')
  const [secret, setSecret] = useState<string | null>(null)
  const [tab, setTab] = useState<(typeof CLIENTS)[number]>('Claude Code')
  const create = useMutation({
    mutationFn: () => api.post<{ secret: string }>('/tokens', { name: name.trim() || 'MCP', access }),
    onSuccess: (data) => {
      setSecret(data.secret)
      setName('')
      void client.invalidateQueries({ queryKey: ['tokens'] })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const revoke = async (token: ApiToken) => {
    const ok = await confirm({ title: `Revoke “${token.name}”?`, body: 'Anything that uses this token stops working right away.', confirmLabel: 'Revoke token', danger: true })
    if (!ok) return
    await api.del(`/tokens/${token.id}`)
    void client.invalidateQueries({ queryKey: ['tokens'] })
    toast('Token revoked')
  }

  const token = secret ?? 'YOUR_TOKEN'
  const url = `${appUrl}/mcp`
  const snippets: Record<(typeof CLIENTS)[number], string> = {
    'Claude Code': `claude mcp add --transport http ansa ${url} \\\n  --header "Authorization: Bearer ${token}"`,
    'Claude Desktop': JSON.stringify({ mcpServers: { ansa: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`] } } }, null, 2),
    Cursor: JSON.stringify({ mcpServers: { ansa: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    Other: `URL:        ${url}\nTransport:  Streamable HTTP\nHeader:     Authorization: Bearer ${token}`,
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="API & MCP" description={`Let AI assistants and your own scripts work in ${brand()} as you.`} />

      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">Access tokens</h2>
        <p className="mt-0.5 text-[13px] text-fg-3">Choose what each token can do. Create one for each tool, and revoke it when you stop using the tool.</p>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
        >
          <fieldset className="w-full">
            <legend className="mb-2 text-[13px] font-medium">Access</legend>
            <div className="flex flex-wrap gap-3">
              {ACCESS_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cx(
                    'flex min-w-48 flex-1 cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors',
                    access === option.value ? 'border-accent bg-accent-soft/60' : 'border-line-strong hover:bg-sunken',
                  )}
                >
                  <input type="radio" name="token-access" value={option.value} checked={access === option.value} onChange={() => setAccess(option.value)} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-[13px] text-fg-3">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Token name" className="min-w-48 flex-1">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code on my laptop" />}
          </Field>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create token
          </Button>
        </form>
        {secret && (
          <div className="mt-4 flex flex-col gap-2">
            <Banner kind="ok">Copy this token now. It is not shown again.</Banner>
            <CodeBlock code={secret} label="token" />
          </div>
        )}
        <div className="mt-4">
          {tokens.isPending ? (
            <Spinner />
          ) : tokens.data?.length === 0 ? (
            <EmptyState icon={<KeyRound />} title="No tokens yet" body="Create a token to connect an assistant or call the API." />
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {tokens.data?.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      {t.access === 'internal' && <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-sunken px-1.5 text-xs font-medium whitespace-nowrap text-fg-2">Internal only</span>}
                    </div>
                    <p className="text-[13px] text-fg-3">
                      <span className="font-mono text-xs">{t.prefix}…</span> · created {dateOnly(t.createdAt)} · {t.lastUsedAt ? `last used ${ago(t.lastUsedAt).toLowerCase()}` : 'never used'}
                    </p>
                  </div>
                  <IconButton label={`Revoke ${t.name}`} size="sm" onClick={() => void revoke(t)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">Connect an AI assistant (MCP)</h2>
        <p className="mt-0.5 text-[13px] text-fg-3">
          {brand()} has a built-in Model Context Protocol server. Connected assistants can read conversations and add notes. Full access tokens can also send replies.
          {!secret && ' Create a token above and it is filled in below.'}
        </p>
        <div role="tablist" aria-label="Client" className="mt-4 flex gap-1 border-b border-line">
          {CLIENTS.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={tab === c}
              onClick={() => setTab(c)}
              className={cx('-mb-px h-8 border-b-2 px-2.5 text-[13px] font-medium transition-colors', tab === c ? 'border-accent text-accent-fg' : 'border-transparent text-fg-3 hover:text-fg')}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-[13px] text-fg-2">
            {tab === 'Claude Code' && 'Run this in your terminal:'}
            {tab === 'Claude Desktop' && 'Add this to claude_desktop_config.json, then restart Claude:'}
            {tab === 'Cursor' && 'Add this to ~/.cursor/mcp.json:'}
            {tab === 'Other' && 'Use these details in any client that supports remote MCP servers:'}
          </p>
          <CodeBlock code={snippets[tab]} label={`${tab} setup`} />
        </div>
        <h3 className="mt-5 mb-2 text-[13px] font-medium">What assistants can do</h3>
        <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {TOOLS.map(([tool, what]) => (
            <li key={tool} className="flex items-baseline gap-2 text-[13px]">
              <code className="shrink-0 font-mono text-xs text-fg-2">{tool}</code>
              <span className="truncate text-fg-3">{what}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">REST API</h2>
        <p className="mt-0.5 mb-3 text-[13px] text-fg-3">The same token works with the JSON API that powers this app. The full list of endpoints is in the README.</p>
        <CodeBlock code={`curl ${appUrl}/api/conversations?folder=open \\\n  -H "Authorization: Bearer ${token}"`} label="example request" />
      </Card>
    </div>
  )
}
