// Per-tenant workspaces for multi-tenant tests.
//
// Every tenant (identified by a user id) gets its own Workspace: a private
// RAMResource at /data, a DiskResource at /out rooted at vfs/tenants/<id>/,
// and its own PyodideRuntime (so its own WASM heap and Emscripten MEMFS).
// The virtual paths are the same for every tenant on purpose: isolation must
// come from the backing stores, not from tenants using different path names.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from '@struktoai/mirage-node'
import { createWorkspace, VFS_ROOT } from './workspace.ts'

export const TENANTS_ROOT = join(VFS_ROOT, 'tenants')

export interface Tenant {
  userId: string
  /** Host directory backing this tenant's /out mount. */
  root: string
  /** Private value seeded into /data/secret.txt; must never leak to another tenant. */
  secret: string
  ws: Workspace
}

export function tenantRoot(userId: string): string {
  return join(TENANTS_ROOT, userId)
}

export interface TenantOptions {
  /** Extra text files to create under /data, by file name. */
  seed?: Record<string, string>
}

/**
 * Build a fresh workspace for `userId`. The tenant's host output directory
 * is wiped first so nothing from an earlier run can satisfy an assertion.
 */
export async function createTenant(userId: string, options: TenantOptions = {}): Promise<Tenant> {
  const root = tenantRoot(userId)
  rmSync(root, { recursive: true, force: true })
  const secret = `SECRET-${userId}-${Math.random().toString(36).slice(2, 10)}`
  const ws = await createWorkspace({
    root,
    seed: { 'secret.txt': secret, ...(options.seed ?? {}) },
  })
  return { userId, root, secret, ws }
}

/** True when `name` exists in this tenant's host output directory. */
export function tenantFileExists(userId: string, name: string): boolean {
  return existsSync(join(tenantRoot(userId), name))
}

/** Read a file from this tenant's host output directory. */
export function readTenantFile(userId: string, name: string): string {
  return readFileSync(join(tenantRoot(userId), name), 'utf8')
}
