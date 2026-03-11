import { resolve, relative } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { log } from './logger.ts'
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
} from './db.ts'
import { resolveRecords } from './hydrate.ts'
import { getLexicon } from './schema.ts'
import type { Row, FlatRow } from './lex-types.ts'

export type { Row, FlatRow }

export class InvalidRequestError extends Error {
  status = 400
  errorName?: string
  constructor(message: string, errorName?: string) {
    super(message)
    this.errorName = errorName
  }
}
export class NotFoundError extends InvalidRequestError {
  status = 404
  constructor(message = 'Not found') {
    super(message, 'NotFound')
  }
}

export interface XrpcContext<
  P = Record<string, string>,
  Records extends Record<string, any> = Record<string, any>,
  I = unknown,
> {
  db: {
    query: (sql: string, params?: any[]) => Promise<any[]>
    run: (sql: string, ...params: any[]) => Promise<void>
  }
  params: P
  input: I
  cursor?: string
  limit: number
  viewer: { did: string } | null
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
  lookup: <R = any>(collection: string, field: string, values: string[]) => Promise<Map<string, Row<R>>>
  count: (collection: string, field: string, values: string[]) => Promise<Map<string, number>>
  exists: (collection: string, filters: Record<string, string>) => Promise<boolean>
  labels: (uris: string[]) => Promise<Map<string, any[]>>
  blobUrl: (
    did: string,
    ref: unknown,
    preset?: 'avatar' | 'banner' | 'feed_thumbnail' | 'feed_fullsize',
  ) => string | undefined
}

interface XrpcHandler {
  name: string
  execute: (
    params: Record<string, string>,
    cursor: string | undefined,
    limit: number,
    viewer: { did: string } | null,
    input?: unknown,
  ) => Promise<any>
}

let _relayUrl = ''

export function configureRelay(relay: string) {
  _relayUrl = relay
}

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

const handlers = new Map<string, XrpcHandler>()

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

export async function initXrpc(xrpcDir: string): Promise<void> {
  const files = walkDir(xrpcDir)
  if (files.length === 0) return

  for (const scriptPath of files) {
    const rel = relative(xrpcDir, scriptPath).replace(/\.(ts|js)$/, '')
    const name = rel.replace(/[\\/]/g, '.')
    const mod = await import(scriptPath)
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

        const ctx: XrpcContext = {
          db: { query: querySQL, run: runSQL },
          params,
          input: input || {},
          cursor,
          limit,
          viewer,
          packCursor,
          unpackCursor,
          isTakendown: isTakendownDid,
          filterTakendownDids,
          search: searchRecords,
          resolve: resolveRecords as any,
          lookup: async (collection, field, values) => {
            if (values.length === 0) return new Map()
            const unique = [...new Set(values.filter(Boolean))]
            return lookupByFieldBatch(collection, field, unique) as any
          },
          count: async (collection, field, values) => {
            if (values.length === 0) return new Map()
            const unique = [...new Set(values.filter(Boolean))]
            return countByFieldBatch(collection, field, unique)
          },
          exists: async (collection, filters) => {
            const conditions = Object.entries(filters).map(([field, value]) => ({ field, value }))
            const uri = await findUriByFields(collection, conditions)
            return uri !== null
          },
          labels: queryLabelsForUris,
          blobUrl,
        }
        return handler.handler(ctx)
      },
    })
    log(`[xrpc] discovered: ${name}`)
  }
}

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
  return handler.execute(params, cursor, limit, viewer || null, input)
}

export function listXrpc(): string[] {
  return Array.from(handlers.keys())
}
