import { useState, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Building, CreditCard, Download, KeyRound, Mail, Plus, Puzzle, Tag as TagIcon, Trash2, UserRound, Users, Workflow as WorkflowIcon } from 'lucide-react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useDocumentTitle, useSession, useTags, useUsers } from '../lib/hooks'
import type { Tag, User } from '../lib/types'
import { Avatar, Banner, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Popover, Select, Spinner, Switch, cx, useFeedback } from '../ui'
import { RichField } from '../inbox/Editor'
import { MailboxesSettings } from './Mailboxes'
import { SavedRepliesSettings, WorkflowsSettings } from './Automation'
import { ApiSettings } from './ApiMcp'
import { AppsSettings } from './Apps'
import { WorkspaceSettings } from './Workspace'
import { ImportSettings } from './Import'
import { BillingSettings } from './Billing'
import { workspace } from '../lib/workspace'

const NAV: { to: string; label: string; icon: ReactNode; admin?: boolean; hosted?: boolean }[] = [
  { to: 'profile', label: 'Profile', icon: <UserRound /> },
  { to: 'mailboxes', label: 'Mailboxes', icon: <Mail />, admin: true },
  { to: 'team', label: 'Team', icon: <Users /> },
  { to: 'tags', label: 'Tags', icon: <TagIcon /> },
  { to: 'saved-replies', label: 'Saved replies', icon: <Bookmark /> },
  { to: 'workflows', label: 'Workflows', icon: <WorkflowIcon />, admin: true },
  { to: 'apps', label: 'Apps', icon: <Puzzle />, admin: true },
  { to: 'workspace', label: 'Workspace', icon: <Building />, admin: true },
  { to: 'billing', label: 'Billing', icon: <CreditCard />, admin: true, hosted: true },
  { to: 'import', label: 'Import', icon: <Download />, admin: true },
  { to: 'api', label: 'API & MCP', icon: <KeyRound /> },
]

export function SettingsPage() {
  useDocumentTitle('Settings')
  const { user, hosted } = useSession()
  const admin = user.role === 'admin'
  const items = NAV.filter((n) => (!n.admin || admin) && (!n.hosted || hosted))
  return (
    <div className="flex h-full flex-col bg-canvas md:flex-row">
      <nav aria-label="Settings" className="shrink-0 border-line bg-surface md:w-52 md:border-r md:p-3">
        <h2 className="hidden px-2.5 pt-2 pb-2 text-[15px] font-semibold md:block">Settings</h2>
        <ul className="flex gap-1 overflow-x-auto border-b border-line p-2 md:flex-col md:gap-px md:overflow-visible md:border-0 md:p-0">
          {items.map((item) => (
            <li key={item.to} className="shrink-0">
              <NavLink
                to={`/settings/${item.to}`}
                className={({ isActive }) =>
                  cx(
                    'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
                    isActive ? 'bg-accent-soft text-accent-fg' : 'text-fg-2 hover:bg-hover hover:text-fg [&>svg]:text-fg-3',
                  )
                }
              >
                {item.icon}
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 md:py-8">
          <Routes>
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<ProfileSettings />} />
            {admin && <Route path="mailboxes" element={<MailboxesSettings />} />}
            {admin && <Route path="mailboxes/:mailboxId" element={<MailboxesSettings />} />}
            <Route path="team" element={<TeamSettings />} />
            <Route path="tags" element={<TagsSettings />} />
            <Route path="saved-replies" element={<SavedRepliesSettings />} />
            {admin && <Route path="workflows" element={<WorkflowsSettings />} />}
            {admin && <Route path="apps" element={<AppsSettings />} />}
            {admin && <Route path="workspace" element={<WorkspaceSettings />} />}
            {admin && hosted && <Route path="billing" element={<BillingSettings />} />}
            {admin && <Route path="import" element={<ImportSettings />} />}
            <Route path="api" element={<ApiSettings />} />
            <Route path="*" element={<Navigate to="profile" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

function ProfileSettings() {
  const { user, refresh, passwordMin } = useSession()
  const { toast } = useFeedback()
  const [form, setForm] = useState({ name: user.name, email: user.email, signature: user.signature, notifyAssigned: user.notifyAssigned, notifyReplies: user.notifyReplies, notifyMentions: user.notifyMentions })
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' })
  const [error, setError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => api.patch('/me', form),
    onSuccess: () => {
      refresh()
      toast('Profile saved')
    },
    onError: (err: Error) => setError(err.message),
  })
  const changePassword = useMutation({
    mutationFn: () => api.patch('/me', passwords),
    onSuccess: () => {
      setPasswords({ currentPassword: '', newPassword: '' })
      toast('Password changed')
    },
    onError: (err: Error) => setPasswordError(err.message),
  })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Profile" description="Your name, signature and notifications." />
      <Card className="p-5">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            save.mutate()
          }}
        >
          {error && <Banner kind="danger">{error}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Email" hint="You sign in with this address.">
              {(id) => <Input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
            </Field>
          </div>
          <Field label="Personal signature" hint="Added under your replies. Leave it empty to use the mailbox signature.">
            {(id) => <RichField id={id} value={form.signature} onChange={(signature) => setForm((f) => ({ ...f, signature }))} placeholder={`${user.name.split(' ')[0]}, Customer Support`} minHeight={72} />}
          </Field>
          <div className="flex flex-col gap-3">
            <h3 className="text-[13px] font-medium">Email me when</h3>
            <Switch checked={form.notifyAssigned} onChange={(v) => setForm({ ...form, notifyAssigned: v })} label="A teammate assigns me a conversation" />
            <Switch checked={form.notifyReplies} onChange={(v) => setForm({ ...form, notifyReplies: v })} label="A customer replies to my conversation" />
            <Switch checked={form.notifyMentions} onChange={(v) => setForm({ ...form, notifyMentions: v })} label="A teammate mentions me in a note" />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      </Card>
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">Password</h2>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setPasswordError(null)
            changePassword.mutate()
          }}
        >
          {passwordError && <Banner kind="danger">{passwordError}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Current password">
              {(id) => <Input id={id} type="password" autoComplete="current-password" required value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} />}
            </Field>
            <Field label="New password" hint={`At least ${passwordMin} characters.`}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={passwordMin} value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} />}
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={changePassword.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------------------------

function TeamSettings() {
  const { user: me } = useSession()
  const users = useUsers()
  const [editing, setEditing] = useState<User | 'new' | null>(null)
  const admin = me.role === 'admin'
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Team"
        description="The people who answer conversations."
        action={
          admin && (
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
              Invite teammate
            </Button>
          )
        }
      />
      {users.isPending ? (
        <Spinner />
      ) : (
        <Card className="divide-y divide-line">
          {users.data?.map((u) => (
            <div key={u.id} className={cx('flex items-center gap-3 px-5 py-3', u.disabled && 'opacity-60')}>
              <Avatar name={u.name} color={u.color} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {u.name}
                  {u.id === me.id && <span className="ml-1.5 text-[13px] font-normal text-fg-3">(you)</span>}
                </p>
                <p className="truncate text-[13px] text-fg-3">{u.email}</p>
              </div>
              <span className="text-[13px] text-fg-2">
                {u.disabled ? 'Deactivated' : `${u.pending ? 'Invited · ' : ''}${u.role === 'admin' ? 'Admin' : 'Agent'}`}
              </span>
              {admin && (
                <Button size="sm" onClick={() => setEditing(u)}>
                  Edit
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
      {editing && <TeammateForm user={editing === 'new' ? null : editing} isSelf={editing !== 'new' && editing.id === me.id} onClose={() => setEditing(null)} />}
    </div>
  )
}

function TeammateForm({ user, isSelf, onClose }: { user: User | null; isSelf: boolean; onClose: () => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const { hosted, passwordMin } = useSession()
  const [form, setForm] = useState({ name: user?.name ?? '', email: user?.email ?? '', role: user?.role ?? 'agent', password: '' })
  const [typePassword, setTypePassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inviting = !user && !typePassword
  const done = (message: string) => {
    void client.invalidateQueries({ queryKey: ['users'] })
    toast(message)
    onClose()
  }
  const invite = () => api.post('/invites', { email: form.email, role: form.role })
  const save = useMutation({
    mutationFn: () => (user ? api.patch(`/users/${user.id}`, { ...form, password: form.password || undefined }) : inviting ? invite() : api.post('/users', form)),
    onSuccess: () => done(user ? 'Teammate saved' : inviting ? `Invite sent to ${form.email}` : 'Teammate added'),
    onError: (err: Error) => setError(err.message),
  })
  const toggle = useMutation({
    mutationFn: () => api.patch(`/users/${user!.id}`, { disabled: !user!.disabled }),
    onSuccess: () => done(user!.disabled ? 'Teammate reactivated' : 'Teammate deactivated'),
    onError: (err: Error) => setError(err.message),
  })
  const resend = useMutation({ mutationFn: invite, onSuccess: () => done(`Invite sent again to ${form.email}`), onError: (err: Error) => setError(err.message) })
  const cancel = useMutation({ mutationFn: () => api.del(`/invites/${user!.id}`), onSuccess: () => done('Invite cancelled'), onError: (err: Error) => setError(err.message) })
  const waiting = !!user?.pending && !user.disabled
  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Invite a teammate'}
      description={
        user
          ? waiting
            ? 'Invited, and has not joined yet. The link in the email works for 24 hours.'
            : undefined
          : inviting
            ? 'They get an email with a link to choose their name and password. The link works for 24 hours.'
            : 'Create their account, then send them the sign-in address and password.'
      }
      footer={
        <>
          {waiting ? (
            <Button variant="ghost" className="mr-auto text-danger hover:text-danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel invite
            </Button>
          ) : (
            user &&
            !isSelf && (
              <Button variant="ghost" className="mr-auto text-danger hover:text-danger" loading={toggle.isPending} onClick={() => toggle.mutate()}>
                {user.disabled ? 'Reactivate' : 'Deactivate'}
              </Button>
            )
          )}
          {waiting && (
            <Button loading={resend.isPending} onClick={() => resend.mutate()}>
              Send invite again
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {user ? 'Save changes' : inviting ? 'Send invite' : 'Add teammate'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        {error && <Banner kind="danger">{error}</Banner>}
        {!inviting && <Field label="Name">{(id) => <Input id={id} required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>}
        <Field label="Email">{(id) => <Input id={id} type="email" required autoFocus={inviting} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
        <Field label="Role" hint="Admins can also manage mailboxes, teammates and workflows.">
          {(id) => (
            <Select id={id} value={form.role} disabled={isSelf} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'agent' })}>
              <option value="agent">Agent</option>
              <option value="admin">Admin</option>
            </Select>
          )}
        </Field>
        {!user && !hosted && <Switch checked={typePassword} onChange={setTypePassword} label="Set their password myself" description="Use this when this install cannot send email yet." />}
        {!inviting && !hosted && (
          <Field
            label={user && !waiting ? 'New password' : 'Password'}
            hint={waiting ? 'Optional. Set one yourself when the invite email cannot reach them.' : user ? 'Leave blank to keep their current password.' : `At least ${passwordMin} characters.`}
          >
            {(id) => <Input id={id} type="password" autoComplete="new-password" required={!user} minLength={passwordMin} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

const TAG_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b']

function TagsSettings() {
  const tags = useTags()
  const client = useQueryClient()
  const { toast, confirm } = useFeedback()
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_COLORS[0])
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['tags'] })
    void client.invalidateQueries({ queryKey: ['conversations'] })
    void client.invalidateQueries({ queryKey: ['conversation'] })
  }
  const create = useMutation({
    mutationFn: () => api.post('/tags', { name, color }),
    onSuccess: () => {
      setName('')
      refresh()
    },
    onError: (err: Error) => toast(err.message, { kind: 'error' }),
  })
  const recolor = useMutation({ mutationFn: (tag: { id: number; color: string }) => api.patch(`/tags/${tag.id}`, { color: tag.color }), onSuccess: refresh })
  const remove = async (tag: Tag) => {
    const ok = await confirm({ title: `Delete the tag “${tag.name}”?`, body: tag.count ? `It is removed from ${plural(tag.count, 'conversation')}. The conversations stay.` : undefined, confirmLabel: 'Delete tag', danger: true })
    if (!ok) return
    await api.del(`/tags/${tag.id}`)
    refresh()
    toast('Tag deleted')
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Tags" description="Label conversations by topic to find and report on them later." />
      <Card className="p-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <Field label="New tag" className="min-w-48 flex-1">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="billing" />}
          </Field>
          <ColorPicker value={color} onChange={setColor} />
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
            Add tag
          </Button>
        </form>
      </Card>
      {tags.isPending ? (
        <Spinner />
      ) : tags.data?.length === 0 ? (
        <Card>
          <EmptyState icon={<TagIcon />} title="No tags yet" body="Add one above, or type a new tag on any conversation." />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {tags.data?.map((tag) => (
            <div key={tag.id} className="flex items-center gap-3 px-5 py-2.5">
              <ColorPicker value={tag.color} onChange={(c) => recolor.mutate({ id: tag.id, color: c })} compact />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{tag.name}</span>
              <span className="text-[13px] text-fg-3">{plural(tag.count ?? 0, 'conversation')}</span>
              <IconButton label={`Delete tag ${tag.name}`} size="sm" onClick={() => void remove(tag)}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

function ColorPicker({ value, onChange, compact }: { value: string; onChange: (color: string) => void; compact?: boolean }) {
  if (compact) {
    return (
      <Popover
        role="dialog"
        trigger={({ ref, ...props }) => <button ref={ref} type="button" {...props} aria-label="Change tag color" title="Change color" className="size-4 shrink-0 rounded-full" style={{ background: value }} />}
      >
        {(close) => (
          <div className="flex gap-1.5 p-1.5">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={value === c}
                onClick={() => {
                  onChange(c)
                  close()
                }}
                className={cx('size-5 rounded-full ring-offset-2 ring-offset-surface', value === c && 'ring-2 ring-fg')}
                style={{ background: c }}
              />
            ))}
          </div>
        )}
      </Popover>
    )
  }
  return (
    <fieldset className="flex h-9 items-center gap-1.5">
      <legend className="sr-only">Tag color</legend>
      {TAG_COLORS.map((c) => (
        <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={value === c} onClick={() => onChange(c)} className={cx('size-5 rounded-full ring-offset-2 ring-offset-surface', value === c && 'ring-2 ring-fg')} style={{ background: c }} />
      ))}
    </fieldset>
  )
}

