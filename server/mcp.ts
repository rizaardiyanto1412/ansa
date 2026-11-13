import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { all } from './db.ts'
import { config } from './config.ts'
import type { TokenAccess, User } from './auth.ts'
import { htmlToText, textToHtml } from './mail/html.ts'
import {
  addNote,
  addReply,
  createConversation,
  folderCounts,
  getConversation,
  listConversations,
  updateConversation,
  type Actor,
  type ConversationSummary,
} from './services/conversations.ts'
import { getCustomer, listCustomers, updateCustomer } from './services/customers.ts'
import { buildReport } from './services/reports.ts'

const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : null)
const toHtml = (body: string) => (/<(p|br|div|ul|ol|strong|em|a)\b[^>]*>/i.test(body) ? body : textToHtml(body))

const brief = (c: ConversationSummary) => ({
  id: c.id,
  subject: c.subject,
  status: c.status,
  mailbox: c.mailboxName,
  mailbox_id: c.mailboxId,
  customer: { id: c.customer.id, name: c.customer.name, email: c.customer.email },
  assignee: c.assignee ? { id: c.assignee.id, name: c.assignee.name } : null,
  tags: c.tags.map((t) => t.name),
  preview: c.preview,
  messages: c.threadCount,
  waiting_since: iso(c.waitingSince),
  snoozed_until: iso(c.snoozedUntil),
  created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt),
  url: `${config.appUrl}/c/${c.id}`,
})

function detail(id: number) {
  const c = getConversation(id)
  return {
    ...brief(c),
    customer: {
      id: c.customer.id,
      name: c.customer.name,
      email: c.customer.email,
      company: c.customer.company || undefined,
      notes: c.customer.notes || undefined,
    },
    cc: c.cc,
    thread: c.threads.map((t) =>
      t.type === 'event'
        ? { type: 'event', at: iso(t.createdAt), by: t.author.name, event: t.event }
        : {
            id: t.id,
            type: t.type === 'customer' ? 'customer_message' : t.type === 'reply' ? 'agent_reply' : 'internal_note',
            from: t.author.name,
            at: iso(t.createdAt),
            delivery: t.type === 'reply' ? t.state : undefined,
            error: t.error || undefined,
            text: htmlToText(t.bodyHtml),
            attachments: t.attachments.length ? t.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size })) : undefined,
          },
    ),
    other_conversations_from_customer: c.previousConversations.map((p) => ({ id: p.id, subject: p.subject, status: p.status })),
  }
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })
const fail = (err: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true })
const safe =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args))
    } catch (err) {
      return fail(err)
    }
  }

const STATUS = z.enum(['active', 'waiting', 'pending', 'closed', 'spam'])

function buildServer(user: User, access: TokenAccess) {
  const actor: Actor = { userId: user.id, via: 'mcp', access }
  const server = new McpServer(
    { name: 'ansa', version: '1.0.0' },
    {
      instructions:
        `Ansa is a shared inbox for customer support. You act as ${user.name} (${user.email}). ` +
        'A conversation is one email thread with a customer. Its status is active (needs a reply), pending (waiting on the customer), closed or spam. ' +
        (access === 'internal'
          ? 'This token is internal only and cannot email customers or change settings. Add notes for the team instead. '
          : 'reply_to_conversation sends a real email to the customer, so draft carefully and confirm with the user before sending unless told otherwise. ') +
        'add_note is internal and safe: customers never see notes.',
    },
  )

  server.registerTool(
    'list_mailboxes',
    { title: 'List mailboxes', description: 'List the shared mailboxes with the count of conversations that need attention in each folder.', annotations: { readOnlyHint: true } },
    safe(() => {
      const counts = folderCounts(user.id)
      return all<any>('SELECT id, name, email FROM mailboxes ORDER BY name').map((m) => {
        const c = counts.find((x) => x.mailboxId === m.id)
        return { id: m.id, name: m.name, email: m.email, needs_attention: { unassigned: c?.unassigned ?? 0, mine: c?.mine ?? 0, assigned: c?.assigned ?? 0 } }
      })
    }),
  )

  server.registerTool(
    'list_conversations',
    {
      title: 'List or search conversations',
      description:
        'List conversations, newest activity first. Filter by mailbox, folder, status, assignee, tag or customer, or search the full text of subjects, messages and customer names with `query`. ' +
        'Folders: unassigned, mine, assigned, snoozed, closed, spam, open (active + pending), all.',
      inputSchema: {
        mailbox_id: z.number().int().optional(),
        folder: z.enum(['unassigned', 'mine', 'mentioned', 'assigned', 'pending', 'snoozed', 'closed', 'spam', 'open', 'all']).optional(),
        status: STATUS.optional(),
        assignee_id: z.number().int().optional().describe('Teammate id from list_team'),
        tag: z.string().optional(),
        customer_id: z.number().int().optional(),
        query: z.string().optional().describe('Full-text search. A number finds that conversation id.'),
        sort: z.enum(['recent', 'oldest', 'waiting']).optional().describe('waiting = longest-waiting customer first'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe((a) => {
      const result = listConversations({
        mailboxId: a.mailbox_id,
        folder: a.folder,
        status: a.status,
        assigneeId: a.assignee_id,
        tag: a.tag,
        customerId: a.customer_id,
        q: a.query,
        sort: a.sort,
        limit: a.limit ?? 25,
        offset: a.offset,
        me: user.id,
      })
      return { total: result.total, offset: result.offset, conversations: result.items.map(brief) }
    }),
  )

  server.registerTool(
    'get_conversation',
    {
      title: 'Read a conversation',
      description: 'Get one conversation with every customer message, agent reply and internal note as plain text, plus the customer profile.',
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe((a) => detail(a.id)),
  )

  if (access !== 'internal') {
    server.registerTool(
      'reply_to_conversation',
      {
        title: 'Send a reply to the customer',
        description:
          'Email a reply to the customer on an existing conversation. This sends real email. `body` is plain text (blank lines separate paragraphs) or simple HTML. ' +
          'The signature is added automatically. `status` is what the conversation becomes after sending (default closed; a customer reply reopens it).',
        inputSchema: {
          id: z.number().int(),
          body: z.string().min(1),
          status: z.enum(['active', 'waiting', 'pending', 'closed']).optional(),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
        },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      safe((a) => {
        addReply(a.id, { bodyHtml: toHtml(a.body), status: a.status, cc: a.cc, bcc: a.bcc }, actor)
        return { sent: true, conversation: brief(getConversation(a.id)) }
      }),
    )
  }

  server.registerTool(
    'add_note',
    {
      title: 'Add an internal note',
      description: 'Add a private note to a conversation for the team. The customer never sees it. Good for summaries, findings and suggested replies.',
      inputSchema: { id: z.number().int(), body: z.string().min(1) },
      annotations: { destructiveHint: false },
    },
    safe((a) => {
      addNote(a.id, { bodyHtml: toHtml(a.body) }, actor)
      return { saved: true, conversation: brief(getConversation(a.id)) }
    }),
  )

  server.registerTool(
    'update_conversation',
    {
      title: 'Update a conversation',
      description: 'Change status, assignee, tags or subject, or snooze a conversation. Only the fields you pass change.',
      inputSchema: {
        id: z.number().int(),
        status: STATUS.optional(),
        assignee_id: z.number().int().nullable().optional().describe('Teammate id, or null to unassign'),
        add_tags: z.array(z.string()).optional(),
        remove_tags: z.array(z.string()).optional(),
        subject: z.string().optional(),
        snooze_until: z.string().nullable().optional().describe('ISO 8601 time to bring it back, or null to cancel a snooze'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    safe((a) => {
      const snoozedUntil = a.snooze_until === undefined ? undefined : a.snooze_until === null ? null : Date.parse(a.snooze_until)
      if (typeof snoozedUntil === 'number' && Number.isNaN(snoozedUntil)) throw new Error('snooze_until must be an ISO 8601 date and time.')
      return brief(
        updateConversation(a.id, { status: a.status, assigneeId: a.assignee_id, addTags: a.add_tags, removeTags: a.remove_tags, subject: a.subject, snoozedUntil }, actor),
      )
    }),
  )

  server.registerTool(
    'create_conversation',
    {
      title: 'Start a conversation',
      description:
        'Create a conversation. kind "email" sends a new email to the customer. kind "customer_message" logs a message received from the customer by another channel. kind "note" logs an internal note (a call, a chat) without emailing anyone.',
      inputSchema: {
        mailbox_id: z.number().int(),
        customer_email: z.string(),
        customer_name: z.string().optional(),
        subject: z.string().min(1),
        body: z.string().min(1),
        kind: z.enum(['email', 'customer_message', 'note']),
        tags: z.array(z.string()).optional(),
        assignee_id: z.number().int().nullable().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    safe((a) => {
      const kind = a.kind === 'email' ? 'reply' : a.kind === 'customer_message' ? 'customer' : 'note'
      const created = createConversation(
        {
          mailboxId: a.mailbox_id,
          customerEmail: a.customer_email,
          customerName: a.customer_name,
          subject: a.subject,
          bodyHtml: toHtml(a.body),
          kind,
          tags: a.tags,
          assigneeId: a.assignee_id === undefined ? (kind === 'reply' ? user.id : null) : a.assignee_id,
        },
        actor,
      )
      return brief(getConversation(created.id))
    }),
  )

  server.registerTool(
    'list_customers',
    {
      title: 'Find customers',
      description: 'Search customers by name, email or company.',
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
      annotations: { readOnlyHint: true },
    },
    safe((a) => {
      const result = listCustomers({ q: a.query, limit: a.limit ?? 25, offset: a.offset })
      return {
        total: result.total,
        customers: result.items.map((c) => ({ id: c.id, name: c.name, email: c.email, company: c.company || undefined, conversations: c.conversationCount, last_seen: iso(c.lastSeenAt) })),
      }
    }),
  )

  server.registerTool(
    'get_customer',
    {
      title: 'Read a customer profile',
      description: 'Get a customer profile and their recent conversations.',
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe((a) => ({ ...getCustomer(a.id), createdAt: undefined, updatedAt: undefined, conversations: listConversations({ customerId: a.id, limit: 25 }).items.map(brief) })),
  )

  server.registerTool(
    'update_customer',
    {
      title: 'Update a customer profile',
      description: 'Edit profile fields on a customer. Only the fields you pass change.',
      inputSchema: {
        id: z.number().int(),
        name: z.string().optional(),
        company: z.string().optional(),
        title: z.string().optional(),
        phone: z.string().optional(),
        location: z.string().optional(),
        notes: z.string().optional().describe('Background notes shown beside every conversation with this customer'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    safe(({ id, ...patch }) => updateCustomer(id, patch)),
  )

  server.registerTool(
    'list_saved_replies',
    { title: 'List saved replies', description: 'Reusable reply templates the team has written. Use them as a starting point for replies.', annotations: { readOnlyHint: true } },
    safe(() => all<any>('SELECT id, name, body_html FROM saved_replies ORDER BY name').map((r) => ({ id: r.id, name: r.name, text: htmlToText(r.body_html) }))),
  )

  server.registerTool(
    'list_tags',
    { title: 'List tags', description: 'Every tag with how many conversations carry it.', annotations: { readOnlyHint: true } },
    safe(() => all('SELECT t.name, (SELECT COUNT(*) FROM conversation_tags ct WHERE ct.tag_id = t.id) AS conversations FROM tags t ORDER BY t.name')),
  )

  server.registerTool(
    'list_team',
    { title: 'List teammates', description: 'The people who can be assigned conversations.', annotations: { readOnlyHint: true } },
    safe(() => all<any>('SELECT id, name, email, role FROM users WHERE disabled = 0 ORDER BY name').map((u) => ({ ...u, is_me: u.id === user.id }))),
  )

  server.registerTool(
    'get_report',
    {
      title: 'Support report',
      description: 'Support metrics for the last N days: volume, replies, response and resolution times, busiest tags and per-teammate activity, with the previous period for comparison.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Default 30'), mailbox_id: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    safe((a) => {
      const to = Date.now()
      const report = buildReport({ from: to - (a.days ?? 30) * 86_400_000, to, mailboxId: a.mailbox_id })
      const minutes = (ms: number | null) => (ms === null ? null : Math.round(ms / 60_000))
      const shape = (t: typeof report.current) => ({
        new_conversations: t.newConversations,
        messages_received: t.messagesReceived,
        replies_sent: t.repliesSent,
        customers_helped: t.customersHelped,
        closed: t.closed,
        median_first_response_minutes: minutes(t.medianFirstResponseMs),
        median_resolution_minutes: minutes(t.medianResolutionMs),
      })
      return { period_days: a.days ?? 30, current: shape(report.current), previous_period: shape(report.previous), open_now: report.open, top_tags: report.tags.map((t) => ({ tag: t.name, conversations: t.count })), team: report.team }
    }),
  )

  return server
}

/** Stateless Streamable HTTP endpoint: one fresh server per request, authenticated by an API token. */
export async function handleMcp(request: Request, user: User, access: TokenAccess): Promise<Response> {
  const server = buildServer(user, access)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    if (request.method !== 'GET') setTimeout(() => void server.close().catch(() => {}), 1000)
  }
}
