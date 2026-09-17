/**
 * Which spaces a given viewer may be shown.
 *
 * The question has exactly one authoritative answer, and hatk is not the one
 * holding it: a space's authority decides who may read it, at the moment it
 * mints a credential, from records and rules that live on the community's own
 * host. Re-deriving that here — reading the access and membership records out
 * of the index and evaluating them — would be a second implementation of
 * somebody else's authorization, drifting from it in exactly the cases that
 * matter. Ejected members keep their content readable in the alpha; an invites
 * space is write-for-anyone and read-for-owner; a host may change its rules
 * without telling us.
 *
 * So the check is the real thing: ask the authority to mint a credential as
 * this viewer, and take the answer. It succeeds precisely when the viewer may
 * read the space, because that is the same call their own browser would make.
 *
 * What that costs is a round trip per space, so the answer is cached — which
 * means revocation lags by up to the cache's lifetime. Worth stating plainly:
 * somebody ejected from a community may still be served that community's rows
 * for a few minutes. The alternative is two round trips on every request, and
 * the space host itself already lets a minted credential outlive a revocation
 * by up to two hours.
 */

import type { OAuthConfig } from '../config.ts'
import { emit } from '../logger.ts'
import { mintSpaceCredential, isSpaceGone, type SpaceCredential } from './credential.ts'
import { listSpaceWatches } from './store.ts'

/** How long a viewer's readable set is trusted before it is checked again. */
const TTL_MS = 5 * 60 * 1000

/** Enough for a community's worth of spaces without opening a socket per space. */
const CONCURRENCY = 6

/**
 * Viewers held at once. Past this the oldest entry goes — a cache that grows
 * with every account that has ever signed in is a leak, and the cost of a miss
 * is one round trip.
 */
const MAX_VIEWERS = 1000

interface Entry {
  expiresAt: number
  /** The credential minted while answering, kept so a blob read need not mint again. */
  credentials: Map<string, SpaceCredential | null>
}

const cache = new Map<string, Entry>()

function entryFor(viewerDid: string): Entry | undefined {
  const entry = cache.get(viewerDid)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(viewerDid)
    return undefined
  }
  // Re-inserted so iteration order is least-recently-used first.
  cache.delete(viewerDid)
  cache.set(viewerDid, entry)
  return entry
}

function store(viewerDid: string, credentials: Map<string, SpaceCredential | null>): Entry {
  const entry: Entry = { expiresAt: Date.now() + TTL_MS, credentials }
  cache.set(viewerDid, entry)
  while (cache.size > MAX_VIEWERS) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
  return entry
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

async function resolve(oauth: OAuthConfig, viewerDid: string): Promise<Entry> {
  const watches = await listSpaceWatches()
  const credentials = new Map<string, SpaceCredential | null>()
  if (watches.length === 0) return store(viewerDid, credentials)

  const elapsed = Date.now()
  await inBatches(watches, CONCURRENCY, async (watch) => {
    try {
      credentials.set(watch.space, await mintSpaceCredential(oauth, watch.space, viewerDid))
    } catch (err) {
      // Every refusal is a no, and a refusal is the ordinary shape of "not a
      // member" rather than a fault worth reporting. A space that has been
      // deleted is a no for everybody and the sweep will stop following it.
      credentials.set(watch.space, null)
      if (isSpaceGone(err)) return
    }
  })

  const readable = [...credentials].filter(([, c]) => c !== null).length
  emit('spaces', 'viewer_resolved', {
    viewer_did: viewerDid,
    checked: watches.length,
    readable,
    duration_ms: Date.now() - elapsed,
  })
  return store(viewerDid, credentials)
}

/**
 * The spaces this viewer may be shown, as the scope for a request.
 *
 * Empty for a signed-out visitor, always: obtaining a credential begins with a
 * delegation token from the reader's own PDS, so there is no anonymous read
 * path into a space at all. `readableBy: ["public"]` means any authenticated
 * reader, never anyone.
 */
export async function readableSpacesFor(oauth: OAuthConfig | null, viewer: { did: string } | null): Promise<string[]> {
  if (!oauth || !viewer) return []
  const entry = entryFor(viewer.did) ?? (await resolve(oauth, viewer.did))
  return [...entry.credentials].filter(([, c]) => c !== null).map(([space]) => space)
}

/**
 * This viewer's own credential for a space, or null if they may not read it.
 *
 * For the reads that cannot go through the index — a blob, which has no public
 * URL by design and must be fetched from the repo that holds it with the same
 * credential as the record naming it.
 */
export async function viewerCredential(
  oauth: OAuthConfig | null,
  viewer: { did: string } | null,
  space: string,
): Promise<SpaceCredential | null> {
  if (!oauth || !viewer) return null
  const entry = entryFor(viewer.did) ?? (await resolve(oauth, viewer.did))
  const cached = entry.credentials.get(space)
  if (cached !== undefined) {
    // A credential can expire inside the entry's own lifetime; the answer to
    // "may they read it" outlives the token that proved it.
    if (cached === null) return null
    if (cached.expiresAt > Date.now()) return cached
  }
  try {
    const credential = await mintSpaceCredential(oauth, space, viewer.did)
    entry.credentials.set(space, credential)
    return credential
  } catch {
    entry.credentials.set(space, null)
    return null
  }
}

/** Drop a viewer's cached answer — after they sign out, or to stop honouring it early. */
export function forgetViewerSpaces(viewerDid: string): void {
  cache.delete(viewerDid)
}

export function resetViewerSpaces(): void {
  cache.clear()
}
