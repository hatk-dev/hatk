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
 * So the bytes come through here, fetched on the viewer's own behalf with the
 * viewer's own credential, and go no further: `private, no-store` keeps them
 * out of every shared cache between this server and that browser.
 */

import type { OAuthConfig } from '../config.ts'
import { emit } from '../logger.ts'
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
 * The URL this appview serves a space blob at, for whoever is asking.
 *
 * Built here rather than by the app, because the route is hatk's: a blob in a
 * space has no public address by design, and this is the one address it does
 * have — answered per viewer, with that viewer's credential, uncacheable.
 */
export function spaceBlobUrl(space: string, repo: string, cid: string): string {
  const params = new URLSearchParams({ space, repo, cid })
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
}

export function parseSpaceBlobRequest(params: URLSearchParams): SpaceBlobRequest | null {
  const space = params.get('space')
  const repo = params.get('repo') ?? params.get('did')
  const cid = params.get('cid')
  if (!space || !repo || !cid) return null
  if (!parseSpaceRef(space) || !repo.startsWith('did:')) return null
  return { space, repo, cid }
}

/**
 * Fetch a space blob as this viewer, or answer why not.
 *
 * A viewer who cannot read the space gets the same 404 as a blob that is not
 * there. The distinction between "you may not" and "it does not exist" is
 * itself information about a private space, and the space host draws the line
 * the same way when it reports a non-member's repo as simply absent.
 */
export async function serveSpaceBlob(
  oauth: OAuthConfig | null,
  viewer: { did: string } | null,
  request: SpaceBlobRequest,
): Promise<Response> {
  if (!viewer) return new Response('Unauthorized', { status: 401 })

  const credential = await viewerCredential(oauth, viewer, request.space)
  if (!credential) return new Response('Not found', { status: 404 })

  let upstream: Response
  try {
    const url = new URL(`${await repoEndpoint(request.repo)}/xrpc/com.atproto.space.getBlob`)
    url.searchParams.set('space', request.space)
    // `repo`, not `did`: a space read names the repo holding the record the
    // same way everywhere. A server hosting one account falls back to it,
    // which is what makes `did` ever appear to work.
    url.searchParams.set('repo', request.repo)
    url.searchParams.set('cid', request.cid)
    upstream = await credential.fetch(url)
  } catch (err: any) {
    emit('spaces', 'blob_error', { space: request.space, repo: request.repo, error: err.message })
    return new Response('Blob unavailable', { status: 502 })
  }

  if (!upstream.ok) return new Response('Not found', { status: upstream.status === 401 ? 404 : upstream.status })

  const claimed = (upstream.headers.get('content-type') ?? '').split(';')[0].trim()
  const contentType = SERVABLE.has(claimed) ? claimed : 'application/octet-stream'

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': contentType,
      // Not a public cache: this response is one viewer's, and the next
      // request for the same URL may be somebody with no right to it.
      'cache-control': 'private, no-store',
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
}
