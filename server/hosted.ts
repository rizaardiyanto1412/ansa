import { z } from 'zod'
import { config } from './config.ts'
import { getSetting, setSetting } from './db.ts'
import { currentTenant } from './tenant.ts'

export const PlanStateSchema = z.object({
  plan: z.enum(['trial', 'starter', 'team', 'business']),
  mailboxLimit: z.number().int().nonnegative().nullable(),
  readOnly: z.boolean(),
  hourlySendLimit: z.number().int().nonnegative(),
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

// Only the calls this install makes. The control plane offers more.
export interface ControlPlane {
  sendSystemEmail(workspaceId: string, message: SystemEmail): Promise<void>
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

// The control plane switches on `name`.
export const rpcError = (name: RpcErrorName, message: string) => Object.assign(new Error(message), { name })
