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
 * The collection segment of an AT-URI: at://{did}/{collection}/{rkey}.
 * Splitting yields ['at:', '', did, collection, rkey].
 */
export function collectionFromUri(uri: string): string | undefined {
  const parts = uri.split('/')
  return parts.length > 4 ? parts[3] : undefined
}
