/**
 * Node.js platform: one install per process, so its tenant is the fallback for the whole process.
 * Import this module first, before anything that touches the database.
 */
import { readConfig } from './config.ts'
import { installFallbackTenant } from './tenant.ts'
import { openNodeTenant } from './tenant-node.ts'

installFallbackTenant(openNodeTenant(readConfig((name) => process.env[name])))
