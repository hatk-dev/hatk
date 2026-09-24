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
import { guardedQuerySQL, unfilteredQuerySQL } from './spaces/guard.ts'
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
import { createHmac } from 'node:crypto'
import type { OAuthConfig, CdnConfig } from './config.ts'
import { pdsCreateRecord, pdsPutRecord, pdsDeleteRecord, pdsApplyWrites, pdsXrpc } from './pds-proxy.ts'
import type { PdsXrpcOptions } from './pds-proxy.ts'
import { obtainSession, ObtainSessionError, type ObtainedSession } from './oauth/server.ts'

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
    unfiltered: (sql: string, params?: unknown[]) => Promise<unknown[]>
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
  deleteRecord: (collection: string, rkey: string) => Promise<void>
  applyWrites: (
    writes: Array<{
      $type: string
      collection: string
      rkey?: string
      value?: Record<string, unknown>
    }>,
  ) => Promise<{ results?: Array<{ $type: string; uri?: string; cid?: string }> }>
  /**
   * Call any XRPC method on the viewer's PDS with their session. The escape
   * hatch beside the record helpers above: nothing is validated or indexed, and
   * the granted scopes still apply. See {@link pdsXrpc}.
   */
  pds: (nsid: string, options?: PdsXrpcOptions) => Promise<Record<string, unknown>>
  /**
   * The record helpers and `pds` above, acting as another account this app
   * holds a session for — one it obtained with {@link obtainSession}, say.
   * Nothing here checks that the viewer may act for that account: that is the
   * app's decision, made before calling.
   */
  asAccount: (did: string) => AccountHelpers
  /**
   * Obtain a session for another account straight from its authorization
   * server, outside the redirect flow — a group host creating an account for
   * this app, for instance. POSTs `body` to `url` as this app's OAuth client,
   * with DPoP, and stores the session the response carries for its `sub`, so
   * {@link asAccount} works for it afterwards. See `obtainSession` in
   * `oauth/server.ts`.
   */
  obtainSession: (
    url: string,
    body: Record<string, unknown>,
    opts?: { headers?: Record<string, string> },
  ) => Promise<ObtainedSession>
}

/** The PDS helpers on {@link XrpcContext}, for one account. */
export type AccountHelpers = Pick<XrpcContext, 'createRecord' | 'putRecord' | 'deleteRecord' | 'applyWrites' | 'pds'>

/** Internal representation of a loaded XRPC handler module. */
interface XrpcHandler {
  name: string
  execute: (
    params: XrpcParams,
    cursor: string | undefined,
    limit: number,
    viewer: { did: string; handle?: string } | null,
    input?: unknown,
  ) => Promise<any>
}

let _relayUrl = ''
let _cdn: { url: string; key: Buffer; salt: Buffer } | null = null

/** Set the relay URL used for blob URL generation. Called once during boot. */
/** True when the relay is a loopback URL — a dev PDS rather than the network. */
export function isLocalRelay(): boolean {
  try {
    const host = new URL(_relayUrl).hostname
    return (
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

export function configureRelay(relay: string) {
  _relayUrl = relay
}

/** Set the CDN config for imgproxy URL signing. Called once during boot. */
export function configureCdn(cdn: CdnConfig | null) {
  if (cdn) {
    _cdn = {
      url: cdn.url.replace(/\/$/, ''),
      key: Buffer.from(cdn.key, 'hex'),
      salt: Buffer.from(cdn.salt, 'hex'),
    }
  } else {
    _cdn = null
  }
}

/** Sign an imgproxy path with HMAC-SHA256 (URL-safe base64). */
function signPath(path: string): string {
  const hmac = createHmac('sha256', _cdn!.key)
  hmac.update(_cdn!.salt)
  hmac.update(path)
  const sig = hmac.digest('base64url')
  return `/${sig}${path}`
}

/**
 * Generate a CDN URL for a blob ref. Uses the PDS directly in local dev,
 * a configured imgproxy CDN if available, or the Bluesky CDN as fallback.
 */
export function blobUrl(did: string, ref: unknown, preset: string = 'avatar'): string | undefined {
  if (!ref) return undefined
  const p = typeof ref === 'string' ? JSON.parse(ref) : ref
  if (!p?.ref?.$link) return undefined
  // A local network has no image CDN. Serve blobs through the dev proxy
  // (see /blob/ in server.ts), which fetches from each repo's own PDS — on a
  // multi-PDS dev stack the repos are not all behind the relay being tailed.
  if (isLocalRelay()) {
    return `/blob/${did}/${p.ref.$link}`
  }
  if (_cdn) {
    const path = `/${preset}/plain/${did}/${p.ref.$link}`
    return `${_cdn.url}${signPath(path)}`
  }
  return `https://cdn.bsky.app/img/${preset}/plain/${did}/${p.ref.$link}@jpeg`
}

/** Build a full XrpcContext from request parameters. Reuses buildBaseContext for shared fields. */
export function buildXrpcContext(
  params: XrpcParams,
  cursor: string | undefined,
  limit: number,
  viewer: { did: string; handle?: string } | null,
  input?: unknown,
): XrpcContext {
  const base = buildBaseContext(viewer)
  return {
    ...base,
    db: { query: guardedQuerySQL, run: runSQL, unfiltered: unfilteredQuerySQL },
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
    ...accountHelpers(viewer),
    asAccount: (did) => accountHelpers({ did }),
    obtainSession: async (url, body, opts) => {
      if (!_oauthConfig) throw new Error('No OAuth config — cannot obtain a session')
      try {
        return await obtainSession(_oauthConfig, url, body, opts)
      } catch (err) {
        if (err instanceof ObtainSessionError) throw new InvalidRequestError(err.message, err.error)
        throw err
      }
    },
  }
}

/**
 * The PDS helpers for one account, with the session this app holds for it: the
 * viewer's, or another account's through {@link XrpcContext.asAccount}.
 */
function accountHelpers(account: { did: string } | null): AccountHelpers {
  const ready = (what: string) => {
    if (!_oauthConfig) throw new Error(`No OAuth config — cannot ${what}`)
    if (!account) throw new Error(`Authentication required to ${what}`)
    return { config: _oauthConfig, account }
  }
  return {
    createRecord: async (collection, record, opts) => {
      const { config, account } = ready('write records')
      return pdsCreateRecord(config, account, { collection, record, rkey: opts?.rkey })
    },
    putRecord: async (collection, rkey, record) => {
      const { config, account } = ready('write records')
      return pdsPutRecord(config, account, { collection, rkey, record })
    },
    deleteRecord: async (collection, rkey) => {
      const { config, account } = ready('write records')
      await pdsDeleteRecord(config, account, { collection, rkey })
    },
    applyWrites: async (writes) => {
      const { config, account } = ready('write records')
      return pdsApplyWrites(config, account, { writes })
    },
    pds: async (nsid, options) => {
      const { config, account } = ready('call the PDS')
      return pdsXrpc(config, account, nsid, options)
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
        coerceParams(params, paramProperties, requiredParams)

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
      coerceParams(params, paramProperties, requiredParams)

      const ctx = buildXrpcContext(params, cursor, limit, viewer, input)
      return handlerModule.handler(ctx)
    },
  })
}

/**
 * What the query string gives a handler: one value per key, or every value
 * when the key was repeated (`?dids=a&dids=b`).
 */
export type XrpcParams = Record<string, any>

/** Collect a query string into params, keeping every value of a repeated key. */
export function paramsFromSearch(search: URLSearchParams): XrpcParams {
  const params: XrpcParams = {}
  for (const [key, value] of search) {
    const prior = params[key]
    if (prior === undefined) params[key] = value
    else if (Array.isArray(prior)) prior.push(value)
    else params[key] = [prior, value]
  }
  return params
}

function coerceScalar(value: unknown, def: any): unknown {
  // Only integers, as before: a boolean still reaches the handler as the
  // string it was sent as, and handlers written against that keep working.
  return def?.type === 'integer' ? Number(value) : value
}

/**
 * Apply the lexicon's parameter schema before a handler runs: defaults,
 * integer coercion, and arrays. A query string cannot say whether
 * `dids=x` is one string or a one-element list, so the schema decides: a
 * parameter declared `array` always reaches the handler as one, or a handler
 * that spreads it would spread the characters of a DID instead.
 */
export function coerceParams(params: XrpcParams, properties: Record<string, any>, required: string[]): void {
  for (const [key, def] of Object.entries(properties)) {
    if (params[key] == null && def.default != null) {
      params[key] = def.type === 'array' ? [...def.default] : def.type === 'string' ? String(def.default) : def.default
    }
    if (params[key] == null) continue
    if (def.type === 'array') {
      const list = Array.isArray(params[key]) ? params[key] : [params[key]]
      params[key] = list.map((v: unknown) => coerceScalar(v, def.items))
    } else if (Array.isArray(params[key])) {
      // A scalar given twice: the last one wins, as a form submission would.
      params[key] = coerceScalar(params[key][params[key].length - 1], def)
    } else {
      params[key] = coerceScalar(params[key], def)
    }
  }
  for (const param of required) {
    const v = params[param]
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) {
      throw new InvalidRequestError(`Missing required parameter: ${param}`, 'InvalidRequest')
    }
  }
}

/** Execute a registered XRPC handler by name. Returns null if no handler matches. */
export async function executeXrpc(
  name: string,
  params: XrpcParams,
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
  const stringParams: XrpcParams = {}
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue
    // A list stays a list, as the query string would have carried it.
    stringParams[k] = Array.isArray(v) ? v.map(String) : String(v)
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
    params: XrpcParams,
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
