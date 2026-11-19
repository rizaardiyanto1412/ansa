import path from 'node:path'
import { currentTenant } from './tenant.ts'

export interface Config {
  port: number
  host: string
  dataDir: string
  attachmentsDir: string
  dbPath: string
  /** Public URL of this install, used in links inside emails. No trailing slash. */
  appUrl: string
  /** True when APP_URL was set explicitly, so the platform must not guess it. */
  appUrlFixed: boolean
  /** Key material for encrypting saved mail passwords. The platform fills it in when APP_SECRET is not set. */
  secret: string
  /** Seconds between IMAP checks. */
  imapPollSeconds: number
  /** True where long-lived connections are not possible: connect, fetch new mail, disconnect. */
  imapPollOnly: boolean
  maxAttachmentBytes: number
  /** Set to "1" to disable all outgoing/incoming mail (used by the demo seed). */
  mailDisabled: boolean
  isProd: boolean
  hosted: boolean
  trustProxy: boolean
  appBlockedHostSuffix: string
}

/** Settings from one install's environment. Throws on settings no platform may run with; the platform completes `secret` and `appUrl`. */
export function readConfig(env: (name: string) => string | undefined): Config {
  const dataDir = path.resolve(env('DATA_DIR') || './data')
  const port = Number(env('PORT') || 3000)
  const configuredUrl = (env('APP_URL') || '').replace(/\/+$/, '')
  const secret = env('APP_SECRET') || ''
  const hosted = env('ANSA_HOSTED') === '1'
  if (hosted && secret) throw new Error('APP_SECRET is set in hosted mode. Remove it: every workspace must keep its own generated secret.')
  return {
    port,
    host: env('HOST') || '0.0.0.0',
    dataDir,
    attachmentsDir: path.join(dataDir, 'attachments'),
    dbPath: path.join(dataDir, 'ansa.db'),
    appUrl: configuredUrl || `http://localhost:${port}`,
    appUrlFixed: configuredUrl !== '' || hosted,
    secret: secret.length >= 16 ? secret : '',
    imapPollSeconds: Number(env('IMAP_POLL_SECONDS') || 60),
    imapPollOnly: false,
    maxAttachmentBytes: Number(env('MAX_ATTACHMENT_MB') || 25) * 1024 * 1024,
    mailDisabled: env('MAIL_DISABLED') === '1',
    isProd: env('NODE_ENV') === 'production',
    hosted,
    trustProxy: env('TRUST_PROXY') === '1',
    appBlockedHostSuffix: (env('APP_BLOCKED_HOST_SUFFIX') || '').trim().toLowerCase().replace(/^\*?\.+/, '').replace(/\.+$/, ''),
  }
}

/** The current tenant's settings. Read-only: a platform changes them on its own tenant. */
export const config: Readonly<Config> = new Proxy({} as Config, {
  get: (_, key) => currentTenant().config[key as keyof Config],
  set: () => false,
})
