/**
 * Serving a blob that lives in a permissioned space.
 *
 * Every other image hatk hands out has a public URL — a CDN path, or the
 * repo's own `com.atproto.sync.getBlob`. A space's blob has neither, by
 * design: `com.atproto.space.getBlob` serves it only to a credential holder,
 * and only for a space the blob is actually referenced from. Giving one a
 * public URL would turn that URL into the capability the credential exists to
 * replace.
 *
 * So the bytes come through here, and every request is authorized before any
 * of them move: the viewer's credential for the space, or the same 404 a
 * missing blob gets. What that authorization guards is served two ways —
 * `private` so the viewer's own browser may hold it and no shared cache may,
 * and out of a bounded in-memory cache so the same photo is fetched from its
 * repo once rather than once per member looking at it.
 */

import type { OAuthConfig } from '../config.ts'
import { emit } from '../logger.ts'
import type { SpaceCredential } from './credential.ts'
import { repoEndpoint } from './identity.ts'
import { parseSpaceRef } from './uri.ts'
import { viewerCredential } from './viewer.ts'

/**
 * What we are willing to hand back, whatever the repo claims it is.
 *
 * The record naming this blob was written by an account hatk does not control,
 * and so was its mime type. Echoing that unchecked would let a writer choose
 * what a browser executes in this origin.
 */
const SERVABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'])

/**
 * How long a browser may reuse a blob it has before it asks again.
 *
 * Every request that does arrive is authorized, so this is the window in which
 * a viewer who has just lost access still sees what they had. A minute is
 * small against what the surrounding design already accepts: the readable set
 * is cached for five, and the space host lets a minted credential outlive a
 * revocation by up to two hours.
 */
const MAX_AGE_S = 60

/**
 * Bytes held across every cached blob, and the largest single one worth
 * holding. A blob past the entry limit streams straight through instead —
 * caching it would evict a great many small ones to save one fetch.
 */
const CACHE_BYTES = 64 * 1024 * 1024
const MAX_ENTRY_BYTES = 4 * 1024 * 1024

/**
 * How much of an original we will read in order to make a smaller one.
 *
 * Larger than what we hold, and deliberately: a photograph straight off a
 * camera is exactly the case where resizing pays, and refusing to read it
 * would be refusing the request that needs answering most. What comes back out
 * is a derivative small enough to keep.
 */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024

/**
 * The sizes a space blob is served at.
 *
 * The same words hatk's public path uses for imgproxy, with the same numbers,
 * so an app naming a size says it once and means it either side of the line
 * between a public blob and a permissioned one. What differs is who resizes:
 * a space blob may not pass through an image CDN, so it happens here.
 *
 * A request naming none gets the original, which is what every caller written
 * before presets existed asks for.
 */
const PRESETS = {
  avatar: { width: 1000, height: 1000, fit: 'cover', quality: 85 },
  avatar_thumbnail: { width: 128, height: 128, fit: 'cover', quality: 70 },
  feed_thumbnail: { width: 1000, fit: 'inside', quality: 70 },
  feed_fullsize: { quality: 90 },
  banner: { width: 3000, height: 1000, fit: 'cover', quality: 85 },
} as const satisfies Record<string, { width?: number; height?: number; fit?: 'cover' | 'inside'; quality: number }>

export type SpaceBlobPreset = keyof typeof PRESETS

/**
 * Only a name from that list is a preset.
 *
 * Free-form dimensions would let anyone mint unlimited distinct cache keys and
 * evict everything real, and would put the cost of an arbitrary resize behind
 * a URL. An unrecognised name is treated as none rather than refused: a broken
 * image is a worse answer than a large one.
 */
export function asPreset(name: string | null | undefined): SpaceBlobPreset | undefined {
  return name && name in PRESETS ? (name as SpaceBlobPreset) : undefined
}

/** Resizing is skipped for these: one frame of an animation is not the animation. */
const ANIMATED = new Set(['image/gif'])

/**
 * The URL this appview serves a space blob at, for whoever is asking.
 *
 * Built here rather than by the app, because the route is hatk's: a blob in a
 * space has no public address by design, and this is the one address it does
 * have — answered only to a viewer who may read the space it names.
 */
export function spaceBlobUrl(space: string, repo: string, cid: string, preset?: SpaceBlobPreset): string {
  const params = new URLSearchParams({ space, repo, cid })
  if (preset) params.set('preset', preset)
  return `/space-blob?${params}`
}

/**
 * The CID a blob reference names, in whichever spelling the read used.
 *
 * A repo read gives the lexicon's `{ ref: { $link } }`; a space read comes
 * back through a lex client that decodes the same field into a CID object
 * whose `/` is the string. One blob, two spellings, and no caller should have
 * to know which it got.
 */
export function blobCid(blob: unknown): string | undefined {
  const ref = (blob as { ref?: { $link?: unknown; '/'?: unknown } } | undefined)?.ref
  if (!ref || typeof ref !== 'object') return undefined
  if (typeof ref.$link === 'string') return ref.$link
  if (typeof ref['/'] === 'string') return ref['/']
  return undefined
}

export interface SpaceBlobRequest {
  space: string
  /** The repo holding the blob — the writer's, not the authority's. */
  repo: string
  cid: string
  /** The size to serve it at. Absent means the original. */
  preset?: SpaceBlobPreset
}

export function parseSpaceBlobRequest(params: URLSearchParams): SpaceBlobRequest | null {
  const space = params.get('space')
  const repo = params.get('repo') ?? params.get('did')
  const cid = params.get('cid')
  if (!space || !repo || !cid) return null
  if (!parseSpaceRef(space) || !repo.startsWith('did:')) return null
  const preset = asPreset(params.get('preset'))
  return { space, repo, cid, ...(preset ? { preset } : {}) }
}

interface Entry {
  bytes: Uint8Array<ArrayBuffer>
  contentType: string
}

/**
 * Blobs held in memory, least recently used first.
 *
 * In memory and not on disk on purpose. These are members' private photos, and
 * a cache that survives a restart is a store of them: this one is bounded,
 * forgotten when the process ends, and never written anywhere a backup would
 * find it.
 */
const cache = new Map<string, Entry>()
let cachedBytes = 0

/**
 * Fetches in flight, so a page opening with the same image in it twenty times
 * fetches it once. Keyed like the cache.
 */
const inFlight = new Map<string, Promise<Entry | null>>()

/**
 * The space is part of the key, and has to be.
 *
 * A CID names bytes, so caching by CID alone would hit across spaces — and the
 * check that a blob is actually referenced from the space being named lives
 * upstream, in `com.atproto.space.getBlob`. A viewer who may read one space
 * could then name any CID they had heard of and be served it out of the cache
 * without that check ever running.
 */
const keyFor = (request: SpaceBlobRequest) => `${request.space}\n${request.cid}\n${request.preset ?? ''}`

function cacheGet(key: string): Entry | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  // Re-inserted so iteration order is least-recently-used first.
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

function cachePut(key: string, entry: Entry): void {
  if (entry.bytes.byteLength > MAX_ENTRY_BYTES) return
  const existing = cache.get(key)
  if (existing) cachedBytes -= existing.bytes.byteLength
  cache.set(key, entry)
  cachedBytes += entry.bytes.byteLength
  while (cachedBytes > CACHE_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cachedBytes -= cache.get(oldest.value)!.bytes.byteLength
    cache.delete(oldest.value)
  }
}

/** Drop everything held. For tests, and for an operator who wants it gone. */
export function resetSpaceBlobCache(): void {
  cache.clear()
  inFlight.clear()
  cachedBytes = 0
}

/**
 * A CID is a hash of the bytes it names, which is exactly what an ETag is for.
 * Strong, free, and stable for as long as the blob exists. The preset is part
 * of it because it is part of what comes back.
 */
const etagFor = (request: SpaceBlobRequest) =>
  request.preset ? `"${request.cid}-${request.preset}"` : `"${request.cid}"`

/** Whether the browser already holds this blob. `*` matches anything it has. */
function matches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === etag)
}

/**
 * Headers every answer carries, whether it has a body or not.
 *
 * `private` is the whole of the caching posture: the viewer's own browser may
 * keep what it was shown, and no cache between here and there may. `vary`
 * keeps it honest on a browser where two people sign in — the response turns
 * on who asked, and who asked is the cookie or the token.
 */
function cacheHeaders(request: SpaceBlobRequest): Record<string, string> {
  return {
    etag: etagFor(request),
    'cache-control': `private, max-age=${MAX_AGE_S}, must-revalidate`,
    vary: 'cookie, authorization',
  }
}

function serve(entry: Entry, request: SpaceBlobRequest): Response {
  return new Response(entry.bytes, {
    status: 200,
    headers: {
      'content-type': entry.contentType,
      ...cacheHeaders(request),
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
}

/** A refusal from the repo host, carried out through the in-flight promise. */
class UpstreamRefusal extends Error {
  constructor(readonly status: number) {
    super(`upstream refused with ${status}`)
  }
}

/**
 * Fetch a space blob as this viewer, or answer why not.
 *
 * A viewer who cannot read the space gets the same 404 as a blob that is not
 * there. The distinction between "you may not" and "it does not exist" is
 * itself information about a private space, and the space host draws the line
 * the same way when it reports a non-member's repo as simply absent.
 *
 * The credential is checked on every request, including the ones answered from
 * the cache and the ones answered with a 304. Nothing here is ever served to
 * somebody the authority has not just said yes to.
 */
export async function serveSpaceBlob(
  oauth: OAuthConfig | null,
  viewer: { did: string } | null,
  request: SpaceBlobRequest,
  ifNoneMatch?: string | null,
): Promise<Response> {
  if (!viewer) return new Response('Unauthorized', { status: 401 })

  const credential = await viewerCredential(oauth, viewer, request.space)
  if (!credential) return new Response('Not found', { status: 404 })

  // The browser has it already. Authorized above, so this is a viewer who may
  // go on looking at what they hold — and it costs neither of us the bytes.
  if (matches(ifNoneMatch, etagFor(request))) {
    return new Response(null, { status: 304, headers: cacheHeaders(request) })
  }

  const key = keyFor(request)
  const hit = cacheGet(key)
  if (hit) return serve(hit, request)

  let entry: Entry | null
  try {
    entry = await (inFlight.get(key) ?? fetchOnce(key, credential, request))
  } catch (err: any) {
    if (err instanceof UpstreamRefusal) return new Response('Not found', { status: err.status })
    emit('spaces', 'blob_error', { space: request.space, repo: request.repo, error: err.message })
    return new Response('Blob unavailable', { status: 502 })
  }

  // Too large to hold, which the read above discovered from its headers and
  // then dropped. Asking again costs a round trip and no bytes, and buys a
  // body that is streamed rather than gathered into memory to be served once.
  if (!entry) return streamThrough(credential, request)

  return serve(entry, request)
}

function blobUrlFor(endpoint: string, request: SpaceBlobRequest): URL {
  const url = new URL(`${endpoint}/xrpc/com.atproto.space.getBlob`)
  url.searchParams.set('space', request.space)
  // `repo`, not `did`: a space read names the repo holding the record the
  // same way everywhere. A server hosting one account falls back to it,
  // which is what makes `did` ever appear to work.
  url.searchParams.set('repo', request.repo)
  url.searchParams.set('cid', request.cid)
  return url
}

/**
 * The upstream read, shared by everyone who asked for this blob at once.
 *
 * Resolves to null for a blob too large to hold, which the caller streams
 * instead. A failure rejects, and rejects for all of them: one refusal is
 * every caller's refusal, because the credential each of them presented had
 * already been accepted for this space.
 */
function fetchOnce(key: string, credential: SpaceCredential, request: SpaceBlobRequest): Promise<Entry | null> {
  const task = (async (): Promise<Entry | null> => {
    const upstream = await credential.fetch(blobUrlFor(await repoEndpoint(request.repo), request))
    if (!upstream.ok) {
      // A credential the repo host rejects reads as absent, not as
      // unauthorized: the viewer holds one, so what they are being told is
      // that this blob is not theirs to see.
      throw new UpstreamRefusal(upstream.status === 401 ? 404 : upstream.status)
    }

    const contentType = servableType(upstream)
    const limit = request.preset ? MAX_SOURCE_BYTES : MAX_ENTRY_BYTES
    const declared = Number(upstream.headers.get('content-length') ?? NaN)
    if (declared > limit) {
      await upstream.body?.cancel()
      return null
    }

    // Read against the limit rather than trusting the length, which a repo host
    // is free not to send and free to get wrong.
    const source = await readBounded(upstream, limit)
    if (!source) return null

    // A resize that cannot happen is not a failure to serve. Sharp missing, an
    // animation, or an image it cannot read all end here with the original,
    // which is the answer this route gave before presets existed.
    const bytes = request.preset ? ((await resize(source, contentType, request.preset)) ?? source) : source

    const entry: Entry = { bytes, contentType }
    cachePut(key, entry)
    return entry
  })().finally(() => {
    if (inFlight.get(key) === task) inFlight.delete(key)
  })
  inFlight.set(key, task)
  return task
}

/**
 * The whole body, or null once it is plainly too big to hold.
 *
 * Bounded as it reads: a body that goes past the limit is abandoned there, so
 * the most this ever holds is one blob's worth over the limit by one chunk.
 */
async function readBounded(upstream: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!upstream.body) return new Uint8Array(0)
  const reader = upstream.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

/**
 * Sharp, if this deployment has it.
 *
 * An optional peer dependency: hatk is a library, and most of what installs it
 * never serves a permissioned space at all. Resolved once — a missing module
 * is answered from the same settled promise rather than re-attempted per
 * image.
 */
let sharpModule: Promise<typeof import('sharp').default | null> | undefined
function loadSharp(): Promise<typeof import('sharp').default | null> {
  sharpModule ??= import('sharp')
    .then((m) => m.default)
    .catch(() => {
      emit('spaces', 'resize_unavailable', { reason: 'sharp is not installed' })
      return null
    })
  return sharpModule
}

/**
 * The blob at the size it is drawn, or null to serve the original instead.
 *
 * Orientation is applied before the resize and the metadata that carried it is
 * dropped with everything else — which also means the GPS in a ride photo's
 * EXIF stops being served to everyone the space admits.
 *
 * The format is kept rather than normalised to JPEG. Re-encoding a PNG that
 * way silently flattens its transparency, and no size is worth that.
 *
 * Null when the original is the better answer — an animation, an image sharp
 * cannot read, sharp absent, or a derivative that came out no smaller.
 */
async function resize(
  source: Uint8Array<ArrayBuffer>,
  contentType: string,
  preset: SpaceBlobPreset,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (ANIMATED.has(contentType)) return null
  const sharp = await loadSharp()
  if (!sharp) return null

  const { width, height, fit, quality } = PRESETS[preset] as {
    width?: number
    height?: number
    fit?: 'cover' | 'inside'
    quality: number
  }
  try {
    let pipeline = sharp(source).rotate()
    if (width) pipeline = pipeline.resize({ width, height, fit, withoutEnlargement: true })
    // Named explicitly rather than left to sharp, which keeps the input format
    // but not the quality — without this a preset that only sets quality, like
    // a full-size one, would re-encode at sharp's default and do nothing.
    if (contentType === 'image/jpeg') pipeline = pipeline.jpeg({ quality, mozjpeg: true })
    else if (contentType === 'image/webp') pipeline = pipeline.webp({ quality })
    else if (contentType === 'image/avif') pipeline = pipeline.avif({ quality })
    else if (contentType === 'image/png') pipeline = pipeline.png({ compressionLevel: 9 })
    const out = await pipeline.toBuffer()
    // A derivative bigger than what it came from is a worse answer than the
    // original — small images re-encoded at a higher quality can land there.
    if (out.byteLength >= source.byteLength) return null
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength) as Uint8Array<ArrayBuffer>
  } catch (err: any) {
    emit('spaces', 'resize_failed', { preset, content_type: contentType, error: err?.message ?? String(err) })
    return null
  }
}

/** A blob too large to cache, passed through as it arrives. */
async function streamThrough(credential: SpaceCredential, request: SpaceBlobRequest): Promise<Response> {
  let upstream: Response
  try {
    upstream = await credential.fetch(blobUrlFor(await repoEndpoint(request.repo), request))
  } catch (err: any) {
    emit('spaces', 'blob_error', { space: request.space, repo: request.repo, error: err.message })
    return new Response('Blob unavailable', { status: 502 })
  }
  if (!upstream.ok) {
    return new Response('Not found', { status: upstream.status === 401 ? 404 : upstream.status })
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': servableType(upstream),
      ...cacheHeaders(request),
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
}

function servableType(upstream: Response): string {
  const claimed = (upstream.headers.get('content-type') ?? '').split(';')[0].trim()
  return SERVABLE.has(claimed) ? claimed : 'application/octet-stream'
}
