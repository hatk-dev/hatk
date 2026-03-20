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
  blobUrl: (
    did: string,
    ref: unknown,
    preset?: 'avatar' | 'banner' | 'feed_thumbnail' | 'feed_fullsize',
  ) => string | undefined
}

// --- Record Resolution ---

/** Fetch records for URIs, reshape them, and filter out taken-down DIDs. */
export async function resolveRecords(uris: string[]): Promise<Row<unknown>[]> {
  if (uris.length === 0) return []

  // Group URIs by collection for batch fetching
  const byCollection = new Map<string, string[]>()
  for (const uri of uris) {
    const parts = uri.replace('at://', '').split('/')
    const col = parts[1]
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
  }
}
