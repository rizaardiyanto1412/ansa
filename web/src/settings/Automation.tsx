import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Plus, Trash2, Workflow as WorkflowIcon, X } from 'lucide-react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useMailboxes, useSavedReplies, useUsers } from '../lib/hooks'
import type { SavedReply, Workflow, WorkflowAction, WorkflowCondition } from '../lib/types'
import { Banner, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Switch, useFeedback } from '../ui'
import { RichField } from '../inbox/Editor'

// ---------------------------------------------------------------------------------------------
// Saved replies
// ---------------------------------------------------------------------------------------------

export function SavedRepliesSettings() {
  const replies = useSavedReplies()
  const [editing, setEditing] = useState<SavedReply | 'new' | null>(null)
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Saved replies"
        description="Answers to common questions. Insert one from the reply box with a click."
        action={
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
            New saved reply
          </Button>
        }
      />
      {replies.isPending ? (
        <Spinner />
      ) : replies.data?.length === 0 ? (
        <Card>
          <EmptyState icon={<Bookmark />} title="No saved replies yet" body="Write an answer once and reuse it in any conversation." />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {replies.data?.map((reply) => (
            <button key={reply.id} type="button" onClick={() => setEditing(reply)} className="block w-full px-5 py-3 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-sunken">
              <span className="block text-sm font-medium">{reply.name}</span>
              <span className="block truncate text-[13px] text-fg-3">{reply.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}</span>
            </button>
          ))}
        </Card>
      )}
      {editing && <SavedReplyForm reply={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function SavedReplyForm({ reply, onClose }: { reply: SavedReply | null; onClose: () => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const mailboxes = useMailboxes()
  const [name, setName] = useState(reply?.name ?? '')
  const [bodyHtml, setBodyHtml] = useState(reply?.bodyHtml ?? '')
  const [mailboxId, setMailboxId] = useState<number | null>(reply?.mailboxId ?? null)
  const [error, setError] = useState<string | null>(null)
  const done = (message: string) => {
    void client.invalidateQueries({ queryKey: ['saved-replies'] })
    toast(message)
    onClose()
  }
  const save = useMutation({
    mutationFn: () => (reply ? api.patch(`/saved-replies/${reply.id}`, { name, bodyHtml, mailboxId }) : api.post('/saved-replies', { name, bodyHtml, mailboxId })),
    onSuccess: () => done('Saved reply saved'),
    onError: (err: Error) => setError(err.message),
  })
  const remove = useMutation({ mutationFn: () => api.del(`/saved-replies/${reply!.id}`), onSuccess: () => done('Saved reply deleted') })
  return (
    <Modal
      open
      onClose={onClose}
      title={reply ? 'Edit saved reply' : 'New saved reply'}
      width={600}
      footer={
        <>
          {reply && (
            <Button variant="ghost" className="mr-auto text-danger hover:text-danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Banner kind="danger">{error}</Banner>}
        <Field label="Name" hint="Only your team sees this.">
          {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Refund policy" />}
        </Field>
        <Field label="Reply" hint="You can use {{customer.firstName}}, {{customer.name}} and {{agent.firstName}}.">
          {(id) => <RichField id={id} value={bodyHtml} onChange={setBodyHtml} placeholder="Hi {{customer.firstName}}," minHeight={140} />}
        </Field>
        {(mailboxes.data?.length ?? 0) > 1 && (
          <Field label="Available in">
            {(id) => (
              <Select id={id} value={mailboxId ?? ''} onChange={(e) => setMailboxId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Every mailbox</option>
                {mailboxes.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------------------------

const FIELD_LABEL: Record<WorkflowCondition['field'], string> = { subject: 'Subject', body: 'Message', from: 'Sender email', to: 'Sent to', customer_name: 'Customer name' }
const OP_LABEL: Record<WorkflowCondition['op'], string> = { contains: 'contains', not_contains: 'does not contain', is: 'is exactly', starts_with: 'starts with', ends_with: 'ends with' }
const ACTION_LABEL: Record<WorkflowAction['type'], string> = { add_tag: 'Add tag', assign: 'Assign to', set_status: 'Set status to', add_note: 'Add note' }
const TRIGGER_LABEL: Record<Workflow['trigger'], string> = { new: 'A new conversation arrives', customer_reply: 'A customer replies', any: 'Any customer message arrives' }

export function WorkflowsSettings() {
  const client = useQueryClient()
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api.get<{ workflows: Workflow[] }>('/workflows').then((r) => r.workflows) })
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null)
  const toggle = useMutation({
    mutationFn: (w: Workflow) => api.patch(`/workflows/${w.id}`, { enabled: !w.enabled }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['workflows'] }),
  })
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Workflows"
        description="Rules that tag, assign or sort incoming email for you."
        action={
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
            New workflow
          </Button>
        }
      />
      {workflows.isPending ? (
        <Spinner />
      ) : workflows.data?.length === 0 ? (
        <Card>
          <EmptyState icon={<WorkflowIcon />} title="No workflows yet" body="For example: when the subject contains “refund”, add the tag billing and assign it to a teammate." />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {workflows.data?.map((w) => (
            <div key={w.id} className="flex items-center gap-4 px-5 py-3">
              <button type="button" onClick={() => setEditing(w)} className="min-w-0 flex-1 rounded text-left">
                <span className="block text-sm font-medium">{w.name}</span>
                <span className="block truncate text-[13px] text-fg-3">
                  {TRIGGER_LABEL[w.trigger]} · {plural(w.conditions.length, 'condition')} · ran {plural(w.runCount, 'time')}
                </span>
              </button>
              <Switch checked={w.enabled} onChange={() => toggle.mutate(w)} label={w.enabled ? 'On' : 'Off'} />
            </div>
          ))}
        </Card>
      )}
      {editing && <WorkflowForm workflow={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function WorkflowForm({ workflow, onClose }: { workflow: Workflow | null; onClose: () => void }) {
  const client = useQueryClient()
  const { toast } = useFeedback()
  const users = useUsers()
  const mailboxes = useMailboxes()
  const [form, setForm] = useState({
    name: workflow?.name ?? '',
    mailboxId: workflow?.mailboxId ?? null,
    trigger: workflow?.trigger ?? ('new' as Workflow['trigger']),
    match: workflow?.match ?? ('all' as Workflow['match']),
    conditions: workflow?.conditions ?? ([{ field: 'subject', op: 'contains', value: '' }] as WorkflowCondition[]),
    actions: workflow?.actions ?? ([{ type: 'add_tag', value: '' }] as WorkflowAction[]),
  })
  const [error, setError] = useState<string | null>(null)
  const done = (message: string) => {
    void client.invalidateQueries({ queryKey: ['workflows'] })
    toast(message)
    onClose()
  }
  const save = useMutation({
    mutationFn: () => (workflow ? api.patch(`/workflows/${workflow.id}`, form) : api.post('/workflows', form)),
    onSuccess: () => done('Workflow saved'),
    onError: (err: Error) => setError(err.message),
  })
  const remove = useMutation({ mutationFn: () => api.del(`/workflows/${workflow!.id}`), onSuccess: () => done('Workflow deleted') })
  const setCondition = (i: number, patch: Partial<WorkflowCondition>) => setForm((f) => ({ ...f, conditions: f.conditions.map((c, n) => (n === i ? { ...c, ...patch } : c)) }))
  const setAction = (i: number, patch: Partial<WorkflowAction>) => setForm((f) => ({ ...f, actions: f.actions.map((a, n) => (n === i ? { ...a, ...patch } : a)) }))
  const activeUsers = (users.data ?? []).filter((u) => !u.disabled && !u.pending)

  return (
    <Modal
      open
      onClose={onClose}
      title={workflow ? 'Edit workflow' : 'New workflow'}
      width={640}
      footer={
        <>
          {workflow && (
            <Button variant="ghost" className="mr-auto text-danger hover:text-danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save workflow
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Banner kind="danger">{error}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Tag refund requests" />}</Field>
          <Field label="Mailbox">
            {(id) => (
              <Select id={id} value={form.mailboxId ?? ''} onChange={(e) => setForm({ ...form, mailboxId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Every mailbox</option>
                {mailboxes.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="When">
          {(id) => (
            <Select id={id} value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value as Workflow['trigger'] })}>
              {(Object.keys(TRIGGER_LABEL) as Workflow['trigger'][]).map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABEL[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 flex w-full items-center gap-2 text-[13px] font-medium">
            And
            <Select aria-label="Match" className="h-7 w-auto py-0 text-[13px]" value={form.match} onChange={(e) => setForm({ ...form, match: e.target.value as Workflow['match'] })}>
              <option value="all">all</option>
              <option value="any">any</option>
            </Select>
            of these are true
          </legend>
          {form.conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <Select aria-label="Field" className="sm:w-40" value={c.field} onChange={(e) => setCondition(i, { field: e.target.value as WorkflowCondition['field'] })}>
                {(Object.keys(FIELD_LABEL) as WorkflowCondition['field'][]).map((f) => (
                  <option key={f} value={f}>
                    {FIELD_LABEL[f]}
                  </option>
                ))}
              </Select>
              <Select aria-label="Comparison" className="sm:w-44" value={c.op} onChange={(e) => setCondition(i, { op: e.target.value as WorkflowCondition['op'] })}>
                {(Object.keys(OP_LABEL) as WorkflowCondition['op'][]).map((o) => (
                  <option key={o} value={o}>
                    {OP_LABEL[o]}
                  </option>
                ))}
              </Select>
              <Input aria-label="Value" className="min-w-0 flex-1" value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} placeholder="refund" />
              <IconButton label="Remove condition" onClick={() => setForm((f) => ({ ...f, conditions: f.conditions.filter((_, n) => n !== i) }))}>
                <X className="size-4" />
              </IconButton>
            </div>
          ))}
          {form.conditions.length === 0 && <p className="text-[13px] text-fg-3">No conditions: this workflow runs on every message.</p>}
          <div>
            <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setForm((f) => ({ ...f, conditions: [...f.conditions, { field: 'subject', op: 'contains', value: '' }] }))}>
              Add condition
            </Button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-medium">Then</legend>
          {form.actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <Select
                aria-label="Action"
                className="sm:w-40"
                value={a.type}
                onChange={(e) => {
                  const type = e.target.value as WorkflowAction['type']
                  setAction(i, { type, value: type === 'set_status' ? 'closed' : type === 'assign' ? String(activeUsers[0]?.id ?? '') : '' })
                }}
              >
                {(Object.keys(ACTION_LABEL) as WorkflowAction['type'][]).map((t) => (
                  <option key={t} value={t}>
                    {ACTION_LABEL[t]}
                  </option>
                ))}
              </Select>
              {a.type === 'assign' ? (
                <Select aria-label="Teammate" className="min-w-0 flex-1" value={a.value} onChange={(e) => setAction(i, { value: e.target.value })}>
                  {activeUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              ) : a.type === 'set_status' ? (
                <Select aria-label="Status" className="min-w-0 flex-1" value={a.value} onChange={(e) => setAction(i, { value: e.target.value })}>
                  <option value="closed">Closed</option>
                  <option value="pending">Pending</option>
                  <option value="spam">Spam</option>
                </Select>
              ) : (
                <Input aria-label="Value" className="min-w-0 flex-1" value={a.value} onChange={(e) => setAction(i, { value: e.target.value })} placeholder={a.type === 'add_tag' ? 'billing' : 'Check the account before replying'} />
              )}
              <IconButton label="Remove action" disabled={form.actions.length === 1} onClick={() => setForm((f) => ({ ...f, actions: f.actions.filter((_, n) => n !== i) }))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          <div>
            <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setForm((f) => ({ ...f, actions: [...f.actions, { type: 'add_tag', value: '' }] }))}>
              Add action
            </Button>
          </div>
        </fieldset>
      </div>
    </Modal>
  )
}
