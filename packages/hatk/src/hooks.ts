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
import { log } from './logger.ts'
import { setRepoStatus } from './database/db.ts'
import { triggerAutoBackfill } from './indexer.ts'

/** Context passed to the on-login hook after a successful OAuth login. */
export type OnLoginCtx = {
  /** DID of the user who just logged in. */
  did: string
  /** Trigger a backfill for a DID if it hasn't been indexed yet. */
  ensureRepo: (did: string) => Promise<void>
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
  const mod = await import(path)
  onLoginHook = mod.default
  log('[hooks] on-login hook loaded')
}

/** Mark a DID as pending and trigger auto-backfill. */
async function ensureRepo(did: string): Promise<void> {
  await setRepoStatus(did, 'pending')
  triggerAutoBackfill(did)
}

/** Register a hook from a scanned server/ module. */
export function registerHook(event: string, handler: Function): void {
  if (event === 'on-login') {
    onLoginHook = handler as OnLoginHook
    log('[hooks] on-login hook registered')
  }
}

/** Fire the on-login hook if loaded. Errors are logged but never block login. */
export async function fireOnLoginHook(did: string): Promise<void> {
  if (!onLoginHook) return
  try {
    await onLoginHook({ did, ensureRepo })
  } catch (err: any) {
    console.error('[hooks] onLogin hook error:', err.message)
  }
}
