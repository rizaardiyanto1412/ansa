import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }
import { get, run, tx, now, schemaVersion } from '../db.ts'
import { config } from '../config.ts'
import { encrypt } from '../crypto.ts'
import { USER_COLORS } from '../auth.ts'
import { publish } from '../events.ts'
import { hostedState, parseRpc as parse, PlanStateSchema, rpcError, saveHostedState, SmtpCredentialSchema, type Health, type HostedState, type PlanState, type SmtpCredential } from '../hosted.ts'
import { currentTenant } from '../tenant.ts'
import { releaseThrottled } from '../mail/outbound.ts'
import { issueLink } from './accounts.ts'
import { isEmail, normEmail } from './customers.ts'

export const CORE_VERSION: string = pkg.version

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const ProvisionSchema = z.object({
  workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  workspaceName: z.string().trim().min(1).max(100),
  appUrl: z
    .string()
    .max(500)
    .transform((value, ctx) => {
      const url = /^https?:\/\/[^/?#@]+\/?$/.test(value) ? safeUrl(value) : null
      if (url) return url.origin
      ctx.addIssue({ code: 'custom', message: 'appUrl must be an origin like https://acme.example.com' })
      return z.NEVER
    }),
  admin: z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().max(254).refine(isEmail, 'admin.email must be an email address').transform(normEmail),
  }),
  smtp: SmtpCredentialSchema,
  planState: PlanStateSchema,
})
export type ProvisionInput = z.input<typeof ProvisionSchema>

const sealSmtp = ({ pass, ...rest }: SmtpCredential): HostedState['smtp'] => ({ ...rest, passEnc: encrypt(pass) })

function provisioned(): HostedState {
  const state = hostedState()
  if (!state) throw rpcError('NotProvisioned', 'This workspace is not provisioned yet.')
  return state
}

export function provision(input: ProvisionInput): { signInUrl: string } {
  if (!config.hosted) throw rpcError('Invalid', 'This install is not in hosted mode.')
  const data = parse(ProvisionSchema, input)
  const existing = hostedState()
  if (existing) {
    if (existing.workspaceId !== data.workspaceId) throw rpcError('Invalid', 'This object already holds another workspace.')
    if (!get('SELECT 1 FROM users WHERE id = ? AND disabled = 0', existing.adminUserId)) throw rpcError('NotFound', 'The first admin of this workspace is no longer active.')
    return { signInUrl: issueLink(existing.adminUserId, 'sign_in') }
  }
  tx(() => {
    const adminUserId = run(`INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?, ?, '', 'admin', ?, ?)`, data.admin.name, data.admin.email, USER_COLORS[0], now()).id
    saveHostedState({ workspaceId: data.workspaceId, workspaceName: data.workspaceName, appUrl: data.appUrl, adminUserId, smtp: sealSmtp(data.smtp), planState: data.planState })
  })
  const tenant = currentTenant()
  tenant.config.appUrl = data.appUrl
  tenant.workspaceId = data.workspaceId
  return { signInUrl: issueLink(provisioned().adminUserId, 'sign_in') }
}

export function setPlan(input: PlanState): void {
  const state = provisioned()
  saveHostedState({ ...state, planState: parse(PlanStateSchema, input) })
  publish({ type: 'refresh', scope: 'workspace' })
  releaseThrottled()
  currentTenant().deadlineChanged()
}

export function setWorkspaceName(input: string): void {
  const state = provisioned()
  const workspaceName = parse(ProvisionSchema.shape.workspaceName, input)
  if (state.workspaceName === workspaceName) return
  saveHostedState({ ...state, workspaceName })
  publish({ type: 'refresh', scope: 'workspace' })
}

export function setSmtp(input: SmtpCredential): void {
  const state = provisioned()
  saveHostedState({ ...state, smtp: sealSmtp(parse(SmtpCredentialSchema, input)) })
}

export function health(): Health {
  const count = (sql: string) => get<{ n: number }>(sql)!.n
  return {
    schemaVersion: schemaVersion(),
    coreVersion: CORE_VERSION,
    mailboxes: count('SELECT COUNT(*) AS n FROM mailboxes'),
    users: count('SELECT COUNT(*) AS n FROM users WHERE disabled = 0'),
  }
}
