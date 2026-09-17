import {
  getRecordsMap,
  countByFieldBatch,
  lookupByFieldBatch,
  querySQL,
  queryLabelsForUris,
  filterTakendownDids,
  getRecordsByUris,
  reshapeRow,
} from './database/db.ts'
import { blobUrl } from './xrpc.ts'
import { collectionFromRecordUri } from './spaces/uri.ts'
import { spaceFilterSql } from './spaces/visibility.ts'
import type { Row } from './lex-types.ts'

export type { Row }

// --- Types ---

export interface BaseContext {
  viewer: { did: string; handle?: string } | null
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }
  getRecords: <R = unknown>(collection: string, uris: string[]) => Promise<Map<string, Row<R>>>
  lookup: <R = unknown>(collection: string, field: string, values: string[]) => Promise<Map<string, Row<R>>>
  count: (collection: string, field: string, values: string[]) => Promise<Map<string, number>>
  labels: (uris: string[]) => Promise<Map<string, unknown[]>>
  blobUrl: (did: string, ref: unknown, preset?: string) => string | undefined
  /**
   * The permissioned-space gate, for hand-written SQL.
   *
   * Every helper on this context applies it already. Raw SQL through
   * `ctx.db.query` cannot — nothing can inject a predicate into a string
   * somebody else wrote — so a query that selects from a collection a space
   * writes into has to apply it itself:
   *
   * ```ts
   * const gate = ctx.spaceFilter('t', 2)
   * ctx.db.query(
   *   `SELECT t.* FROM "app.example.post" t WHERE t.did = $1 AND ${gate.sql}`,
   *   ['did:plc:someone', ...gate.params],
   * )
   * ```
   *
   * Outside a viewer's scope this is `t.space IS NULL` and binds nothing, so on
   * an instance that indexes no space it costs one predicate on an indexed
   * column and changes no result.
   */
  spaceFilter: (alias: string, startIdx: number) => { sql: string; params: string[]; nextIdx: number }
}

// --- Record Resolution ---

/** Fetch records for URIs, reshape them, and filter out taken-down DIDs. */
export async function resolveRecords(uris: string[]): Promise<Row<unknown>[]> {
  if (uris.length === 0) return []

  // Group URIs by collection for batch fetching. A space record's collection
  // sits in a different segment than a repo record's, so the position is read
  // by a parser that knows both shapes rather than inline.
  const byCollection = new Map<string, string[]>()
  for (const uri of uris) {
    const col = collectionFromRecordUri(uri)
    if (!col) continue
    if (!byCollection.has(col)) byCollection.set(col, [])
    byCollection.get(col)!.push(uri)
  }

  const primaryRecords = new Map<string, any>()
  for (const [col, colUris] of byCollection) {
    const records = await getRecordsByUris(col, colUris)
    for (const r of records) {
      primaryRecords.set(r.uri, r)
    }
  }

  // Filter out records from taken-down DIDs
  const allDids = [...new Set([...primaryRecords.values()].map((r) => r.did).filter(Boolean))]
  const takendownDids = await filterTakendownDids(allDids)
  if (takendownDids.size > 0) {
    for (const [uri, rec] of primaryRecords) {
      if (takendownDids.has(rec.did)) primaryRecords.delete(uri)
    }
  }

  // Return in original URI order, reshaped
  return uris
    .map((uri) => {
      const row = primaryRecords.get(uri)
      return reshapeRow(row, row?.__childData, row?.__unionData)
    })
    .filter((r): r is Row<unknown> => r != null)
}

// --- Context Builder ---

/** Build a BaseContext for hydration. */
export function buildBaseContext(viewer: { did: string; handle?: string } | null): BaseContext {
  return {
    viewer,
    db: { query: querySQL },
    getRecords: getRecordsMap,
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
    labels: queryLabelsForUris,
    blobUrl,
    spaceFilter: spaceFilterSql,
  }
}
