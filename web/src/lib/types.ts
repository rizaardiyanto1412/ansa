export type Status = 'active' | 'waiting' | 'pending' | 'closed' | 'spam'
export type Folder = 'unassigned' | 'mine' | 'mentioned' | 'assigned' | 'pending' | 'snoozed' | 'closed' | 'spam' | 'all'

export interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'agent'
  color: string
  signature: string
  notifyAssigned: boolean
  notifyReplies: boolean
  notifyMentions: boolean
  disabled: boolean
  createdAt: number
}

export interface FolderCounts {
  unassigned: number
  mine: number
  assigned: number
  snoozed: number
  spam: number
  mentioned: number
}

export interface Mailbox {
  id: number
  name: string
  email: string
  fromName: string
  color: string
  imapEnabled: boolean
  smtpConfigured: boolean
  syncStatus: 'idle' | 'connecting' | 'ok' | 'error'
  syncError: string | null
  lastSyncAt: number | null
  counts: FolderCounts
  // Admin-only fields
  signature?: string
  smtpHost?: string
  smtpPort?: number
  smtpSecurity?: 'starttls' | 'ssl' | 'none'
  smtpUser?: string
  smtpPasswordSet?: boolean
  imapHost?: string
  imapPort?: number
  imapSecurity?: 'starttls' | 'ssl' | 'none'
  imapUser?: string
  imapPasswordSet?: boolean
  imapFolder?: string
  importExisting?: boolean
  autoReplyEnabled?: boolean
  autoReplyBody?: string
}

export interface Tag {
  id: number
  name: string
  color: string
  count?: number
}

export interface Customer {
  id: number
  name: string
  email: string
  emails: string[]
  company: string
  title: string
  phone: string
  location: string
  notes: string
  createdAt: number
  updatedAt: number
  conversationCount?: number
  lastSeenAt?: number | null
}

export interface ConversationSummary {
  id: number
  mailboxId: number
  mailboxName: string
  subject: string
  status: Status
  preview: string
  source: string
  customer: { id: number; name: string; email: string; company: string }
  assignee: { id: number; name: string; color: string } | null
  tags: Tag[]
  cc: string[]
  threadCount: number
  hasAttachments: boolean
  snoozedUntil: number | null
  waitingSince: number | null
  createdAt: number
  updatedAt: number
  lastCustomerAt: number | null
  lastAgentAt: number | null
  closedAt: number | null
}

export interface Attachment {
  id: number
  filename: string
  mime: string
  size: number
  inline?: boolean
  url: string
}

export type Author =
  | { kind: 'customer'; id: number; name: string; email: string }
  | { kind: 'user'; id: number; name: string; color: string }
  | { kind: 'system'; name: string }

export interface Thread {
  id: number
  type: 'customer' | 'reply' | 'note' | 'event'
  author: Author
  bodyHtml: string
  hasQuoted: boolean
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  state: 'sent' | 'sending' | 'failed' | 'scheduled'
  sendAt: number | null
  error: string | null
  event: Record<string, any> | null
  via: string
  createdAt: number
  attachments: Attachment[]
}

export interface Conversation extends Omit<ConversationSummary, 'customer'> {
  customer: Customer
  threads: Thread[]
  previousConversations: { id: number; subject: string; status: Status; updatedAt: number }[]
  /** Your own unsent text on this conversation: at most one reply and one note. */
  drafts: { kind: 'reply' | 'note'; bodyHtml: string; updatedAt: number }[]
  url: string
}

export interface Viewer {
  userId: number
  name: string
  color: string
  state: 'viewing' | 'replying'
}

export interface SavedReply {
  id: number
  name: string
  bodyHtml: string
  mailboxId: number | null
  updatedAt: number
}

export interface WorkflowCondition {
  field: 'subject' | 'body' | 'from' | 'to' | 'customer_name'
  op: 'contains' | 'not_contains' | 'is' | 'starts_with' | 'ends_with'
  value: string
}
export interface WorkflowAction {
  type: 'add_tag' | 'assign' | 'set_status' | 'add_note'
  value: string
}
export interface Workflow {
  id: number
  name: string
  mailboxId: number | null
  enabled: boolean
  trigger: 'new' | 'customer_reply' | 'any'
  match: 'all' | 'any'
  conditions: WorkflowCondition[]
  actions: WorkflowAction[]
  runCount: number
}

export interface ApiToken {
  access: 'full' | 'internal'
  id: number
  name: string
  prefix: string
  lastUsedAt: number | null
  createdAt: number
}

export interface ReportTotals {
  newConversations: number
  messagesReceived: number
  repliesSent: number
  customersHelped: number
  closed: number
  medianFirstResponseMs: number | null
  medianResolutionMs: number | null
  firstResponseBuckets: { label: string; count: number }[]
}

export interface Report {
  from: number
  to: number
  current: ReportTotals
  previous: ReportTotals
  days: { date: string; newConversations: number; repliesSent: number; closed: number }[]
  busiest: number[][]
  tags: { name: string; color: string; count: number }[]
  team: { id: number; name: string; color: string; replies: number; closed: number; customers: number }[]
  open: { active: number; pending: number; unassigned: number }
}
