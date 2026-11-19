import { z } from 'zod'
import { config } from './config.ts'
import { getSetting, setSetting } from './db.ts'
import { currentTenant } from './tenant.ts'

export const PlanStateSchema = z.object({
  plan: z.enum(['trial', 'starter', 'team', 'business']),
  mailboxLimit: z.number().int().nonnegative().nullable(),
  readOnly: z.boolean(),
  hourlySendLimit: z.number().int().nonnegative(),
  trialEndsAt: z.number().int().positive().nullable().optional(),
})
export type PlanState = z.infer<typeof PlanStateSchema>

export const SmtpCredentialSchema = z.object({
  host: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['starttls', 'ssl']),
  user: z.string().max(200),
  pass: z.string().max(500),
})
export type SmtpCredential = z.infer<typeof SmtpCredentialSchema>

export const DnsRecordSchema = z.object({
  type: z.enum(['CNAME', 'TXT', 'MX']),
  host: z.string().min(1).max(500),
  value: z.string().min(1).max(2000),
})
export type DnsRecord = z.infer<typeof DnsRecordSchema>

export const DomainResultSchema = z.object({
  status: z.enum(['pending', 'verified', 'failed']),
  records: z.array(DnsRecordSchema).max(20),
})
export type DomainResult = z.infer<typeof DomainResultSchema>
export type SendingStatus = 'none' | DomainResult['status']

export const BillingLinksSchema = z.object({
  checkout: z.record(z.string().max(60), z.url({ protocol: /^https$/ })),
  portal: z.url({ protocol: /^https$/ }).nullable(),
})
export type BillingLinks = z.infer<typeof BillingLinksSchema>

export interface HostedState {
  workspaceId: string
  workspaceName: string
  appUrl: string
  adminUserId: number
  smtp: Omit<SmtpCredential, 'pass'> & { passEnc: string }
  planState: PlanState
}

export interface SystemEmail {
  to: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
}

export interface Health {
  schemaVersion: number
  coreVersion: string
  mailboxes: number
  users: number
}

export interface ControlPlane {
  createInboundAddress(workspaceId: string, mailboxId: number): Promise<{ address: string }>
  deleteInboundAddress(workspaceId: string, mailboxId: number): Promise<void>
  addSendingDomain(workspaceId: string, mailboxId: number, domain: string): Promise<DomainResult>
  checkSendingDomain(workspaceId: string, mailboxId: number): Promise<DomainResult>
  sendFallback(workspaceId: string, message: { mailboxId: number; raw: ArrayBuffer; from: string; to: string[] }): Promise<{ messageId: string }>
  sendSystemEmail(workspaceId: string, message: SystemEmail): Promise<void>
  billingLinks(workspaceId: string): Promise<BillingLinks>
  reportHealth(workspaceId: string, health: Health): Promise<void>
}

const KEY = 'hosted'

export const hostedState = (): HostedState | null => getSetting<HostedState | null>(KEY, null)
export const saveHostedState = (state: HostedState) => setSetting(KEY, state)

// A hosted workspace's public address comes from the control plane, never from a request.
export function loadHostedUrl() {
  const state = config.hosted ? hostedState() : null
  if (state) currentTenant().config.appUrl = state.appUrl
}

export type RpcErrorName = 'NotProvisioned' | 'PlanLimit' | 'RateLimited' | 'ReadOnly' | 'NotFound' | 'Invalid'
export const RPC_ERROR_STATUS: Record<RpcErrorName, number> = { NotProvisioned: 503, PlanLimit: 402, RateLimited: 429, ReadOnly: 403, NotFound: 404, Invalid: 400 }

// The control plane switches on `name`.
export const rpcError = (name: RpcErrorName, message: string) => Object.assign(new Error(message), { name })

export function parseRpc<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success) throw rpcError('Invalid', z.prettifyError(result.error))
  return result.data
}

export function controlPlane(): { control: ControlPlane; workspaceId: string; state: HostedState } {
  const { control } = currentTenant()
  const state = config.hosted ? hostedState() : null
  if (!control || !state) throw rpcError('NotProvisioned', 'This workspace is not provisioned yet.')
  return { control, workspaceId: state.workspaceId, state }
}

export const planState = (): PlanState | null => (config.hosted ? (hostedState()?.planState ?? null) : null)

export const READ_ONLY_REASON = 'This workspace is read-only, so replies are not sent. Choose a plan in Settings → Billing to send again.'

export function assertCanSend() {
  if (planState()?.readOnly) throw rpcError('ReadOnly', READ_ONLY_REASON)
}

const PLAN_NAMES: Record<PlanState['plan'], string> = { trial: 'trial', starter: 'Starter plan', team: 'Team plan', business: 'Business plan' }

export function assertMailboxAllowed(existing: number) {
  const plan = planState()
  if (!plan || plan.mailboxLimit === null || existing < plan.mailboxLimit) return
  const allowance = `${plan.mailboxLimit} ${plan.mailboxLimit === 1 ? 'mailbox' : 'mailboxes'}`
  throw rpcError('PlanLimit', `Your ${PLAN_NAMES[plan.plan]} includes ${allowance}, and this workspace has ${existing}. Upgrade in Settings → Billing to add another.`)
}
