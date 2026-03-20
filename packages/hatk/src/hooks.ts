/**
 * Lifecycle hooks that run in response to server events.
 *
 * Place hook modules in the `hooks/` directory. Currently supported hooks:
 *
 * - `on-login.ts` — called after each successful OAuth login
 *
 * Each hook default-exports an async function that receives an event-specific
 * context object.
 *
 * @example
 * ```ts
 * // hooks/on-login.ts
 * import type { OnLoginCtx } from '@hatk/hatk/hooks'
 *
 * export default async function (ctx: OnLoginCtx) {
 *   // Ensure the user's repo is backfilled on first login
 *   await ctx.ensureRepo(ctx.did)
 * }
 * ```
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { OAuthConfig } from './config.ts'
import { pdsCreateRecord, pdsPutRecord, pdsDeleteRecord } from './pds-proxy.ts'
import { log, emit } from './logger.ts'
import { setRepoStatus, runSQL } from './database/db.ts'
import { triggerAutoBackfill, awaitBackfill } from './indexer.ts'
import { buildBaseContext, type BaseContext } from './hydrate.ts'

/** Context passed to the on-login hook after a successful OAuth login. */
export type OnLoginCtx = Omit<BaseContext, 'db'> & {
  /** DID of the user who just logged in. */
  did: string
  /** Database access with both read and write. */
  db: {
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>
    run: (sql: string, params?: unknown[]) => Promise<void>
  }
  /** Trigger a backfill for a DID and wait for it to complete. */
  ensureRepo: (did: string) => Promise<void>
  /** Write a record to the user's PDS and index locally. */
  createRecord: (
    collection: string,
    record: Record<string, unknown>,
    opts?: { rkey?: string },
  ) => Promise<{ uri?: string; cid?: string }>
  /** Create or update a record on the user's PDS and index locally. */
  putRecord: (
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ) => Promise<{ uri?: string; cid?: string }>
  /** Delete a record from the user's PDS and local index. */
  deleteRecord: (
    collection: string,
    rkey: string,
  ) => Promise<void>
}

export function defineHook(event: 'on-login', handler: (ctx: OnLoginCtx) => Promise<void>) {
  return { __type: 'hook' as const, event, handler }
}

type OnLoginHook = (ctx: OnLoginCtx) => Promise<void>

let onLoginHook: OnLoginHook | null = null

/**
 * Discover and load the on-login hook from the project's `hooks/` directory.
 * Looks for `on-login.ts` or `on-login.js`. Safe to call if no hook exists.
 */
export async function loadOnLoginHook(hooksDir: string): Promise<void> {
  const tsPath = resolve(hooksDir, 'on-login.ts')
  const jsPath = resolve(hooksDir, 'on-login.js')
  const path = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null
  if (!path) return
  const mod = await import(/* @vite-ignore */ `${path}?t=${Date.now()}`)
  onLoginHook = mod.default
  log('[hooks] on-login hook loaded')
}

/** Mark a DID as pending, trigger auto-backfill, and wait for completion. */
async function ensureRepo(did: string): Promise<void> {
  await setRepoStatus(did, 'pending')
  triggerAutoBackfill(did)
  await awaitBackfill(did)
}

/** Register a hook from a scanned server/ module. */
export function registerHook(event: string, handler: Function): void {
  if (event === 'on-login') {
    onLoginHook = handler as OnLoginHook
    log('[hooks] on-login hook registered')
  }
}

/** Fire the on-login hook if loaded. Errors are logged but never block login. */
export async function fireOnLoginHook(did: string, oauthConfig: OAuthConfig | null): Promise<void> {
  if (!onLoginHook) return
  try {
    const base = buildBaseContext({ did })
    const viewer = { did }
    const hookPromise = onLoginHook({
      ...base,
      did,
      db: { query: base.db.query, run: runSQL },
      ensureRepo,
      createRecord: async (collection, record, opts) => {
        if (!oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
        return pdsCreateRecord(oauthConfig, viewer, { collection, record, rkey: opts?.rkey })
      },
      putRecord: async (collection, rkey, record) => {
        if (!oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
        return pdsPutRecord(oauthConfig, viewer, { collection, rkey, record })
      },
      deleteRecord: async (collection, rkey) => {
        if (!oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
        await pdsDeleteRecord(oauthConfig, viewer, { collection, rkey })
      },
    })
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('on-login hook timed out after 30s')), 30_000)
    )
    await Promise.race([hookPromise, timeout])
  } catch (err: any) {
    emit('hooks', 'on_login_error', { did, error: err.message })
  }
}
