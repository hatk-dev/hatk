/**
 * XRPC method handler system for serving AT Protocol endpoints.
 *
 * Place handler modules in the `xrpc/` directory, nested by NSID segments
 * (e.g. `xrpc/app/bsky/feed/getAuthorFeed.ts` → `app.bsky.feed.getAuthorFeed`).
 * Each module default-exports a `{ handler }` function that receives an
 * {@link XrpcContext} with database access, query params, pagination, and
 * viewer auth.
 *
 * @example
 * ```ts
 * // xrpc/xyz/statusphere/getStatuses.ts
 * import { defineXrpc } from '../../hatk.generated.ts'
 *
 * export default defineXrpc('xyz.statusphere.getStatuses', async (ctx) => {
 *   const rows = await ctx.db.query('SELECT * FROM statusphere_status LIMIT ?', [ctx.limit])
 *   return { statuses: rows }
 * })
 * ```
 */
import { resolve, relative } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { log, emit, timer } from './logger.ts'
import {
  querySQL,
  runSQL,
  packCursor,
  unpackCursor,
  isTakendownDid,
  filterTakendownDids,
  searchRecords,
  findUriByFields,
  lookupByFieldBatch,
  countByFieldBatch,
  queryLabelsForUris,
  getRecordsMap,
} from './database/db.ts'
import { resolveRecords, buildBaseContext } from './hydrate.ts'
import type { BaseContext } from './hydrate.ts'
import { getLexicon } from './database/schema.ts'
import type { Row, FlatRow } from './lex-types.ts'
import type { OAuthConfig } from './config.ts'
import { pdsCreateRecord, pdsPutRecord, pdsDeleteRecord, pdsApplyWrites } from './pds-proxy.ts'

export type { Row, FlatRow }

let _oauthConfig: OAuthConfig | null = null

/** Set the OAuth config used for record write helpers. Called once during boot. */
export function configureOAuth(config: OAuthConfig | null) {
  _oauthConfig = config
}

/** Thrown from XRPC handlers to return a 400 response with an error message. */
export class InvalidRequestError extends Error {
  status = 400
  errorName?: string
  constructor(message: string, errorName?: string) {
    super(message)
    this.errorName = errorName
  }
}
/** Thrown from XRPC handlers to return a 404 response. */
export class NotFoundError extends InvalidRequestError {
  status = 404
  constructor(message = 'Not found') {
    super(message, 'NotFound')
  }
}

/**
 * Context passed to every XRPC handler. Provides database access, pagination
 * helpers, viewer auth, record resolution, full-text search, label queries,
 * and blob URL generation.
 *
 * @typeParam P - Query parameter types (derived from lexicon)
 * @typeParam Records - Map of collection NSID → record type (from generated types)
 * @typeParam I - Input body type for procedure calls
 */
export interface XrpcContext<
  P = Record<string, string>,
  Records extends Record<string, any> = Record<string, any>,
  I = unknown,
> extends BaseContext {
  db: {
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>
    run: (sql: string, params?: unknown[]) => Promise<void>
  }
  params: P
  input: I
  cursor?: string
  limit: number
  packCursor: (primary: string | number, cid: string) => string
  unpackCursor: (cursor: string) => { primary: string; cid: string } | null
  isTakendown: (did: string) => Promise<boolean>
  filterTakendownDids: (dids: string[]) => Promise<Set<string>>
  search: <K extends string & keyof Records>(
    collection: K,
    q: string,
    opts?: { limit?: number; cursor?: string; fuzzy?: boolean },
  ) => Promise<{ records: Row<Records[K]>[]; cursor?: string }>
  resolve: <R = unknown>(uris: string[]) => Promise<Row<R>[]>
  exists: (collection: string, filters: Record<string, string>) => Promise<boolean>
  createRecord: (
    collection: string,
    record: Record<string, unknown>,
    opts?: { rkey?: string },
  ) => Promise<{ uri?: string; cid?: string }>
  putRecord: (
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ) => Promise<{ uri?: string; cid?: string }>
  deleteRecord: (
    collection: string,
    rkey: string,
  ) => Promise<void>
  applyWrites: (
    writes: Array<{
      $type: string
      collection: string
      rkey?: string
      value?: Record<string, unknown>
    }>,
  ) => Promise<{ results?: Array<{ $type: string; uri?: string; cid?: string }> }>
}

/** Internal representation of a loaded XRPC handler module. */
interface XrpcHandler {
  name: string
  execute: (
    params: Record<string, string>,
    cursor: string | undefined,
    limit: number,
    viewer: { did: string; handle?: string } | null,
    input?: unknown,
  ) => Promise<any>
}

let _relayUrl = ''

/** Set the relay URL used for blob URL generation. Called once during boot. */
export function configureRelay(relay: string) {
  _relayUrl = relay
}

/**
 * Generate a CDN URL for a blob ref. Uses the PDS directly in local dev,
 * or the Bluesky CDN (`cdn.bsky.app`) in production.
 */
export function blobUrl(
  did: string,
  ref: unknown,
  preset: 'avatar' | 'banner' | 'feed_thumbnail' | 'feed_fullsize' = 'avatar',
): string | undefined {
  if (!ref) return undefined
  const p = typeof ref === 'string' ? JSON.parse(ref) : ref
  if (!p?.ref?.$link) return undefined
  if (_relayUrl.includes('localhost:2583')) {
    return `http://localhost:2583/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${p.ref.$link}`
  }
  return `https://cdn.bsky.app/img/${preset}/plain/${did}/${p.ref.$link}@jpeg`
}

/** Build a full XrpcContext from request parameters. Reuses buildBaseContext for shared fields. */
export function buildXrpcContext(
  params: Record<string, string>,
  cursor: string | undefined,
  limit: number,
  viewer: { did: string; handle?: string } | null,
  input?: unknown,
): XrpcContext {
  const base = buildBaseContext(viewer)
  return {
    ...base,
    db: { query: querySQL, run: runSQL },
    params,
    input: input || {},
    cursor,
    limit,
    packCursor,
    unpackCursor,
    isTakendown: isTakendownDid,
    filterTakendownDids,
    search: searchRecords,
    resolve: resolveRecords as any,
    exists: async (collection, filters) => {
      const conditions = Object.entries(filters).map(([field, value]) => ({ field, value }))
      const uri = await findUriByFields(collection, conditions)
      return uri !== null
    },
    createRecord: async (collection, record, opts) => {
      if (!_oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
      if (!viewer) throw new Error('Authentication required to write records')
      return pdsCreateRecord(_oauthConfig, viewer, { collection, record, rkey: opts?.rkey })
    },
    putRecord: async (collection, rkey, record) => {
      if (!_oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
      if (!viewer) throw new Error('Authentication required to write records')
      return pdsPutRecord(_oauthConfig, viewer, { collection, rkey, record })
    },
    deleteRecord: async (collection, rkey) => {
      if (!_oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
      if (!viewer) throw new Error('Authentication required to write records')
      await pdsDeleteRecord(_oauthConfig, viewer, { collection, rkey })
    },
    applyWrites: async (writes) => {
      if (!_oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
      if (!viewer) throw new Error('Authentication required to write records')
      return pdsApplyWrites(_oauthConfig, viewer, { writes })
    },
  }
}

const handlers = new Map<string, XrpcHandler>()

/** Recursively collect .ts/.js files in a directory, skipping files prefixed with `_`. */
function walkDir(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry)
      if (statSync(full).isDirectory()) {
        results.push(...walkDir(full))
      } else if ((entry.endsWith('.ts') || entry.endsWith('.js')) && !entry.startsWith('_')) {
        results.push(full)
      }
    }
  } catch {}
  return results.sort()
}

/**
 * Discover and load XRPC handler modules from the `xrpc/` directory.
 * Directory nesting maps to NSID segments. Parameters are validated and
 * coerced against the matching lexicon definition.
 */
export async function initXrpc(xrpcDir: string): Promise<void> {
  const files = walkDir(xrpcDir)
  if (files.length === 0) return

  for (const scriptPath of files) {
    const rel = relative(xrpcDir, scriptPath).replace(/\.(ts|js)$/, '')
    const name = rel.replace(/[\\/]/g, '.')
    const mod = await import(/* @vite-ignore */ `${scriptPath}?t=${Date.now()}`)
    const handler = mod.default

    // Extract param schema from lexicon for validation and defaults
    const lexicon = getLexicon(name)
    const paramsDef = lexicon?.defs?.main?.parameters
    const requiredParams: string[] = paramsDef?.required || []
    const paramProperties: Record<string, any> = paramsDef?.properties || {}

    handlers.set(name, {
      name,
      execute: async (params, cursor, limit, viewer, input) => {
        // Apply defaults and coerce types from lexicon
        for (const [key, def] of Object.entries(paramProperties)) {
          if (params[key] == null && def.default != null) {
            params[key] = String(def.default)
          }
          if (params[key] != null && def.type === 'integer') {
            params[key] = Number(params[key]) as any
          }
        }
        for (const param of requiredParams) {
          if (!params[param]) {
            throw new InvalidRequestError(`Missing required parameter: ${param}`, 'InvalidRequest')
          }
        }

        const ctx = buildXrpcContext(params, cursor, limit, viewer, input)
        return handler.handler(ctx)
      },
    })
    log(`[xrpc] discovered: ${name}`)
  }
}

/** Register a single XRPC handler from a scanned server/ module. */
export function registerXrpcHandler(nsid: string, handlerModule: { handler: (ctx: any) => Promise<any> }): void {
  const lexicon = getLexicon(nsid)
  const paramsDef = lexicon?.defs?.main?.parameters
  const requiredParams: string[] = paramsDef?.required || []
  const paramProperties: Record<string, any> = paramsDef?.properties || {}

  handlers.set(nsid, {
    name: nsid,
    execute: async (params, cursor, limit, viewer, input) => {
      for (const [key, def] of Object.entries(paramProperties)) {
        if (params[key] == null && def.default != null) {
          params[key] = String(def.default)
        }
        if (params[key] != null && def.type === 'integer') {
          params[key] = Number(params[key]) as any
        }
      }
      for (const param of requiredParams) {
        if (!params[param]) {
          throw new InvalidRequestError(`Missing required parameter: ${param}`, 'InvalidRequest')
        }
      }

      const ctx = buildXrpcContext(params, cursor, limit, viewer, input)
      return handlerModule.handler(ctx)
    },
  })
}

/** Execute a registered XRPC handler by name. Returns null if no handler matches. */
export async function executeXrpc(
  name: string,
  params: Record<string, string>,
  cursor: string | undefined,
  limit: number,
  viewer?: { did: string } | null,
  input?: unknown,
): Promise<any | null> {
  const handler = handlers.get(name)
  if (!handler) return null
  const elapsed = timer()
  try {
    const result = await handler.execute(params, cursor, limit, viewer || null, input)
    emit('xrpc', name, { duration_ms: elapsed(), params, cursor, limit, viewer: viewer?.did })
    return result
  } catch (err: any) {
    emit('xrpc', name, { duration_ms: elapsed(), params, cursor, limit, viewer: viewer?.did, error: err.message })
    throw err
  }
}

/** Call a registered XRPC handler directly (no HTTP). For use in SSR renderers. */
export async function callXrpc(nsid: string, params: Record<string, any> = {}, input?: unknown): Promise<any> {
  const viewer = (globalThis as any).__hatk_viewer ?? null
  // In externalized module context (e.g. SSR), delegate to the runner's callXrpc via globalThis.
  // The runner's module instance has all registered handlers; this (Node's) instance may not.
  if (handlers.size === 0 && (globalThis as any).__hatk_callXrpc) {
    return (globalThis as any).__hatk_callXrpc(nsid, params, input)
  }
  const stringParams: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v != null) stringParams[k] = String(v)
  }
  const limit = params.limit ? Number(params.limit) : 20
  const cursor = params.cursor ?? undefined
  const result = await executeXrpc(nsid, stringParams, cursor, limit, viewer, input)
  if (result === null) throw new Error(`No XRPC handler registered for ${nsid}`)
  return result
}

/**
 * Register a core XRPC handler directly (no XrpcContext wrapping).
 * Used for built-in dev.hatk.* handlers that manage their own dependencies.
 */
export function registerCoreXrpcHandler(
  nsid: string,
  fn: (
    params: Record<string, string>,
    cursor: string | undefined,
    limit: number,
    viewer: { did: string; handle?: string } | null,
    input?: unknown,
  ) => Promise<any>,
): void {
  handlers.set(nsid, { name: nsid, execute: fn })
}

/** Return all registered XRPC method names. */
export function listXrpc(): string[] {
  return Array.from(handlers.keys())
}
