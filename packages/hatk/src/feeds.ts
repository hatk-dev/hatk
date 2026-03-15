import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import { log } from './logger.ts'
import { querySQL, packCursor, unpackCursor, isTakendownDid, filterTakendownDids } from './database/db.ts'
import { resolveRecords, buildHydrateContext } from './hydrate.ts'
import type { HydrateContext, Row } from './hydrate.ts'
import type { Checked } from './lex-types.ts'

export type { HydrateContext, Row }

export interface FeedResult {
  uris: string[]
  cursor?: string
}

export interface PaginateOpts {
  params?: (string | number)[]
  orderBy?: string
  order?: 'ASC' | 'DESC'
}

export interface PaginateResult<T> {
  rows: T[]
  cursor: string | undefined
}

export interface FeedContext {
  db: { query: (sql: string, params?: any[]) => Promise<any[]> }
  params: Record<string, string>
  cursor?: string
  limit: number
  viewer: { did: string } | null
  packCursor: (primary: string | number, cid: string) => string
  unpackCursor: (cursor: string) => { primary: string; cid: string } | null
  isTakendown: (did: string) => Promise<boolean>
  filterTakendownDids: (dids: string[]) => Promise<Set<string>>
  paginate: <T extends { uri: string }>(sql: string, opts?: PaginateOpts) => Promise<PaginateResult<T>>
}

interface FeedHandler {
  name: string
  label: string
  collection?: string
  view?: string
  generate: (
    params: Record<string, string>,
    cursor: string | undefined,
    limit: number,
    viewer: { did: string } | null,
  ) => Promise<FeedResult>
  hydrate?: (ctx: HydrateContext) => Promise<unknown[]>
}

// --- Typed feed helper ---

type FeedGenerate = (
  ctx: FeedContext & { ok: (value: FeedResult) => Checked<FeedResult> },
) => Promise<Checked<FeedResult>>

type FeedOpts =
  | {
      collection: string
      view?: string
      label: string
      generate: FeedGenerate
      hydrate?: (ctx: HydrateContext<any>) => Promise<unknown[]>
    }
  | {
      collection?: never
      view?: never
      label: string
      generate: FeedGenerate
      hydrate: (ctx: HydrateContext<any>) => Promise<unknown[]>
    }

export function createPaginate(deps: {
  db: { query: (sql: string, params?: any[]) => Promise<any[]> }
  cursor?: string
  limit: number
  packCursor: (primary: string | number, cid: string) => string
  unpackCursor: (cursor: string) => { primary: string; cid: string } | null
}) {
  return async <T extends { uri: string }>(sql: string, opts?: PaginateOpts): Promise<PaginateResult<T>> => {
    const { db, cursor, limit, packCursor: pack, unpackCursor: unpack } = deps
    const userParams = opts?.params ?? []
    const orderBy = opts?.orderBy ?? 'indexed_at'
    const order = opts?.order ?? 'DESC'

    // Derive table prefix and bare column names from qualified orderBy (e.g. "p.played_time" → "p.")
    const dotIdx = orderBy.lastIndexOf('.')
    const prefix = dotIdx >= 0 ? orderBy.substring(0, dotIdx + 1) : ''
    const cidCol = prefix + 'cid'
    const orderByCol = dotIdx >= 0 ? orderBy.substring(dotIdx + 1) : orderBy
    const op = order === 'ASC' ? '>' : '<'

    let paramIdx = userParams.length + 1
    const sqlParams = [...userParams]

    // Build cursor condition
    let cursorCondition = ''
    if (cursor) {
      const parsed = unpack(cursor)
      if (parsed) {
        cursorCondition = `(${orderBy} ${op} $${paramIdx} OR (${orderBy} = $${paramIdx + 1} AND ${cidCol} ${op} $${paramIdx + 2}))`
        sqlParams.push(parsed.primary, parsed.primary, parsed.cid)
        paramIdx += 3
      }
    }

    // Detect existing WHERE and append cursor condition
    let fullSql = sql
    if (cursorCondition) {
      if (/\bWHERE\b/i.test(sql)) {
        fullSql += ` AND ${cursorCondition}`
      } else {
        fullSql += ` WHERE ${cursorCondition}`
      }
    }

    fullSql += ` ORDER BY ${orderBy} ${order}, ${cidCol} ${order} LIMIT $${paramIdx}`
    sqlParams.push(limit + 1)

    const rows = (await db.query(fullSql, sqlParams)) as T[]

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()
    const last = rows[rows.length - 1] as any

    return {
      rows,
      cursor: hasMore && last ? pack(last[orderByCol], last.cid) : undefined,
    }
  }
}

export function defineFeed(opts: FeedOpts) {
  return { __type: 'feed' as const, ...opts, generate: (ctx: any) => opts.generate({ ...ctx, ok: (v: any) => v }) }
}

/** Register a single feed from a scanned server/ module. */
export function registerFeed(name: string, generator: ReturnType<typeof defineFeed>): void {
  const handler: FeedHandler = {
    name,
    label: generator.label || name,
    collection: generator.collection,
    view: generator.view,
    generate: async (params, cursor, limit, viewer) => {
      const paginateDeps = {
        db: { query: querySQL },
        cursor,
        limit,
        packCursor,
        unpackCursor,
      }
      const ctx: FeedContext = {
        db: { query: querySQL },
        params,
        cursor,
        limit,
        viewer,
        packCursor,
        unpackCursor,
        isTakendown: isTakendownDid,
        filterTakendownDids,
        paginate: createPaginate(paginateDeps),
      }
      const result = await generator.generate(ctx)
      if (Array.isArray(result)) {
        return { uris: result.map((r: any) => r.uri || r) }
      }
      return { uris: result.uris, cursor: result.cursor }
    },
  }

  if (typeof generator.hydrate === 'function') {
    handler.hydrate = generator.hydrate
  }

  feeds.set(name, handler)
}

const feeds = new Map<string, FeedHandler>()

export async function initFeeds(feedsDir: string): Promise<void> {
  let files: string[]
  try {
    files = readdirSync(feedsDir)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('_'))
      .sort()
  } catch {
    return
  }

  for (const file of files) {
    const name = file.replace(/\.(ts|js)$/, '')
    const scriptPath = resolve(feedsDir, file)
    const mod = await import(/* @vite-ignore */ `${scriptPath}?t=${Date.now()}`)
    const generator = mod.default

    const handler: FeedHandler = {
      name,
      label: generator.label || name,
      collection: generator.collection,
      view: generator.view,
      generate: async (params, cursor, limit, viewer) => {
        const paginateDeps = {
          db: { query: querySQL },
          cursor,
          limit,
          packCursor,
          unpackCursor,
        }
        const ctx: FeedContext = {
          db: { query: querySQL },
          params,
          cursor,
          limit,
          viewer,
          packCursor,
          unpackCursor,
          isTakendown: isTakendownDid,
          filterTakendownDids,
          paginate: createPaginate(paginateDeps),
        }
        const result = await generator.generate(ctx)

        if (Array.isArray(result)) {
          return { uris: result.map((r: any) => r.uri || r) }
        }
        return {
          uris: result.uris,
          cursor: result.cursor,
        }
      },
    }

    if (typeof generator.hydrate === 'function') {
      handler.hydrate = generator.hydrate
      log(`[feeds] discovered: ${name} (with hydrate)`)
    } else {
      log(`[feeds] discovered: ${name}`)
    }

    feeds.set(name, handler)
  }
}

/** Execute a feed and run its hydrate pipeline if present. */
export async function executeFeed(
  name: string,
  params: Record<string, string>,
  cursor: string | undefined,
  limit: number,
  viewer?: { did: string } | null,
): Promise<{ items?: unknown[]; uris?: string[]; cursor?: string } | null> {
  const handler = feeds.get(name)
  if (!handler) return null

  const result = await handler.generate(params, cursor, limit, viewer || null)

  if (handler.hydrate) {
    const items = await resolveRecords(result.uris)
    const ctx = buildHydrateContext(items, viewer || null)
    const hydrated = await handler.hydrate(ctx)
    return { items: hydrated, cursor: result.cursor }
  }

  return { uris: result.uris, cursor: result.cursor }
}

export function listFeeds(): { name: string; label: string }[] {
  return Array.from(feeds.values()).map((f) => ({ name: f.name, label: f.label }))
}

export function feedHasHydrate(name: string): boolean {
  return feeds.get(name)?.hydrate != null
}
