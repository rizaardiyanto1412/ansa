import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUpDown, Check, ChevronDown, Inbox, Minus, Paperclip, Search, ShieldAlert, Trash2, UserRound, UserRoundCheck, X } from 'lucide-react'
import { api, qs } from '../lib/api'
import { plural, shortTime, STATUS_LABEL } from '../lib/format'
import { useDebounced, useDocumentTitle, useHotkeys, useLocalState, useMailboxes, usePresence, useSession, useUsers } from '../lib/hooks'
import type { ConversationSummary, Folder, Viewer } from '../lib/types'
import { Avatar, Button, EmptyState, PresenceAvatars, IconButton, Input, MenuItem, Popover, Spinner, StatusBadge, cx, useFeedback, MenuDivider, MenuLabel } from '../ui'
import { FOLDERS } from '../Shell'
import { STATUS_DOT, statusOptions, workspace } from '../lib/workspace'
import { ConversationView } from './ConversationView'

type Sort = 'recent' | 'waiting' | 'oldest'
const SORTS: Record<Sort, string> = { recent: 'Newest activity', waiting: 'Longest waiting', oldest: 'Oldest activity' }
const PAGE = 40

const EMPTY: Record<Folder, { title: string; body: string }> = {
  unassigned: { title: 'All caught up', body: 'New conversations that nobody owns yet show up here.' },
  mine: { title: 'Nothing on your plate', body: 'Conversations assigned to you show up here.' },
  pending: { title: 'Nothing is waiting on a customer', body: 'Conversations you answered and set to “Waiting on customer” stay here until the customer writes back.' },
  mentioned: { title: 'No mentions', body: 'Open conversations where a teammate mentioned you in a note show up here.' },
  assigned: { title: 'Nothing assigned', body: 'Open conversations that have an owner show up here.' },
  snoozed: { title: 'Nothing snoozed', body: 'Snooze a conversation to hide it until you need it.' },
  closed: { title: 'No closed conversations', body: 'Conversations you close are kept here.' },
  spam: { title: 'No spam', body: 'Conversations marked as spam are kept here.' },
  all: { title: 'No conversations yet', body: 'Every conversation in this mailbox shows up here.' },
}

export function InboxPage({ search = false }: { search?: boolean }) {
  const params = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { user } = useSession()
  const presence = usePresence()
  const { toast, confirm } = useFeedback()
  const mailboxes = useMailboxes()
  const users = useUsers()
  const [searchParams, setSearchParams] = useSearchParams()
  const mailboxId = Number(params.mailboxId) || undefined
  const folder = (params.folder as Folder) || 'all'
  const selectedId = Number(params.conversationId) || null
  const q = searchParams.get('q') ?? ''
  const [draftQuery, setDraftQuery] = useState(q)
  const debouncedQuery = useDebounced(draftQuery, 300)
  const [sort, setSort] = useLocalState<Sort>('ansa-sort', 'recent')
  const [checked, setChecked] = useState<Set<number>>(new Set())

  const mailbox = mailboxes.data?.find((m) => m.id === mailboxId)
  const folderInfo = FOLDERS.find((f) => f.id === folder)
  const base = search ? '/search' : `/m/${mailboxId}/${folder}`
  const suffix = search && q ? qs({ q }) : ''
  useDocumentTitle(search ? `Search: ${q}` : selectedId ? '' : `${folderInfo?.label ?? 'Conversations'}${mailbox ? ` · ${mailbox.name}` : ''}`)

  useEffect(() => {
    if (search && debouncedQuery !== q) setSearchParams(debouncedQuery ? { q: debouncedQuery } : {}, { replace: true })
  }, [debouncedQuery]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setChecked(new Set()), [base, q])

  const view = search ? { q, sort } : { mailbox: mailboxId, folder, sort }
  const list = useInfiniteQuery({
    queryKey: ['conversations', view],
    queryFn: ({ pageParam }) => api.get<{ items: ConversationSummary[]; total: number }>(`/conversations${qs({ ...view, limit: PAGE, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (pages.length * PAGE < last.total ? pages.length * PAGE : undefined),
    enabled: search ? q.trim().length > 0 : !!mailboxId,
    placeholderData: (previous, previousQuery) => (previousQuery && JSON.stringify(previousQuery.queryKey[1]) === JSON.stringify(view) ? previous : undefined),
  })
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const total = list.data?.pages[0]?.total ?? 0

  const open = (id: number | null) => navigate(id ? `${base}/${id}${suffix}` : `${base}${suffix}`)
  const step = (delta: number) => {
    if (items.length === 0) return
    const index = items.findIndex((c) => c.id === selectedId)
    const next = items[index === -1 ? 0 : Math.min(items.length - 1, Math.max(0, index + delta))]
    if (next && next.id !== selectedId) open(next.id)
  }
  /** After closing a conversation, move to the next one in the list. */
  const advance = () => {
    const index = items.findIndex((c) => c.id === selectedId)
    const next = items[index + 1] ?? items[index - 1]
    open(next && ['unassigned', 'mine', 'assigned'].includes(folder) && !search ? next.id : null)
  }
  useHotkeys({ j: () => step(1), k: () => step(-1), escape: () => selectedId && !document.querySelector('[role=dialog], [role=menu]') && open(null) })

  const bulk = useMutation({
    mutationFn: (payload: { patch?: Record<string, unknown>; delete?: boolean }) => api.post('/conversations/bulk', { ids: [...checked], ...payload }),
    onSuccess: (_data, payload) => {
      toast(`${plural(checked.size, 'conversation')} ${payload.delete ? 'deleted' : 'updated'}`)
      setChecked(new Set())
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['mailboxes'] })
      void client.invalidateQueries({ queryKey: ['conversation'] })
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const bulkDelete = async () => {
    const ok = await confirm({ title: `Delete ${plural(checked.size, 'conversation')}?`, body: 'Their messages, notes and attachments are removed for the whole team. You cannot undo this.', confirmLabel: 'Delete', danger: true })
    if (ok) bulk.mutate({ delete: true })
  }

  if (!search && mailboxes.data && !mailbox) return <Navigate to="/" replace />
  if (!search && !FOLDERS.some((f) => f.id === folder) && folder !== 'all') return <Navigate to={`/m/${mailboxId}/unassigned`} replace />

  const toggle = (id: number) =>
    setChecked((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const needsMail = !search && mailbox && !mailbox.imapEnabled && total === 0 && folder === 'unassigned'

  if (selectedId) {
    return <ConversationView key={selectedId} id={selectedId} onBack={() => open(null)} onDone={advance} />
  }

  const openFolder = !search && ['unassigned', 'mine', 'mentioned', 'assigned'].includes(folder)
  const allChecked = items.length > 0 && items.every((c) => checked.has(c.id))
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(items.map((c) => c.id)))

  return (
    <section className="flex h-full flex-col" aria-label="Conversations">
      {checked.size > 0 ? (
        <div className="flex h-14 shrink-0 items-center gap-1.5 border-b border-accent/20 bg-accent-soft pr-3 pl-3 md:pr-4">
          <button type="button" aria-label="Clear selection" onClick={() => setChecked(new Set())} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-accent-fg transition-colors hover:bg-accent/10">
            <X className="size-4" aria-hidden />
          </button>
          <span className="text-[13px] font-semibold whitespace-nowrap text-accent-fg">
            <span className="tabular-nums">{checked.size}</span> selected
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Popover
              align="end"
              width={230}
              trigger={({ ref, ...props }) => (
                <button ref={ref} type="button" {...props} disabled={bulk.isPending} aria-label="Set status" className="flex h-8 items-center gap-1.5 rounded-lg bg-accent pr-2 pl-3 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(34,31,92,0.25)] transition-colors hover:bg-accent-hover disabled:opacity-60">
                  Status
                  <ChevronDown className="size-3.5 opacity-80" aria-hidden />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>Set status to</MenuLabel>
                  {statusOptions().map((status) => (
                    <MenuItem
                      key={status}
                      icon={<span className={cx('size-2 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />}
                      onSelect={() => {
                        close()
                        bulk.mutate({ patch: { status } })
                      }}
                    >
                      {STATUS_LABEL[status]}
                    </MenuItem>
                  ))}
                </>
              )}
            </Popover>
            <Popover
              align="end"
              width={230}
              trigger={({ ref, ...props }) => (
                <button ref={ref} type="button" {...props} disabled={bulk.isPending} aria-label="Assign" className="flex h-8 items-center gap-1.5 rounded-lg border border-accent/25 bg-surface pr-2 pl-2.5 text-[13px] font-medium text-fg transition-colors hover:border-accent disabled:opacity-60">
                  <UserRoundCheck className="size-4 text-fg-2" aria-hidden />
                  <span className="hidden sm:inline">Assign</span>
                  <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>Assign to</MenuLabel>
                  {(users.data ?? [])
                    .filter((u) => !u.disabled)
                    // Yourself first: it is the most common choice.
                    .sort((x, y) => Number(y.id === user.id) - Number(x.id === user.id))
                    .map((u) => (
                      <MenuItem
                        key={u.id}
                        icon={<Avatar name={u.name} color={u.color} size={20} />}
                        onSelect={() => {
                          close()
                          bulk.mutate({ patch: { assigneeId: u.id } })
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
                    onSelect={() => {
                      close()
                      bulk.mutate({ patch: { assigneeId: null } })
                    }}
                  >
                    Unassigned
                  </MenuItem>
                </>
              )}
            </Popover>
            <span className="mx-1.5 hidden h-5 w-px bg-accent/25 sm:block" aria-hidden />
            <button type="button" disabled={bulk.isPending} onClick={() => bulk.mutate({ patch: { status: 'spam' } })} aria-label="Mark as spam" className="flex h-8 items-center gap-1.5 rounded-lg pr-2.5 pl-2 text-[13px] font-medium text-fg-2 transition-colors hover:bg-accent/10 hover:text-fg disabled:opacity-60">
              <ShieldAlert className="size-4" aria-hidden />
              <span className="hidden sm:inline">Spam</span>
            </button>
            <button type="button" disabled={bulk.isPending} onClick={() => void bulkDelete()} aria-label="Delete" className="flex h-8 items-center gap-1.5 rounded-lg pr-2.5 pl-2 text-[13px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-60">
              <Trash2 className="size-4" aria-hidden />
              <span className="hidden sm:inline">Delete</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 md:px-5">
          {search ? (
            <div className="relative max-w-xl flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-3" aria-hidden />
              <Input autoFocus aria-label="Search conversations" placeholder="Search conversations" className="h-9 pl-8" value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} />
            </div>
          ) : (
            <h1 className="min-w-0 truncate text-[15px] font-semibold">{folderInfo?.label ?? 'All conversations'}</h1>
          )}
          <span className="flex-1" />
          <Popover
            align="end"
            trigger={({ ref, ...props }) => (
              <IconButton ref={ref} {...props} label={`Sort: ${SORTS[sort]}`} size="sm">
                <ArrowUpDown className="size-4" />
              </IconButton>
            )}
          >
            {(close) =>
              (Object.keys(SORTS) as Sort[]).map((s) => (
                <MenuItem
                  key={s}
                  checked={sort === s}
                  onSelect={() => {
                    setSort(s)
                    close()
                  }}
                >
                  {SORTS[s]}
                </MenuItem>
              ))
            }
          </Popover>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending && list.fetchStatus !== 'idle' ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : list.isError ? (
          <EmptyState title="Could not load conversations" body={(list.error as Error).message} action={<Button onClick={() => void list.refetch()}>Try again</Button>} />
        ) : search && !q.trim() ? (
          <EmptyState icon={<Search />} title="Search every conversation" body="Find words in subjects, messages and notes, or a customer by name or email." />
        ) : items.length === 0 ? (
          search ? (
            <EmptyState icon={<Search />} title="No results" body={`Nothing matches “${q}”. Check the spelling or try fewer words.`} />
          ) : needsMail ? (
            <EmptyState
              icon={<Inbox />}
              title="This mailbox is not receiving email yet"
              body={user.role === 'admin' ? 'Connect it to your email account to start receiving conversations.' : 'Ask an admin to connect it to your email account.'}
              action={
                user.role === 'admin' ? (
                  <Link to={`/settings/mailboxes/${mailbox.id}`}>
                    <Button variant="primary">Connect email</Button>
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <EmptyState icon={folderInfo ? <folderInfo.icon /> : <Inbox />} title={EMPTY[folder]?.title ?? 'Nothing here'} body={EMPTY[folder]?.body} />
          )
        ) : (
          <>
            <div className="sticky top-0 z-20 hidden h-10 items-center border-b border-line bg-surface text-xs text-fg-3 md:flex">
              <div className="flex w-12 shrink-0 justify-center">
                <CheckBox checked={allChecked} mixed={!allChecked && checked.size > 0} label="Select all conversations" onClick={toggleAll} />
              </div>
              <div className={cx(COLS, 'flex-1 pr-5')}>
                <span>Customer</span>
                <span>Conversation</span>
                <span />
                <span>Number</span>
                <span>{openFolder ? 'Waiting' : 'Last updated'}</span>
              </div>
            </div>
            <ul>
              {items.map((c) => (
                <Row key={c.id} conversation={c} to={`${base}/${c.id}${suffix}`} checked={checked.has(c.id)} onCheck={() => toggle(c.id)} showMailbox={search} folder={search ? null : folder} viewers={(presence[c.id] ?? []).filter((v) => v.userId !== user.id)} />
              ))}
            </ul>
            {list.hasNextPage ? (
              <div className="flex justify-center p-4">
                <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  Show more
                </Button>
              </div>
            ) : (
              <p className="px-4 py-4 text-[13px] text-fg-3 md:px-5">
                <span className="font-semibold text-fg-2 tabular-nums">{total.toLocaleString()}</span> {total === 1 ? 'conversation' : 'conversations'}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/** Column template shared by the header and every row, from the md breakpoint up. */
const COLS = 'md:grid md:grid-cols-[minmax(110px,194px)_minmax(0,1fr)_auto_64px_92px] md:items-center md:gap-x-4'

function CheckBox({ checked, mixed, label, onClick }: { checked: boolean; mixed?: boolean; label: string; onClick: () => void }) {
  const on = checked || mixed
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      onClick={onClick}
      className={cx('flex size-4 items-center justify-center rounded-[4px] border text-white transition-colors', on ? 'border-accent bg-accent' : 'border-line-strong bg-surface hover:border-fg-3')}
    >
      {checked ? <Check className="size-3" strokeWidth={3} aria-hidden /> : mixed ? <Minus className="size-3" strokeWidth={3} aria-hidden /> : null}
    </button>
  )
}

function Row({ conversation: c, to, checked, onCheck, showMailbox, folder, viewers }: { conversation: ConversationSummary; to: string; checked: boolean; onCheck: () => void; showMailbox: boolean; folder: Folder | null; viewers: Viewer[] }) {
  const waiting = (c.status === 'active' || c.status === 'waiting') && !!c.waitingSince
  const openFolder = folder === 'unassigned' || folder === 'mine' || folder === 'assigned' || folder === 'mentioned'
  const showStatus = folder === null || folder === 'all' || ((c.status === 'pending' || (c.status === 'waiting' && workspace().fourStatuses)) && folder !== 'closed' && folder !== 'pending') || folder === 'snoozed'
  const showAssignee = c.assignee && folder !== 'mine'
  const when = openFolder && c.waitingSince ? c.waitingSince : c.updatedAt

  return (
    <li className={cx('group flex border-b border-line transition-shadow hover:shadow-[inset_2px_0_0_var(--accent)]', checked ? 'bg-accent-soft/60' : 'hover:bg-sunken')}>
      <div className="flex w-10 shrink-0 justify-center pt-3.5 md:w-12 md:items-center md:pt-0">
        <CheckBox checked={checked} label={`Select conversation: ${c.subject}`} onClick={onCheck} />
      </div>
      <Link to={to} className={cx(COLS, 'grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2.5 pr-4 outline-offset-[-2px] md:pr-5')}>
        <span className={cx('truncate text-[13px]', waiting ? 'font-semibold text-fg' : 'font-medium text-fg-2')} title={c.customer.name || c.customer.email}>{c.customer.name || c.customer.email}</span>
        <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cx('truncate text-[13px]', waiting ? 'font-semibold text-fg' : 'font-medium text-fg')}>{c.subject || '(no subject)'}</span>
            <PresenceAvatars viewers={viewers} size={16} max={2} className="md:hidden" />
            {showStatus && <StatusBadge status={c.status} />}
            {showMailbox && <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-sunken px-1.5 text-xs font-medium text-fg-2 group-hover:bg-hover">{c.mailboxName}</span>}
            {c.tags.slice(0, 3).map((t) => (
              <span key={t.id} className="hidden h-5 shrink-0 items-center gap-1 rounded-md bg-sunken px-1.5 text-xs font-medium text-fg-2 group-hover:bg-hover sm:inline-flex">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden />
                {t.name}
              </span>
            ))}
            {c.tags.length > 3 && <span className="hidden shrink-0 text-xs text-fg-3 sm:inline">+{c.tags.length - 3}</span>}
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-fg-3">{c.preview || 'No message text'}</span>
        </span>
        <span className="hidden items-center justify-end gap-2 md:flex">
          <PresenceAvatars viewers={viewers} />
          {c.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-fg-3" aria-label="Has attachments" />}
          {showAssignee && <Avatar name={c.assignee!.name} color={c.assignee!.color} size={20} />}
          {c.threadCount > 1 && (
            <span className="flex h-5 min-w-6 shrink-0 items-center justify-center rounded border border-line-strong px-1 text-xs font-medium text-fg-2 tabular-nums" title={plural(c.threadCount, 'message')}>
              {c.threadCount}
            </span>
          )}
        </span>
        <span className="hidden text-[13px] font-medium text-fg-2 tabular-nums md:block">{c.id}</span>
        <time className={cx('col-start-2 row-start-1 shrink-0 text-xs tabular-nums md:col-start-auto md:row-start-auto md:text-[13px]', waiting ? 'font-semibold text-fg' : 'text-fg-3')} dateTime={new Date(when).toISOString()}>
          {shortTime(when)}
        </time>
      </Link>
    </li>
  )
}
