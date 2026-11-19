/**
 * Workspace-wide choices an admin makes in Settings → Workspace: branding and optional features.
 * Everything here is off or empty by default.
 */
import { getSetting, setSetting } from '../db.ts'
import { hostedState } from '../hosted.ts'

export interface WorkspaceSettings {
  /** Shown instead of "Ansa" in the app, on the sign-in page and in notification emails. Empty means Ansa. */
  brandName: string
  /** Storage key and type of the uploaded logo, or null for the built-in mark. */
  logo: { key: string; mime: string; version: number } | null
  /** Show the Mentioned folder under Mine. Mentions themselves (the @ picker and the email) always work. */
  mentions: boolean
  /** Four statuses: Active, Waiting on me, Waiting on customer, Closed. */
  fourStatuses: boolean
}

const DEFAULTS: WorkspaceSettings = { brandName: '', logo: null, mentions: false, fourStatuses: false }
const KEY = 'workspace'

export const getWorkspace = (): WorkspaceSettings => ({ ...DEFAULTS, ...getSetting<Partial<WorkspaceSettings>>(KEY, {}) })

export function saveWorkspace(patch: Partial<WorkspaceSettings>): WorkspaceSettings {
  const next = { ...getWorkspace(), ...patch }
  setSetting(KEY, next)
  return next
}

/** The product name to show to people. */
export const brandName = () => getWorkspace().brandName || 'Ansa'

/** What the web app needs. Safe to send before sign-in: the login page uses it. */
export function publicWorkspace() {
  const w = getWorkspace()
  return {
    name: hostedState()?.workspaceName ?? '',
    brandName: w.brandName,
    logoUrl: w.logo ? `/api/brand/logo?v=${w.logo.version}` : null,
    mentions: w.mentions,
    fourStatuses: w.fourStatuses,
  }
}

/** Status names for emails and other server-written text. */
export function statusLabel(status: string): string {
  const four = getWorkspace().fourStatuses
  const labels: Record<string, string> = four
    ? { active: 'Active', waiting: 'Waiting on me', pending: 'Waiting on customer', closed: 'Closed', spam: 'Spam' }
    : { active: 'Active', waiting: 'Active', pending: 'Pending', closed: 'Closed', spam: 'Spam' }
  return labels[status] ?? status
}
