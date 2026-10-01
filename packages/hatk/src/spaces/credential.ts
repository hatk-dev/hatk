/**
 * Getting into a space to read it.
 *
 * hatk is not a member of anything. It has no DID that any community has
 * admitted, and asking every authority to admit an indexer would make indexing
 * a per-community act of trust before a single record could be read.
 *
 * So it reads as somebody who is already inside: a viewer whose OAuth session
 * it already holds, whose PDS will mint a delegation token for the space, and
 * whom the authority already lets in. The exchange is the same one the
 * community's own web app makes from the browser —
 *
 *   the reader's PDS signs a delegation token   (60s, single-use, addressed to
 *                                                the authority's space host)
 *   the authority checks it, checks the reader against the space's policy, and
 *   returns a credential bound to the key that signed the exchange   (10 min)
 *
 * — and the credential is then presented to every writer's host in the space.
 * It carries no audience, which is why it must be bound to a key rather than
 * held as a bearer token: each request signs the credential together with the
 * DID it is addressed to, so a host handed one to serve its own repo cannot
 * replay it against any other account. See signature.ts.
 *
 * The consequence to be honest about: a space is only readable while somebody
 * who can read it has a live session here. That is the same bound the data has
 * anyway — nobody outside the space's audience was ever entitled to this — but
 * it does mean indexing lapses when the last member logs out.
 */

import type { OAuthConfig } from '../config.ts'
import { pdsXrpc } from '../pds-proxy.ts'
import { emit } from '../logger.ts'
import { spaceHostEndpoint } from './identity.ts'
import { generateSpaceSigKey, spaceSigHeaders, type SpaceSigKey } from './signature.ts'
import { parseSpaceRef } from './uri.ts'

/**
 * Re-mint this long before the credential's own expiry rather than racing it.
 * Credentials live ten minutes, so this keeps nine of them.
 */
const RENEW_LEAD_MS = 60 * 1000

export class SpaceCredentialError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** A refusal about who is asking, rather than about the space or the network. */
export function isNotAuthorized(err: unknown): boolean {
  return err instanceof SpaceCredentialError && (err.code === 'UserNotAuthorized' || err.code === 'NotAuthorized')
}

export function isSpaceGone(err: unknown): boolean {
  return err instanceof SpaceCredentialError && (err.code === 'SpaceDeleted' || err.code === 'SpaceNotFound')
}

export interface SpaceCredential {
  /** The space this credential reads, and the only one it is accepted for. */
  space: string
  /** The account whose delegation bought it. */
  readerDid: string
  expiresAt: number
  /**
   * A fetch that presents the credential, signed for whoever the request is
   * addressed to: the `repo` it names, or else the space's authority.
   */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
}

function expiryOf(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now() + 60 * 60 * 1000
  } catch {
    // An unreadable expiry is not a reason to refuse a credential the authority
    // just issued; treat it as short-lived and re-mint sooner.
    return Date.now() + 10 * 60 * 1000
  }
}

/**
 * Exchange a delegation token for a credential at the authority, binding it to
 * `key` by signing the token with it.
 */
async function exchange(
  authorityHost: string,
  space: string,
  delegationToken: string,
  key: SpaceSigKey,
): Promise<string> {
  const url = `${authorityHost}/xrpc/com.atproto.space.getSpaceCredential`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(await spaceSigHeaders(key, `Bearer ${delegationToken}`)),
    },
    body: JSON.stringify({ space }),
  })
  const body = (await res.json().catch(() => ({}))) as { credential?: string; error?: string; message?: string }
  if (!res.ok || !body.credential) {
    throw new SpaceCredentialError(
      res.status,
      body.error ?? (res.status >= 500 ? 'UpstreamFailure' : 'InvalidRequest'),
      body.message ?? `getSpaceCredential refused (${res.status})`,
    )
  }
  return body.credential
}

/** Mint a credential for `space` using `readerDid`'s stored session. */
export async function mintSpaceCredential(
  oauthConfig: OAuthConfig,
  space: string,
  readerDid: string,
): Promise<SpaceCredential> {
  const ref = parseSpaceRef(space)
  if (!ref) throw new SpaceCredentialError(400, 'InvalidRequest', `Not a space ref: ${space}`)

  // The reader's own PDS signs this, under the whole-space read grant their
  // session carries. A session without that scope is refused here, before the
  // authority is ever contacted.
  let token: string
  try {
    const out = await pdsXrpc(oauthConfig, { did: readerDid }, 'com.atproto.space.getDelegationToken', {
      params: { space },
    })
    if (typeof out.token !== 'string') throw new Error('PDS returned no delegation token')
    token = out.token
  } catch (err: any) {
    throw new SpaceCredentialError(err?.status ?? 502, 'DelegationFailed', err?.message ?? 'delegation failed')
  }

  // A key per credential, held only as long as the credential is.
  const key = await generateSpaceSigKey()
  const authorityHost = await spaceHostEndpoint(ref.authority)
  const credential = await exchange(authorityHost, space, token, key)

  // Signatures depend only on the credential and the audience, so each is made
  // once and reused for as long as the credential lives.
  const signed = new Map<string, Promise<Record<string, string>>>()
  const credentialFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const audience = new URL(url).searchParams.get('repo') ?? ref.authority
    let sig = signed.get(audience)
    if (!sig) {
      sig = spaceSigHeaders(key, `Atproto-Space ${credential}`, audience)
      signed.set(audience, sig)
    }
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(await sig)) headers.set(name, value)
    return fetch(url, { ...init, headers })
  }

  return { space, readerDid, expiresAt: expiryOf(credential), fetch: credentialFetch }
}

// --- Cache ---

const cache = new Map<string, SpaceCredential>()

function fresh(cred: SpaceCredential | undefined): cred is SpaceCredential {
  return !!cred && cred.expiresAt - RENEW_LEAD_MS > Date.now()
}

/**
 * A credential for `space`, minted with whichever candidate session works.
 *
 * Candidates are tried in order and the first that succeeds is cached. A
 * refusal about the reader — they were ejected, or never belonged — moves on to
 * the next candidate; a refusal about the space itself stops the whole attempt,
 * since no other reader would fare better.
 */
export async function getSpaceCredential(
  oauthConfig: OAuthConfig,
  space: string,
  candidates: string[],
  opts: { refresh?: boolean } = {},
): Promise<SpaceCredential> {
  if (!opts.refresh) {
    const cached = cache.get(space)
    if (fresh(cached)) return cached
  }

  let lastError: unknown
  for (const readerDid of candidates) {
    try {
      const credential = await mintSpaceCredential(oauthConfig, space, readerDid)
      cache.set(space, credential)
      return credential
    } catch (err) {
      if (isSpaceGone(err)) throw err
      lastError = err
      emit('spaces', 'credential_refused', {
        space,
        reader_did: readerDid,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  cache.delete(space)
  throw lastError ?? new SpaceCredentialError(403, 'NoReader', `No session on this instance can read ${space}`)
}

export function forgetSpaceCredential(space: string): void {
  cache.delete(space)
}

// --- Per reader ---

/**
 * Credentials minted as one particular reader, for reads made on their behalf.
 *
 * Kept apart from the cache above, which holds whichever session works for a
 * space and is right for indexing it. A read made for a viewer has to be made
 * as that viewer: the authority's answer is the authorization.
 */
const readerCache = new Map<string, SpaceCredential>()

/** Pairs held at once. Past this the least recently used goes. */
const MAX_READER_CREDENTIALS = 5000

/**
 * `readerDid`'s own credential for `space`, minted with their stored session.
 *
 * Throws a {@link SpaceCredentialError} when they may not read it, carrying the
 * authority's status and code, and caches only successes — a refusal is asked
 * again next time rather than remembered. `refresh` mints anew, for a read the
 * host refused despite a credential that had not expired by our clock.
 */
export async function readerSpaceCredential(
  oauthConfig: OAuthConfig,
  readerDid: string,
  space: string,
  opts: { refresh?: boolean } = {},
): Promise<SpaceCredential> {
  const key = `${readerDid} ${space}`
  const cached = readerCache.get(key)
  readerCache.delete(key)
  if (!opts.refresh && fresh(cached)) {
    readerCache.set(key, cached)
    return cached
  }
  const credential = await mintSpaceCredential(oauthConfig, space, readerDid)
  readerCache.set(key, credential)
  while (readerCache.size > MAX_READER_CREDENTIALS) {
    const oldest = readerCache.keys().next()
    if (oldest.done) break
    readerCache.delete(oldest.value)
  }
  return credential
}

/**
 * Drop `readerDid`'s cached credential for `space`, after something that may
 * have changed their standing in it — leaving it, say. The next read mints anew.
 */
export function forgetReaderSpaceCredential(readerDid: string, space: string): void {
  readerCache.delete(`${readerDid} ${space}`)
}

/** For tests: drop every cached credential. */
export function resetSpaceCredentials(): void {
  cache.clear()
  readerCache.clear()
}
