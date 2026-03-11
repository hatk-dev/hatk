// views.ts — View registry: discovers view defs from lexicons, builds hydration pipelines.
// Supports two patterns:
//   1. Inline views: defined in the record lexicon with ref: "#main" (e.g., playView)
//   2. Defs views: defined in a defs lexicon, associated by naming convention (e.g., profileView)

import { log } from './logger.ts'
import { getAllLexicons, getLexicon } from './schema.ts'
import { blobUrl } from './xrpc.ts'
import type { Row, FlatRow } from './lex-types.ts'

// --- Types ---

interface ViewFieldRef {
  kind: 'ref'
  fieldName: string
  collection: string // resolved NSID (e.g., "app.bsky.actor.profile")
  joinField: string // "did" for literal:self records, "uri" otherwise
  blobFields: Map<string, string> // fieldName → CDN preset
}

interface ViewFieldScalar {
  kind: 'scalar'
  fieldName: string
  type: string // "string", "integer", "boolean"
  format?: string // "at-uri", "datetime", etc.
}

interface ViewFieldLabels {
  kind: 'labels'
  fieldName: string
}

type ViewField = ViewFieldRef | ViewFieldScalar | ViewFieldLabels

export interface ViewDef {
  /** Full NSID key (e.g., "fm.teal.alpha.feed.play#playView") */
  nsid: string
  /** The record collection this view hydrates */
  collection: string
  /** The def name (e.g., "playView") */
  name: string
  /** The record field name, or null for flattened views (bsky pattern) */
  recordField: string | null
  /** Blob fields on the record itself — for flattened views */
  blobFields: Map<string, string>
  /** All other fields and their hydration instructions */
  fields: ViewField[]
}

// --- Registry ---

/** All views keyed by full NSID (e.g., "fm.teal.alpha.feed.play#playView") */
const views = new Map<string, ViewDef>()

/** Reverse index: collection → default view NSID (the {name}View variant) */
const collectionDefaults = new Map<string, string>()

/** Get a view def by full NSID. */
export function getViewDef(nsid: string): ViewDef | undefined {
  return views.get(nsid)
}

/** Get the default view def for a collection (used by feed auto-hydration). */
export function getDefaultView(collection: string): ViewDef | undefined {
  const viewNsid = collectionDefaults.get(collection)
  return viewNsid ? views.get(viewNsid) : undefined
}

/** Discover view defs from all loaded lexicons. */
export function discoverViews(): void {
  views.clear()
  collectionDefaults.clear()
  const lexicons = getAllLexicons()

  for (const { nsid, lexicon } of lexicons) {
    if (!lexicon.defs) continue
    const namespace = nsid.split('.').slice(0, -1).join('.')

    for (const [defName, def] of Object.entries(lexicon.defs) as [string, any][]) {
      if (defName === 'main') continue
      if (def.type !== 'object') continue
      if (!def.properties) continue
      if (!defName.includes('View') && !defName.includes('view')) continue

      // Pattern 1: Inline view — has a property that refs #main
      const recordFieldEntry = Object.entries(def.properties).find(
        ([_, prop]: [string, any]) => prop.type === 'ref' && prop.ref === '#main',
      )

      if (recordFieldEntry) {
        // Inline view: the record lexicon IS the collection
        const viewDef = buildInlineViewDef(nsid, defName, recordFieldEntry[0], def)
        const fullNsid = `${nsid}#${defName}`
        views.set(fullNsid, viewDef)
        registerDefault(viewDef.collection, defName, fullNsid)
        log(`[views] discovered: ${fullNsid} → ${viewDef.collection} (inline, ${viewDef.fields.length} fields)`)
        continue
      }

      // Pattern 2: Defs view — associate by naming convention
      const recordName = extractRecordName(defName)
      if (!recordName) continue

      const collection = findRecordCollection(recordName, namespace, lexicons)
      if (!collection) continue

      const viewDef = buildDefsViewDef(nsid, defName, collection, def)
      const fullNsid = `${nsid}#${defName}`
      views.set(fullNsid, viewDef)
      registerDefault(collection, defName, fullNsid)
      log(`[views] discovered: ${fullNsid} → ${collection} (defs, ${viewDef.fields.length} fields)`)
    }
  }
}

// --- View Builders ---

/** Build a ViewDef for an inline view (has ref: "#main"). */
function buildInlineViewDef(nsid: string, defName: string, recordFieldName: string, def: any): ViewDef {
  const fields: ViewField[] = []

  for (const [fieldName, prop] of Object.entries(def.properties) as [string, any][]) {
    if (fieldName === recordFieldName) continue

    if (prop.type === 'ref') {
      const resolved = resolveRefCollection(prop.ref, nsid)
      if (resolved) {
        const refLexicon = getLexicon(resolved)
        const mainDef = refLexicon?.defs?.main
        const joinField = mainDef?.key === 'literal:self' ? 'did' : 'uri'
        const blobs = discoverBlobFields(mainDef)
        fields.push({ kind: 'ref', fieldName, collection: resolved, joinField, blobFields: blobs })
      }
    } else if (prop.type === 'array' && prop.items?.type === 'ref' && prop.items.ref?.includes('label')) {
      fields.push({ kind: 'labels', fieldName })
    } else {
      fields.push({ kind: 'scalar', fieldName, type: prop.type, format: prop.format })
    }
  }

  return {
    nsid: `${nsid}#${defName}`,
    collection: nsid,
    name: defName,
    recordField: recordFieldName,
    blobFields: new Map(),
    fields,
  }
}

/** Build a ViewDef for a defs-pattern view (flattened, no ref: "#main"). */
function buildDefsViewDef(defsNsid: string, defName: string, collection: string, def: any): ViewDef {
  const fields: ViewField[] = []

  // Get the record's schema to detect blob fields
  const recordLexicon = getLexicon(collection)
  const mainDef = recordLexicon?.defs?.main
  const blobFields = discoverBlobFields(mainDef)

  for (const [fieldName, prop] of Object.entries(def.properties) as [string, any][]) {
    // Skip envelope fields — these come from the row, not hydration
    if (['did', 'handle', 'indexedAt'].includes(fieldName)) continue
    // Skip fields that are record properties (they come from flattening the record)
    if (mainDef?.record?.properties?.[fieldName]) continue

    if (prop.type === 'array' && prop.items?.type === 'ref' && prop.items.ref?.includes('label')) {
      fields.push({ kind: 'labels', fieldName })
    } else if (prop.type === 'ref') {
      // Could be viewer state or other refs — treat as scalar for now
      // Viewer hooks handle viewer state enrichment
      fields.push({ kind: 'scalar', fieldName, type: 'ref' })
    } else {
      fields.push({ kind: 'scalar', fieldName, type: prop.type, format: prop.format })
    }
  }

  return {
    nsid: `${defsNsid}#${defName}`,
    collection,
    name: defName,
    recordField: null,
    blobFields,
    fields,
  }
}

// --- Helpers ---

/** Register a view as the default for its collection if it's the base {name}View variant. */
function registerDefault(collection: string, defName: string, fullNsid: string): void {
  // {name}View is the default; {name}ViewBasic / {name}ViewDetailed are not
  if (defName.endsWith('View') && !collectionDefaults.has(collection)) {
    collectionDefaults.set(collection, fullNsid)
  }
}

/** Extract the record name from a view def name. profileView → profile, playViewDetailed → play */
function extractRecordName(defName: string): string | null {
  const match = defName.match(/^(.+?)View(Basic|Detailed)?$/)
  return match ? match[1] : null
}

/** Find a record-type lexicon matching a name in the given namespace. */
function findRecordCollection(
  recordName: string,
  namespace: string,
  lexicons: Array<{ nsid: string; lexicon: any }>,
): string | null {
  const target = `${namespace}.${recordName}`
  const lex = lexicons.find((l) => l.nsid === target)
  if (lex?.lexicon?.defs?.main?.type === 'record') return target
  return null
}

/** Resolve a ref string to a collection NSID. */
function resolveRefCollection(ref: string, currentNsid: string): string | null {
  if (ref.startsWith('#')) return currentNsid
  if (ref.includes('#')) return ref.split('#')[0]
  return ref
}

/** Find blob-typed fields in a record def and assign CDN presets by field name. */
function discoverBlobFields(mainDef: any): Map<string, string> {
  const blobs = new Map<string, string>()
  if (!mainDef?.record?.properties) return blobs

  const presetMap: Record<string, string> = {
    avatar: 'avatar',
    banner: 'banner',
    thumbnail: 'feed_thumbnail',
  }

  for (const [name, prop] of Object.entries(mainDef.record.properties) as [string, any][]) {
    if (prop.type === 'blob') {
      blobs.set(name, presetMap[name] || 'feed_fullsize')
    }
  }
  return blobs
}


/** Flatten a Row<T> into a view object: { uri, did, handle, ...value, ...overrides } */
function flattenRow<T>(row: Row<T>, overrides?: Record<string, unknown>): FlatRow<T> {
  if (!row) return null as any
  return {
    uri: row.uri,
    did: row.did,
    handle: row.handle,
    ...(row.value as any),
    ...overrides,
  } as FlatRow<T>
}

/** Resolve blob fields on a record to CDN URLs. */
function resolveBlobOverrides(item: Row<unknown>, blobFields: Map<string, string>): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  for (const [fieldName, preset] of blobFields) {
    overrides[fieldName] = blobUrl(item.did, (item.value as any)?.[fieldName], preset as any)
  }
  return overrides
}
