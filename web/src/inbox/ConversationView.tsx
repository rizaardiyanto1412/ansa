import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClock,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Ellipsis,
  Expand,
  FileText,
  FolderInput,
  Merge,
  PanelRight,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Tag as TagIcon,
  Trash2,
  UserRound,
  X,
  Pencil,
  Clock,
} from 'lucide-react'
import { api, qs } from '../lib/api'
import { fileSize, fullTime, messageTime, STATUS_LABEL } from '../lib/format'
import { useDebounced, useDocumentTitle, useHotkeys, useMailboxes, useSession, useTags, useUsers } from '../lib/hooks'
import type { Attachment, Conversation, ConversationSummary, Status, Thread, Viewer } from '../lib/types'
import { Avatar, Button, EmptyState, PresenceAvatars, Input, MenuDivider, MenuItem, MenuLabel, Modal, Popover, Spinner, StatusBadge, cx, useFeedback } from '../ui'
import { Composer, type ComposerHandle } from './Composer'
import { lineHtml } from './Editor'
import { STATUS_DOT, statusOptions, workspace } from '../lib/workspace'
import { LightboxProvider, isImageType, useLightbox, type LightboxImage } from './Lightbox'
import { whenLabel } from './SendLater'
import { CustomerPanel } from './CustomerPanel'

type Patch = Partial<{ status: Status; assigneeId: number | null; subject: string; addTags: string[]; removeTags: string[]; snoozedUntil: number | null; mailboxId: number }>

export function ConversationView({ id, onBack, onDone }: { id: number; onBack: () => void; onDone: () => void }) {
  const { user } = useSession()
  const client = useQueryClient()
  const navigate = useNavigate()
  const { toast, confirm } = useFeedback()
  const composer = useRef<ComposerHandle>(null)
  const [panel, setPanel] = useState(false)
  const [typing, setTyping] = useState(false)
  const [merging, setMerging] = useState(false)
  // The composer stays closed until someone asks to write. An unsent draft waits in the thread as a card.
  const [composing, setComposing] = useState(false)
  const [composeMode, setComposeMode] = useState<'reply' | 'note'>('reply')
  const openComposer = (mode: 'reply' | 'note') => {
    // Show it first, in the same tick: a hidden editor cannot take focus, and the next keys must land in it.
    flushSync(() => setComposing(true))
    composer.current?.focus(mode)
  }

  const query = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<{ conversation: Conversation; viewers: Viewer[] }>(`/conversations/${id}`),
  })
  const conversation = query.data?.conversation
  const livePresence = useQuery<Viewer[]>({ queryKey: ['presence', id], queryFn: () => query.data?.viewers ?? [], enabled: false })
  const viewers = (livePresence.data ?? query.data?.viewers ?? []).filter((v) => v.userId !== user.id)
  useDocumentTitle(conversation?.subject ?? '')

  // Tell teammates we are here, and whether we are writing a reply.
  useEffect(() => {
    const ping = () => void api.post(`/conversations/${id}/presence`, { state: typing ? 'replying' : 'viewing' }).catch(() => {})
    ping()
    const timer = setInterval(ping, 20_000)
    return () => clearInterval(timer)
  }, [id, typing])
  useEffect(
    () => () => {
      void api.del(`/conversations/${id}/presence`).catch(() => {})
    },
    [id],
  )

  const update = useMutation({
    mutationFn: (patch: Patch) => api.patch<{ conversation: Conversation }>(`/conversations/${id}`, patch),
    onSuccess: (data) => {
      client.setQueryData(['conversation', id], (old: any) => (old ? { ...old, conversation: data.conversation } : old))
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      void client.invalidateQueries({ queryKey: ['tags'] })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })

  const setStatus = (status: Status) => {
    if (!conversation || conversation.status === status) return
    const previous = conversation.status
    update.mutate(
      { status },
      {
        onSuccess: () => {
          toast(`Marked as ${STATUS_LABEL[status].toLowerCase()}`, { action: { label: 'Undo', run: () => update.mutate({ status: previous }) } })
          if (status === 'closed' || status === 'spam' || (status === 'pending' && workspace().fourStatuses)) onDone()
        },
      },
    )
  }

  const remove = async () => {
    if (!conversation) return
    const ok = await confirm({ title: 'Delete this conversation?', body: 'Every message, note and attachment in it is removed for the whole team. You cannot undo this.', confirmLabel: 'Delete conversation', danger: true })
    if (!ok) return
    try {
      await api.del(`/conversations/${id}`)
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      toast('Conversation deleted')
      onBack()
    } catch (err) {
      toast((err as Error).message, { kind: 'error' })
    }
  }

  useHotkeys(
    {
      r: (e) => {
        e.preventDefault()
        openComposer('reply')
      },
      n: (e) => {
        e.preventDefault()
        openComposer('note')
      },
      a: () => conversation && update.mutate({ assigneeId: conversation.assignee?.id === user.id ? null : user.id }),
      e: () => setStatus('closed'),
    },
    !!conversation,
  )

  // Every picture in the conversation, in order, so the lightbox can step through them.
  const images = useMemo<LightboxImage[]>(
    () => (conversation?.threads ?? []).flatMap((t) => t.attachments.filter((a) => isImageType(a.mime)).map((a) => ({ url: a.url, filename: a.filename, size: a.size }))),
    [conversation?.threads],
  )

  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    )
  }
  if (query.isError || !conversation) {
    return <EmptyState icon={<CircleAlert />} title="This conversation is gone" body="It may have been deleted or merged into another one." action={<Button onClick={onBack}>Back to the list</Button>} />
  }

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          conversation={conversation}
          viewers={viewers}
          busy={update.isPending}
          onBack={onBack}
          onPatch={(patch) => update.mutate(patch)}
          onStatus={setStatus}
          onDelete={() => void remove()}
          onMerge={() => setMerging(true)}
          onTogglePanel={() => setPanel((open) => !open)}
        />
        <LightboxProvider images={images}>
          <ThreadList conversation={conversation} composing={composing} editing={composing ? composeMode : null} onCompose={openComposer} />
        </LightboxProvider>
        <Composer
          key={conversation.id}
          ref={composer}
          open={composing}
          onOpenChange={setComposing}
          onMode={setComposeMode}
          conversation={conversation}
          agentName={user.name}
          othersReplying={viewers.filter((v) => v.state === 'replying')}
          onTyping={setTyping}
          onSent={(status) => {
            setComposing(false)
            // The conversation leaves this folder, so move on to the next one.
            if (status === 'closed' || (status === 'pending' && workspace().fourStatuses)) onDone()
          }}
        />
      </div>
      <aside className="hidden w-[316px] shrink-0 overflow-y-auto border-l border-line bg-canvas xl:block" aria-label="Customer">
        <CustomerPanel conversation={conversation} />
      </aside>
      {panel && (
        <div className="safe-pad animate-fade fixed inset-0 z-30 flex justify-end bg-black/40 xl:hidden" onClick={() => setPanel(false)}>
          <aside className="h-full w-80 max-w-[88vw] overflow-y-auto bg-canvas shadow-pop" onClick={(e) => e.stopPropagation()} aria-label="Customer">
            <CustomerPanel conversation={conversation} />
          </aside>
        </div>
      )}
      {merging && (
        <MergeDialog
          conversation={conversation}
          onClose={() => setMerging(false)}
          onMerged={(target) => {
            setMerging(false)
            void client.invalidateQueries({ queryKey: ['conversations'] })
            toast(`Merged into #${target}`)
            navigate(`/c/${target}`)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Header: subject, status, assignee, tags, snooze, more
// ---------------------------------------------------------------------------------------------

const pill = 'inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface pr-2 pl-2.5 text-[13px] font-medium text-fg transition-colors hover:bg-sunken aria-expanded:bg-sunken'
const STATUS_PILL: Record<string, string> = {
  active: 'border-ok/25 bg-ok-soft text-ok hover:bg-ok-soft',
  waiting: 'border-accent/25 bg-accent-soft text-accent-fg hover:bg-accent-soft',
  pending: 'border-warn/25 bg-warn-soft text-warn hover:bg-warn-soft',
  closed: 'bg-sunken',
  spam: 'border-danger/25 bg-danger-soft text-danger hover:bg-danger-soft',
}
const STATUS_HINT: Record<string, string> = { active: 'needs a reply', pending: 'waiting on them', closed: 'done' }
// With four statuses the names say it all, except for the first one.
const STATUS_HINT_FOUR: Record<string, string> = { active: 'new or in progress', waiting: '', pending: '', closed: '' }
/** "Tyler replying · Maya viewing", or counts when a group has more than one person. */
function presenceLabel(viewers: Viewer[]): string {
  const part = (state: Viewer['state']) => {
    const people = viewers.filter((v) => v.state === state)
    if (people.length === 0) return ''
    return `${people.length === 1 ? people[0].name.split(' ')[0] : people.length} ${state}`
  }
  return [part('replying'), part('viewing')].filter(Boolean).join(' · ')
}

const MAX_TAGS = 3

function Header({
  conversation: c,
  viewers,
  busy,
  onBack,
  onPatch,
  onStatus,
  onDelete,
  onMerge,
  onTogglePanel,
}: {
  conversation: Conversation
  viewers: Viewer[]
  busy: boolean
  onBack: () => void
  onPatch: (patch: Patch) => void
  onStatus: (status: Status) => void
  onDelete: () => void
  onMerge: () => void
  onTogglePanel: () => void
}) {
  const users = useUsers()
  const mailboxes = useMailboxes()
  const { user } = useSession()
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(c.subject)
  useEffect(() => setSubject(c.subject), [c.subject])
  const saveSubject = () => {
    setEditing(false)
    if (subject.trim() && subject.trim() !== c.subject) onPatch({ subject: subject.trim() })
    else setSubject(c.subject)
  }
  const otherMailboxes = (mailboxes.data ?? []).filter((m) => m.id !== c.mailboxId)

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line py-2 pr-3 pl-3 md:pr-4">
      {/* Title and tags */}
      <div className="flex min-w-[min(100%,260px)] flex-1 items-center gap-2">
        <button type="button" aria-label="Back to the list" onClick={onBack} className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-sunken">
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        {editing ? (
          <Input
            autoFocus
            aria-label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={saveSubject}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveSubject()
              if (e.key === 'Escape') {
                setSubject(c.subject)
                setEditing(false)
              }
            }}
            className="h-8 max-w-md text-base font-semibold"
          />
        ) : (
          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">
            <button type="button" onClick={() => setEditing(true)} title="Edit subject" className="max-w-full truncate rounded text-left align-bottom hover:bg-sunken">
              {c.subject}
            </button>
          </h1>
        )}
        <span className="shrink-0 text-[13px] text-fg-3 tabular-nums">#{c.id}</span>
        <div className="ml-2 flex shrink-0 items-center gap-1.5">
          {c.tags.slice(0, MAX_TAGS).map((tag) => (
            <span key={tag.id} className="hidden h-6 items-center gap-1 rounded-md bg-sunken pr-1 pl-2 text-xs font-medium text-fg-2 lg:flex">
              {tag.name}
              <button type="button" aria-label={`Remove tag ${tag.name}`} onClick={() => onPatch({ removeTags: [tag.name] })} className="flex size-4 items-center justify-center rounded text-fg-3 hover:text-fg">
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <TagMenu current={c.tags.map((t) => t.name)} hiddenCount={Math.max(0, c.tags.length - MAX_TAGS)} onAdd={(name) => onPatch({ addTags: [name] })} onRemove={(name) => onPatch({ removeTags: [name] })} />
        </div>
      </div>

      {/* Properties */}
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
        {viewers.length > 0 && (
          <div className="flex h-7 shrink-0 items-center gap-1.5 text-xs font-medium text-fg-2" role="status">
            <PresenceAvatars viewers={viewers} />
            <span className="hidden 2xl:inline">{presenceLabel(viewers)}</span>
          </div>
        )}

        <SnoozeMenu snoozedUntil={c.snoozedUntil} onSnooze={(until) => onPatch({ snoozedUntil: until })} />

        <Popover
          align="end"
          width={248}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} className={cx(pill, STATUS_PILL[c.status])} aria-label={`Status: ${STATUS_LABEL[c.status]}`} disabled={busy}>
              <StatusDot status={c.status} />
              {STATUS_LABEL[c.status]}
              <ChevronDown className="size-3.5 opacity-60" aria-hidden />
            </button>
          )}
        >
          {(close) =>
            statusOptions().map((status) => (
              <MenuItem
                key={status}
                icon={<StatusDot status={status} />}
                checked={c.status === status}
                onSelect={() => {
                  close()
                  onStatus(status)
                }}
              >
                {STATUS_LABEL[status]} <span className="ml-1 text-fg-3">{(workspace().fourStatuses ? STATUS_HINT_FOUR : STATUS_HINT)[status]}</span>
              </MenuItem>
            ))
          }
        </Popover>

        <Popover
          align="end"
          width={230}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} className={cx(pill, 'pl-1.5')} aria-label={`Assignee: ${c.assignee?.name ?? 'nobody'}`}>
              {c.assignee ? (
                <Avatar name={c.assignee.name} color={c.assignee.color} size={20} />
              ) : (
                <span className="flex size-5 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-3">
                  <UserRound className="size-3" aria-hidden />
                </span>
              )}
              <span className="max-w-28 truncate">{c.assignee ? c.assignee.name.split(' ')[0] : 'Unassigned'}</span>
              <ChevronDown className="size-3.5 opacity-60" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              {(users.data ?? [])
                .filter((u) => !u.disabled)
                .map((u) => (
                  <MenuItem
                    key={u.id}
                    icon={<Avatar name={u.name} color={u.color} size={20} />}
                    checked={c.assignee?.id === u.id}
                    onSelect={() => {
                      close()
                      onPatch({ assigneeId: u.id })
                    }}
                  >
                    {u.name} {u.id === user.id && <span className="ml-1 text-fg-3">you</span>}
                  </MenuItem>
                ))}
              <MenuDivider />
              <MenuItem
                icon={
                  <span className="flex size-5 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-3">
                    <UserRound className="size-3" aria-hidden />
                  </span>
                }
                checked={!c.assignee}
                onSelect={() => {
                  close()
                  onPatch({ assigneeId: null })
                }}
              >
                Unassigned
              </MenuItem>
            </>
          )}
        </Popover>

        <Popover
          align="end"
          width={220}
          trigger={({ ref, ...props }) => (
            <button ref={ref} type="button" {...props} aria-label="More actions" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-sunken aria-expanded:bg-sunken">
              <Ellipsis className="size-4" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Merge />}
                onSelect={() => {
                  close()
                  onMerge()
                }}
              >
                Merge into another
              </MenuItem>
              {otherMailboxes.length > 0 && (
                <>
                  <MenuDivider />
                  <MenuLabel>Move to mailbox</MenuLabel>
                  {otherMailboxes.map((m) => (
                    <MenuItem
                      key={m.id}
                      icon={<FolderInput />}
                      onSelect={() => {
                        close()
                        onPatch({ mailboxId: m.id })
                      }}
                    >
                      {m.name}
                    </MenuItem>
                  ))}
                </>
              )}
              <MenuDivider />
              {c.status === 'spam' ? (
                <MenuItem
                  icon={<ShieldCheck />}
                  onSelect={() => {
                    close()
                    onStatus('active')
                  }}
                >
                  Not spam
                </MenuItem>
              ) : (
                <MenuItem
                  icon={<ShieldAlert />}
                  onSelect={() => {
                    close()
                    onStatus('spam')
                  }}
                >
                  Mark as spam
                </MenuItem>
              )}
              <MenuItem
                icon={<Trash2 />}
                danger
                onSelect={() => {
                  close()
                  onDelete()
                }}
              >
                Delete conversation
              </MenuItem>
            </>
          )}
        </Popover>

        <button type="button" aria-label="Customer details" onClick={onTogglePanel} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-sunken xl:hidden">
          <PanelRight className="size-4" aria-hidden />
        </button>
      </div>
    </header>
  )
}

export const StatusDot = ({ status }: { status: string }) => <span className={cx('size-2 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />

function snoozePresets(): { label: string; at: number; hint: string }[] {
  const now = new Date()
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0).getTime()
  const fmt = (ts: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ts)
  const untilMonday = (8 - now.getDay()) % 7 || 7
  const presets = [
    { label: 'In 3 hours', at: Date.now() + 3 * 3_600_000 },
    { label: 'Tomorrow morning', at: at(1, 9) },
    { label: 'In 3 days', at: at(3, 9) },
    { label: 'Next Monday', at: at(untilMonday, 9) },
  ]
  return presets.map((p) => ({ ...p, hint: fmt(p.at) }))
}

function SnoozeMenu({ snoozedUntil, onSnooze }: { snoozedUntil: number | null; onSnooze: (until: number | null) => void }) {
  const [custom, setCustom] = useState('')
  return (
    <Popover
      align="end"
      width={256}
      trigger={({ ref, ...props }) =>
        snoozedUntil ? (
          <button ref={ref} type="button" {...props} className={cx(pill, 'border-transparent bg-accent-soft text-accent-fg hover:bg-accent-soft')}>
            <AlarmClock className="size-4" aria-hidden />
            <span className="hidden sm:inline">Until {messageTime(snoozedUntil)}</span>
          </button>
        ) : (
          <button ref={ref} type="button" {...props} aria-label="Snooze" title="Snooze" className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line text-fg-2 transition-colors hover:bg-sunken aria-expanded:bg-sunken">
            <AlarmClock className="size-4" aria-hidden />
          </button>
        )
      }
    >
      {(close) => (
        <>
          <MenuLabel>Hide until</MenuLabel>
          {snoozePresets().map((p) => (
            <MenuItem
              key={p.label}
              hint={p.hint}
              onSelect={() => {
                close()
                onSnooze(p.at)
              }}
            >
              {p.label}
            </MenuItem>
          ))}
          <MenuDivider />
          <form
            className="flex gap-1.5 p-1"
            onSubmit={(e) => {
              e.preventDefault()
              const ts = new Date(custom).getTime()
              if (ts > Date.now()) {
                close()
                onSnooze(ts)
              }
            }}
          >
            <Input type="datetime-local" aria-label="Custom date and time" className="h-8 px-2 text-[13px]" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <Button type="submit" variant="primary" disabled={!custom || new Date(custom).getTime() <= Date.now()}>
              Set
            </Button>
          </form>
          {snoozedUntil && (
            <>
              <MenuDivider />
              <MenuItem
                icon={<AlarmClock />}
                onSelect={() => {
                  close()
                  onSnooze(null)
                }}
              >
                Wake up now
              </MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  )
}

function TagMenu({ current, hiddenCount, onAdd, onRemove }: { current: string[]; hiddenCount: number; onAdd: (name: string) => void; onRemove: (name: string) => void }) {
  const tags = useTags()
  const [filter, setFilter] = useState('')
  const clean = filter.trim().toLowerCase().replace(/\s+/g, '-')
  const options = (tags.data ?? []).filter((t) => t.name.includes(clean))
  const canCreate = clean && !(tags.data ?? []).some((t) => t.name === clean)
  return (
    <Popover
      width={230}
      onOpenChange={(open) => open && setFilter('')}
      trigger={({ ref, ...props }) => (
        <button ref={ref} type="button" {...props} aria-label="Add or remove tags" className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-dashed border-line-strong px-2 text-xs font-medium text-fg-3 transition-colors hover:border-fg-3 hover:text-fg aria-expanded:border-fg-3 aria-expanded:text-fg">
          <TagIcon className="size-3" aria-hidden />
          <span className={cx(current.length > 0 && 'lg:hidden')}>{current.length > 0 ? current.length : 'Add tag'}</span>
          {current.length > 0 && <span className="hidden lg:inline">{hiddenCount > 0 ? `+${hiddenCount}` : 'Add tag'}</span>}
        </button>
      )}
    >
      {() => (
        <>
          <div className="p-1">
            <Input
              autoFocus
              className="h-8"
              aria-label="Find or create a tag"
              placeholder="Find or create a tag"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !clean) return
                e.preventDefault()
                if (current.includes(clean)) onRemove(clean)
                else onAdd(clean)
                setFilter('')
              }}
            />
          </div>
          {options.map((t) => (
            <MenuItem
              key={t.id}
              icon={<span className="!size-2 rounded-full" style={{ background: t.color }} />}
              checked={current.includes(t.name)}
              onSelect={() => (current.includes(t.name) ? onRemove(t.name) : onAdd(t.name))}
            >
              {t.name}
            </MenuItem>
          ))}
          {canCreate && (
            <MenuItem
              icon={<Plus />}
              onSelect={() => {
                onAdd(clean)
                setFilter('')
              }}
            >
              Create “{clean}”
            </MenuItem>
          )}
          {options.length === 0 && !canCreate && <p className="px-3 py-3 text-center text-[13px] text-fg-3">Type a name to create your first tag.</p>}
        </>
      )}
    </Popover>
  )
}

// ---------------------------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------------------------

const CUSTOMER_COLOR = '#6fa3e8'
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayKey = (ts: number) => new Date(ts).toDateString()
function dayLabel(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000)
  const short = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) }).format(date)
  return days === 0 ? `Today, ${short}` : days === 1 ? `Yesterday, ${short}` : short
}

function ThreadList({ conversation, composing, editing, onCompose }: { conversation: Conversation; composing: boolean; editing: 'reply' | 'note' | null; onCompose: (mode: 'reply' | 'note') => void }) {
  // A draft that is open in the composer is not shown a second time.
  const drafts = conversation.drafts.filter((d) => d.kind !== editing).sort((a, b) => Number(a.kind === 'note') - Number(b.kind === 'note'))
  const scroller = useRef<HTMLDivElement>(null)
  const lastId = conversation.threads[conversation.threads.length - 1]?.id
  // Every message starts open. Click a name to fold one away; the choice resets when another conversation opens.
  const [folded, setFolded] = useState<Set<number>>(() => new Set())
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversation.id, lastId, composing, drafts.length])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        {/* The extra bottom space keeps the last message clear of the floating buttons. */}
        <ol className={cx('mx-auto flex max-w-[860px] flex-col gap-4 pt-5', composing ? 'pb-4' : 'pb-28')}>
          {conversation.threads.map((thread, index) => {
            const newDay = index === 0 || dayKey(thread.createdAt) !== dayKey(conversation.threads[index - 1].createdAt)
            return (
              <Fragment key={thread.id}>
                {newDay && (
                  <li className="flex items-center gap-3 text-xs text-fg-3 md:px-14">
                    <span className="h-px flex-1 bg-line" aria-hidden />
                    <time dateTime={new Date(thread.createdAt).toISOString().slice(0, 10)}>{dayLabel(thread.createdAt)}</time>
                    <span className="h-px flex-1 bg-line" aria-hidden />
                  </li>
                )}
                {thread.type === 'event' ? (
                  <EventLine thread={thread} />
                ) : (
                  <Message
                    thread={thread}
                    folded={folded.has(thread.id)}
                    onToggle={() =>
                      setFolded((set) => {
                        const next = new Set(set)
                        if (next.has(thread.id)) next.delete(thread.id)
                        else next.add(thread.id)
                        return next
                      })
                    }
                  />
                )}
              </Fragment>
            )
          })}
          {drafts.map((draft) => (
            <DraftCard key={draft.kind} conversationId={conversation.id} draft={draft} onEdit={() => onCompose(draft.kind)} />
          ))}
        </ol>
      </div>
      {!composing && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center gap-2.5">
          <button type="button" onClick={() => onCompose('reply')} className="pointer-events-auto flex h-11 min-w-[124px] items-center justify-center gap-2.5 rounded-[10px] bg-accent pr-3 pl-5 text-sm font-semibold text-white shadow-[0_6px_16px_-4px_rgba(34,31,92,0.45)] transition-colors hover:bg-accent-hover">
            Reply
            <kbd className="flex size-[22px] items-center justify-center rounded-md bg-white/20 font-sans text-xs font-semibold">R</kbd>
          </button>
          <button type="button" onClick={() => onCompose('note')} className="pointer-events-auto flex h-11 min-w-[124px] items-center justify-center gap-2.5 rounded-[10px] border border-note-line bg-note pr-3 pl-5 text-sm font-semibold text-note-fg shadow-[0_6px_16px_-6px_rgba(24,24,29,0.3)] transition-[filter] hover:brightness-[0.98]">
            Note
            <kbd className="flex size-[22px] items-center justify-center rounded-md bg-note-line/70 font-sans text-xs font-semibold">N</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

function eventText(thread: Thread): ReactNode {
  const e = thread.event ?? {}
  const who = thread.author.name
  switch (e.kind) {
    case 'status':
      return `${who} marked this ${e.to}`
    case 'assigned':
      return e.to ? `${who} assigned this to ${e.toName}` : `${who} removed the assignee`
    case 'snoozed':
      return `${who} snoozed this until ${messageTime(e.until)}`
    case 'unsnoozed':
      return e.auto ? 'Snooze ended' : `${who} ended the snooze`
    case 'moved':
      return `${who} moved this to ${e.toName}`
    case 'merged':
      return `${who} merged in #${e.fromId}${e.fromSubject ? ` “${e.fromSubject}”` : ''}`
    case 'customer':
      return `${who} changed the customer to ${e.toName}`
    default:
      return `${who} updated this conversation`
  }
}

function EventLine({ thread }: { thread: Thread }) {
  return (
    <li className="py-0.5 text-center text-xs text-fg-3">
      {eventText(thread)} · <time title={fullTime(thread.createdAt)}>{timeOnly.format(thread.createdAt)}</time>
    </li>
  )
}

const KEEP_EMPTY = new Set(['IMG', 'HR', 'TABLE', 'VIDEO', 'AUDIO', 'IFRAME'])
const isBlank = (node: Node): boolean => {
  if (node.nodeType === Node.TEXT_NODE) return !(node.textContent || '').replace(/[\s ​‌]/g, '')
  if (node.nodeType !== Node.ELEMENT_NODE) return true
  const el = node as Element
  if (KEEP_EMPTY.has(el.tagName) || el.querySelector('img, hr, table')) return false
  return !(el.textContent || '').replace(/[\s ​‌]/g, '')
}
/**
 * Emails often end, and sometimes start, with empty lines. Drop them so every card has the same padding.
 * The HTML was cleaned by the server; it is parsed here in an inert template and nothing in it runs.
 */
function trimBlankEdges(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const trim = (parent: Node, edge: 'firstChild' | 'lastChild') => {
    for (let node = parent[edge]; node; node = parent[edge]) {
      if (isBlank(node)) parent.removeChild(node)
      else {
        if (node.nodeType === Node.ELEMENT_NODE && !KEEP_EMPTY.has((node as Element).tagName)) trim(node, edge)
        break
      }
    }
  }
  trim(template.content, 'lastChild')
  trim(template.content, 'firstChild')
  return template.innerHTML
}

/** Text you wrote and did not send. It waits here, and only you see it, until you edit or discard it. */
function DraftCard({ conversationId, draft, onEdit }: { conversationId: number; draft: Conversation['drafts'][number]; onEdit: () => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const isNote = draft.kind === 'note'
  const discard = useMutation({
    mutationFn: () => api.put(`/conversations/${conversationId}/draft`, { kind: draft.kind, bodyHtml: '' }),
    onSuccess: () => {
      client.setQueryData(['conversation', conversationId], (old: any) => (old ? { ...old, conversation: { ...old.conversation, drafts: old.conversation.drafts.filter((d: any) => d.kind !== draft.kind) } } : old))
      toast('Draft discarded')
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  return (
    <li className="md:px-14">
      <article aria-label={isNote ? 'Your note draft' : 'Your reply draft'} className={cx('rounded-xl border border-dashed px-5 pt-4 pb-5 md:px-12 lg:px-20', isNote ? 'border-note-fg/40 bg-note' : 'border-line-strong bg-surface')}>
        <header className="flex flex-wrap items-center gap-2">
          <span className={cx('rounded-md px-1.5 py-0.5 text-xs font-semibold', isNote ? 'bg-note-line text-note-fg' : 'bg-sunken text-fg-2')}>{isNote ? 'Note draft' : 'Draft'}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
            Only you see this · saved <time dateTime={new Date(draft.updatedAt).toISOString()}>{messageTime(draft.updatedAt)}</time>
          </span>
          <Button size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" loading={discard.isPending} onClick={() => discard.mutate()}>
            Discard
          </Button>
        </header>
        <div className={cx('prose-mail mt-3 border-t pt-4', isNote ? 'border-note-line' : 'border-line')} dangerouslySetInnerHTML={{ __html: lineHtml(draft.bodyHtml) }} />
      </article>
    </li>
  )
}

function Message({ thread, folded, onToggle }: { thread: Thread; folded: boolean; onToggle: () => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [showQuoted, setShowQuoted] = useState(false)
  const quoted = useQuery({ queryKey: ['thread-full', thread.id], queryFn: () => api.get<{ html: string }>(`/threads/${thread.id}/full`).then((r) => r.html), enabled: showQuoted, staleTime: Infinity })
  const retry = useMutation({
    mutationFn: () => api.post(`/threads/${thread.id}/retry`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['conversation'] }),
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const scheduled = thread.state === 'scheduled'
  const act = useMutation({
    mutationFn: (what: 'send' | 'cancel') => (what === 'send' ? api.post(`/threads/${thread.id}/send-now`) : api.del(`/threads/${thread.id}/scheduled`)),
    onSuccess: (_data, what) => {
      void client.invalidateQueries({ queryKey: ['conversation'] })
      void client.invalidateQueries({ queryKey: ['conversations'] })
      toast(what === 'send' ? 'Reply sent' : 'Taken back. The text is in your draft.')
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const lightbox = useLightbox()
  const isNote = thread.type === 'note'
  const isCustomer = thread.type === 'customer'
  const name = thread.author.name
  const color = thread.author.kind === 'user' ? thread.author.color : isCustomer ? CUSTOMER_COLOR : undefined
  const files = thread.attachments.filter((a) => !a.inline)
  const text = useMemo(() => (folded ? stripTags(thread.bodyHtml) : ''), [folded, thread.bodyHtml])
  const html = useMemo(() => trimBlankEdges(showQuoted && quoted.data ? quoted.data : thread.bodyHtml), [showQuoted, quoted.data, thread.bodyHtml])

  // The line under the name says where the message came from or went, and how.
  const meta: ReactNode[] = []
  const sender = thread.from || (thread.author.kind === 'customer' ? thread.author.email : '')
  if (isCustomer && sender) meta.push(<><span className="font-medium text-fg-2">From</span> {sender}</>)
  if (thread.type === 'reply' && thread.to.length > 0) meta.push(<><span className="font-medium text-fg-2">To</span> {thread.to.join(', ')}</>)
  if (!isNote && thread.cc.length > 0) meta.push(<><span className="font-medium text-fg-2">Cc</span> {thread.cc.join(', ')}</>)
  if (isNote) meta.push(<>Only your team sees this</>)
  const channel = thread.type === 'reply' ? (thread.via === 'auto' ? 'Auto reply' : thread.via === 'email' ? 'Replied by email' : thread.via === 'mcp' || thread.via === 'api' ? 'Sent through the API' : '') : ''
  if (channel) meta.push(<>{channel}</>)
  // What the message did to the conversation at that moment: a customer message makes it active,
  // a reply sets the status the teammate chose when sending. An auto reply changes nothing.
  const sentStatus = isCustomer ? 'active' : thread.type === 'reply' && thread.via !== 'auto' ? (thread.event?.status as string | undefined) : undefined
  const how = isNote ? 'Note' : scheduled ? 'Not sent yet' : sentStatus ? (STATUS_LABEL[sentStatus] ?? '') : ''

  return (
    <li className="relative md:px-14">
      {/* The avatar sits on the card's edge, half in and half out: left for the customer, right for the team.
          The ring is the page colour, so the card's border looks cut out around it. */}
      <Avatar name={name} color={color} size={40} className={cx('absolute z-10 ring-4 ring-surface max-md:hidden', folded ? 'top-3' : 'top-4', isCustomer ? 'left-9' : 'right-9')} />
      <article
        aria-label={`${isNote ? 'Note' : 'Message'} from ${name}`}
        className={cx(
          // Wide side margins inside the card keep lines short and give the text room.
          'relative rounded-xl border px-5 md:px-12 lg:px-20',
          folded ? 'py-4' : 'pt-5 pb-6',
          isNote ? 'border-note-line bg-note' : 'border-line bg-surface',
          scheduled && 'border-dashed border-line-strong',
          thread.state === 'failed' && 'ring-1 ring-danger/50',
        )}
      >
        {/* A bar down the left edge marks what the team wrote. */}
        {!isCustomer && <span className={cx('absolute top-2.5 bottom-2.5 left-2 w-[3px] rounded-full', isNote ? 'bg-note-fg/30' : 'bg-line-strong')} aria-hidden />}
        <header>
          <div className="flex items-center gap-2.5">
            <Avatar name={name} color={color} size={24} className="md:hidden" />
            <button type="button" onClick={onToggle} aria-expanded={!folded} className="flex min-w-0 flex-1 items-baseline rounded text-left">
              <span className="truncate text-sm font-semibold">{name}</span>
            </button>
            {thread.state === 'sending' && <span className="shrink-0 text-xs text-fg-3">Sending…</span>}
            {scheduled && <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-fg">{thread.sendAt ? 'Scheduled' : 'On hold'}</span>}
            <time className={cx('shrink-0 text-xs tabular-nums', isNote ? 'text-note-fg' : 'text-fg-3')} title={fullTime(thread.createdAt)}>
              {timeOnly.format(thread.createdAt)}
            </time>
          </div>
          {folded ? (
            <button type="button" onClick={onToggle} tabIndex={-1} className="mt-1 block w-full truncate text-left text-[13px] text-fg-3">
              {text || 'No message text'}
            </button>
          ) : (
            (meta.length > 0 || how) && (
              <div className={cx('mt-1 flex items-baseline gap-3 text-xs', isNote ? 'text-note-fg' : 'text-fg-3')}>
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {meta.map((part, index) => (
                    <Fragment key={index}>
                      {index > 0 && <span className="mx-1.5" aria-hidden>·</span>}
                      {part}
                    </Fragment>
                  ))}
                </p>
                {how && (
                  <span className="shrink-0" title={sentStatus ? `This message set the conversation to ${how.toLowerCase()}` : undefined}>
                    {how}
                  </span>
                )}
              </div>
            )
          )}
        </header>
        {!folded && (
          <div className={cx('mt-4 border-t pt-5', isNote ? 'border-note-line' : 'border-line')}>
            {scheduled && (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent-fg">
                <Clock className="size-4 shrink-0" aria-hidden />
                <p className="min-w-40 flex-1">
                  {thread.sendAt ? (
                    <>
                      <span className="font-medium">Sends {whenLabel(thread.sendAt)}</span>
                      {thread.event?.ifNoReply ? ', unless the customer writes first.' : '.'} Then the conversation becomes {(STATUS_LABEL[thread.event?.status as string] ?? 'closed').toLowerCase()}.
                    </>
                  ) : (
                    <>
                      <span className="font-medium">Not sent.</span> The customer wrote before it was due.
                    </>
                  )}
                </p>
                <Button size="sm" loading={act.isPending && act.variables === 'send'} disabled={act.isPending} onClick={() => act.mutate('send')}>
                  Send now
                </Button>
                <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('cancel')}>
                  {thread.sendAt ? 'Cancel' : 'Back to draft'}
                </Button>
              </div>
            )}
            {thread.state === 'failed' && (
              <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">This reply was not sent.</p>
                  <p>{thread.error}</p>
                </div>
                <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()} icon={<RefreshCw className="size-3.5" aria-hidden />}>
                  Send again
                </Button>
              </div>
            )}
            <div
              className="prose-mail [&_img]:cursor-zoom-in"
              dangerouslySetInnerHTML={{ __html: html }}
              // A picture inside the message opens large too, unless it is a link.
              onClick={(e) => {
                const target = e.target as HTMLElement
                if (target instanceof HTMLImageElement && !target.closest('a')) lightbox(new URL(target.src).pathname.startsWith('/api/attachments/') ? new URL(target.src).pathname : target.src, { url: target.src, filename: target.alt || 'Image' })
              }}
            />
            {thread.hasQuoted && (
              <button
                type="button"
                onClick={() => setShowQuoted((open) => !open)}
                aria-expanded={showQuoted}
                className={cx('mt-4 inline-flex h-6 items-center rounded-md px-2 text-xs font-medium text-fg-3 hover:text-fg', isNote ? 'bg-black/5 hover:bg-black/10 dark:bg-white/10' : 'bg-sunken hover:bg-hover')}
              >
                {quoted.isFetching ? 'Loading…' : showQuoted ? 'Hide quoted text' : 'Show quoted text'}
              </button>
            )}
            {files.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-2">
                {files.map((file) => (
                  <AttachmentChip key={file.id} file={file} />
                ))}
              </ul>
            )}
          </div>
        )}
      </article>
    </li>
  )
}

const stripTags = (html: string) => {
  const el = document.createElement('div')
  el.innerHTML = html.replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, ' ')
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function AttachmentChip({ file }: { file: Attachment }) {
  const lightbox = useLightbox()
  const isImage = isImageType(file.mime)
  const chip = 'group flex h-11 max-w-64 items-center gap-2.5 rounded-lg border border-line bg-surface pr-3 pl-1.5 text-left transition-colors hover:border-line-strong hover:bg-sunken'
  const label = (
    <span className="min-w-0">
      <span className="block truncate text-[13px] font-medium">{file.filename}</span>
      <span className="block text-xs text-fg-3">{fileSize(file.size)}</span>
    </span>
  )
  return (
    <li>
      {isImage ? (
        // Images open large over the page. Other files open in a new tab.
        <button type="button" onClick={() => lightbox(file.url)} aria-label={`View ${file.filename}`} className={chip}>
          <img src={file.url} alt="" className="size-8 rounded-md object-cover" loading="lazy" />
          {label}
          <Expand className="size-3.5 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
        </button>
      ) : (
        <a href={file.url} target="_blank" rel="noreferrer" className={chip}>
          <span className="flex size-8 items-center justify-center rounded-md bg-sunken text-fg-3">
            <FileText className="size-4" aria-hidden />
          </span>
          {label}
          <Download className="size-3.5 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        </a>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

function MergeDialog({ conversation, onClose, onMerged }: { conversation: Conversation; onClose: () => void; onMerged: (targetId: number) => void }) {
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<ConversationSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const term = useDebounced(query.trim(), 200)
  const results = useQuery({
    queryKey: ['merge-search', conversation.id, term],
    queryFn: () =>
      api
        .get<{ items: ConversationSummary[] }>(`/conversations${qs(term ? { q: term, limit: 8 } : { customer: conversation.customer.id, limit: 8 })}`)
        .then((r) => r.items.filter((c) => c.id !== conversation.id)),
  })
  const merge = useMutation({
    mutationFn: () => api.post(`/conversations/${conversation.id}/merge`, { intoId: target!.id }),
    onSuccess: () => onMerged(target!.id),
    onError: (err: Error) => setError(err.message),
  })
  return (
    <Modal
      open
      onClose={onClose}
      title="Merge into another conversation"
      description="Every message here moves into the conversation you pick. This one is then removed."
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!target} loading={merge.isPending} onClick={() => merge.mutate()}>
            {target ? `Merge into #${target.id}` : 'Merge'}
          </Button>
        </>
      }
    >
      {error && <p className="mb-3 text-[13px] text-danger">{error}</p>}
      <Input autoFocus aria-label="Search conversations" placeholder="Search by subject, customer or number" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto" role="listbox" aria-label="Conversations">
        {results.data?.length === 0 && <li className="py-6 text-center text-[13px] text-fg-3">{term ? 'No conversation matches.' : 'This customer has no other conversations. Search to find one.'}</li>}
        {results.data?.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              role="option"
              aria-selected={target?.id === c.id}
              onClick={() => setTarget(c)}
              className={cx('flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors', target?.id === c.id ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-sunken')}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{c.subject}</span>
                <span className="block truncate text-xs text-fg-3">
                  #{c.id} · {c.customer.name} · {messageTime(c.updatedAt)}
                </span>
              </span>
              <StatusBadge status={c.status} />
              {target?.id === c.id && <Check className="size-4 text-accent-fg" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
