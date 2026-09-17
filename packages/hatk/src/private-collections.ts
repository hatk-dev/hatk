import { collectionFromRecordUri } from './spaces/uri.ts'

/**
 * Collections that are indexed and queryable in-process but must never be
 * served by the built-in dev.hatk.* record endpoints.
 *
 * Held module-level, mirroring the schema registry, so the guard can be applied
 * inside handlers without threading config through every signature.
 */
let privateCollections = new Set<string>()

export function setPrivateCollections(list: string[]): void {
  privateCollections = new Set(list)
}

export function isPrivateCollection(nsid: string | null | undefined): boolean {
  return nsid != null && privateCollections.has(nsid)
}

/**
 * The collection segment of a record AT-URI, in either shape.
 *
 * A repo record is `at://{did}/{collection}/{rkey}`; a space record is
 * `at://{authority}/space/{type}/{skey}/{writer}/{collection}/{rkey}`, where
 * the position a collection used to occupy holds the literal 'space'. Reading
 * it positionally without that distinction reports every space record as
 * belonging to a collection named 'space', which no guard would match.
 */
export function collectionFromUri(uri: string): string | undefined {
  return collectionFromRecordUri(uri)
}
