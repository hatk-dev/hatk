/**
 * Lifecycle hooks that run in response to server events.
 *
 * Place hook modules in the `hooks/` directory. Currently supported hooks:
 *
 * - `on-login.ts` — called after each successful OAuth login
 * - `on-commit-*.ts` — called after records are indexed from the firehose
 *
 * Each hook default-exports the result of `defineHook()`.
 *
 * @example
 * ```ts
 * // hooks/on-login.ts
 * import { defineHook } from '$hatk'
 *
 * export default defineHook("on-login", async (ctx) => {
 *   await ctx.ensureRepo(ctx.did)
 * })
 * ```
 *
 * @example
 * ```ts
 * // hooks/on-commit-favorite.ts
 * import { defineHook } from '$hatk'
 *
 * export default defineHook("on-commit", { collections: ["social.grain.favorite"] },
 *   async ({ action, collection, record, repo, uri, db, lookup, push }) => {
 *     if (action !== "create") return
 *     // send push notification, etc.
 *   }
 * )
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
import { buildPushInterface, isPushEnabled, type PushInterface } from './push.ts'

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

/** Context passed to on-commit hooks after a record is indexed. */
export type OnCommitCtx = {
  /** Whether the record was created or deleted. */
  action: 'create' | 'delete'
  /** The collection NSID that matched. */
  collection: string
  /** The record value (null for deletes). */
  record: Record<string, any> | null
  /** DID of the committing actor. */
  repo: string
  /** AT URI of the record. */
  uri: string
  /** Database access (read and write). */
  db: {
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>
    run: (sql: string, params?: unknown[]) => Promise<void>
  }
  /** Typed record lookup (same as BaseContext). */
  lookup: BaseContext['lookup']
  /** Push notification delivery. */
  push: PushInterface
}

interface OnCommitHookEntry {
  collections: Set<string>
  handler: (ctx: OnCommitCtx) => Promise<void>
}

// Overloaded defineHook for both event types
export function defineHook(
  event: 'on-login',
  handler: (ctx: OnLoginCtx) => Promise<void>,
): { __type: 'hook'; event: 'on-login'; handler: (ctx: OnLoginCtx) => Promise<void> }
export function defineHook(
  event: 'on-commit',
  options: { collections: string[] },
  handler: (ctx: OnCommitCtx) => Promise<void>,
): { __type: 'hook'; event: 'on-commit'; collections: string[]; handler: (ctx: OnCommitCtx) => Promise<void> }
export function defineHook(event: string, ...args: any[]): any {
  if (event === 'on-login') {
    return { __type: 'hook' as const, event, handler: args[0] }
  }
  if (event === 'on-commit') {
    const options = args[0] as { collections: string[] }
    const handler = args[1] as (ctx: OnCommitCtx) => Promise<void>
    return { __type: 'hook' as const, event, collections: options.collections, handler }
  }
  throw new Error(`Unknown hook event: ${event}`)
}

type OnLoginHook = (ctx: OnLoginCtx) => Promise<void>

let onLoginHook: OnLoginHook | null = null
const onCommitHooks: OnCommitHookEntry[] = []

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
export function registerHook(event: string, handler: Function, options?: any): void {
  if (event === 'on-login') {
    onLoginHook = handler as OnLoginHook
    log('[hooks] on-login hook registered')
  } else if (event === 'on-commit') {
    const collections = new Set<string>(options?.collections || [])
    onCommitHooks.push({ collections, handler: handler as (ctx: OnCommitCtx) => Promise<void> })
    log(`[hooks] on-commit hook registered (collections: ${[...collections].join(', ')})`)
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

/**
 * Fire on-commit hooks for a batch of indexed records.
 * Runs async and non-blocking — errors are logged but never throw.
 */
export function fireOnCommitHooks(items: Array<{
  action: 'create' | 'delete'
  collection: string
  uri: string
  authorDid: string
  record: Record<string, any> | null
}>): void {
  if (onCommitHooks.length === 0) return

  const base = buildBaseContext(null)
  const push = isPushEnabled() ? buildPushInterface() : { send: async () => {} }

  for (const item of items) {
    for (const hook of onCommitHooks) {
      if (hook.collections.size > 0 && !hook.collections.has(item.collection)) continue
      hook.handler({
        action: item.action,
        collection: item.collection,
        record: item.record,
        repo: item.authorDid,
        uri: item.uri,
        db: { query: base.db.query, run: runSQL },
        lookup: base.lookup,
        push,
      }).catch((err: any) => {
        emit('hooks', 'on_commit_error', {
          collection: item.collection,
          uri: item.uri,
          error: err.message,
        })
      })
    }
  }
}
