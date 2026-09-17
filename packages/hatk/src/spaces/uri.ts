/**
 * AT-URIs for permissioned spaces (proposal 0016).
 *
 * A space is named by a three-segment ref, and a record inside one carries the
 * writer, collection and rkey after it:
 *
 *   at://{authority}/space/{type}/{skey}                              — the space
 *   at://{authority}/space/{type}/{skey}/{writer}/{collection}/{rkey} — a record in it
 *
 * Seven segments where an ordinary record URI has five, and `space` sitting
 * where a collection would. Anything that reads a collection out of a URI by
 * position has to know the difference or it reads back the literal 'space'.
 *
 * The authority is always a DID rather than a handle: a space's membership is
 * keyed on DIDs, so a handle could not be resolved to a member.
 */

const SPACE_MARKER = 'space'
const AT_PREFIX = 'at://'

export interface SpaceRef {
  /** The DID the space is anchored on, and the only party that issues credentials for it. */
  authority: string
  /** The space type NSID, whose lexicon declares which collections the space holds. */
  type: string
  skey: string
}

export interface SpaceRecordRef extends SpaceRef {
  /** The three-segment ref of the space this record lives in. */
  space: string
  /** The account whose repo holds the record. Records stay with their writer. */
  writer: string
  collection: string
  rkey: string
}

function segments(uri: string): string[] | null {
  if (!uri.startsWith(AT_PREFIX)) return null
  return uri.slice(AT_PREFIX.length).split('/')
}

export function spaceRefUri(ref: SpaceRef): string {
  return `${AT_PREFIX}${ref.authority}/${SPACE_MARKER}/${ref.type}/${ref.skey}`
}

/** Parse `at://{authority}/space/{type}/{skey}` — the space itself, not a record in it. */
export function parseSpaceRef(uri: string): SpaceRef | null {
  const parts = segments(uri)
  if (!parts || parts.length !== 4) return null
  const [authority, marker, type, skey] = parts
  if (marker !== SPACE_MARKER || !authority.startsWith('did:') || !type || !skey) return null
  return { authority, type, skey }
}

/** Whether a URI names a space or anything inside one. */
export function isSpaceUri(uri: string): boolean {
  const parts = segments(uri)
  return parts != null && parts.length >= 4 && parts[1] === SPACE_MARKER && parts[0].startsWith('did:')
}

/** `at://{authority}/space/{type}/{skey}` from its parts; `self` is the skey a singleton space uses. */
export function spaceUri(authority: string, type: string, skey = 'self'): string {
  return `${AT_PREFIX}${authority}/${SPACE_MARKER}/${type}/${skey}`
}

/** The record key: the last segment of either URI shape. */
export function rkeyOf(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1)
}

export function spaceRecordUri(space: string, writer: string, collection: string, rkey: string): string {
  return `${space}/${writer}/${collection}/${rkey}`
}

export function parseSpaceRecordUri(uri: string): SpaceRecordRef | null {
  const parts = segments(uri)
  if (!parts || parts.length !== 7) return null
  const [authority, marker, type, skey, writer, collection, rkey] = parts
  if (marker !== SPACE_MARKER || !authority.startsWith('did:') || !collection || !rkey) return null
  return {
    authority,
    type,
    skey,
    writer,
    collection,
    rkey,
    space: `${AT_PREFIX}${authority}/${SPACE_MARKER}/${type}/${skey}`,
  }
}

/** The space a record URI belongs to, or undefined for an ordinary repo URI. */
export function spaceFromUri(uri: string): string | undefined {
  return parseSpaceRecordUri(uri)?.space ?? undefined
}

/**
 * The collection a record URI names, whichever shape it is.
 *
 * The one place the two URI forms are reconciled; every positional read of a
 * collection goes through here.
 */
export function collectionFromRecordUri(uri: string): string | undefined {
  const parts = segments(uri)
  if (!parts) return undefined
  if (parts.length === 7 && parts[1] === SPACE_MARKER) return parts[5]
  return parts.length >= 3 ? parts[1] : undefined
}

/**
 * The audience a delegation token for this space is addressed to.
 *
 * An authority that publishes no `#atproto_space_host` entry is still reached
 * at its `#atproto_pds` endpoint — the fragment names the audience, not the
 * address.
 */
export function spaceHostAud(authority: string): string {
  return `${authority}#atproto_space_host`
}
