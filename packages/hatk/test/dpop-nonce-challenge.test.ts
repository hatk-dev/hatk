import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { pdsXrpc } from '../src/pds-proxy.ts'
import { initOAuth } from '../src/oauth/server.ts'
import { OAUTH_DDL, getSession, storeSession } from '../src/oauth/db.ts'
import { runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// A resource server that wants a DPoP nonce says so in a 401 and encloses the
// nonce to use. Retrying with it is the whole remedy.
//
// Read from the response body alone, that challenge is invisible on a server
// that words the body differently — zds sends the RFC header and an
// `InvalidToken` body, because its XRPC error handler overwrites the
// `UseDpopNonce` one. Invisible, it falls through to the token-error branch,
// which refreshes, replays the same nonce-less proof, is refused the same way,
// and deletes the session. Every private gallery on such a PDS then failed with
// "sign in again", and signing in again changed nothing.

const DID = 'did:plc:noncetest'
const PDS = 'https://pds.example.com'
const ISSUER = 'https://example.app'
const NONCE = 'nonce-from-the-server'

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: `${ISSUER}/oauth-client-metadata.json`, client_name: 'test', scope: 'atproto' }],
} as any

interface StubResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

/** Queue one response per fetch, in order, recording the DPoP proof sent with each. */
function stubFetchSequence(responses: StubResponse[]) {
  const proofs: (string | null)[] = []
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      proofs.push((init?.headers as Record<string, string> | undefined)?.DPoP ?? null)
      const next = responses[Math.min(i++, responses.length - 1)]
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json', ...next.headers },
      })
    }),
  )
  return proofs
}

/** The `nonce` claim of a DPoP proof, or undefined when it carries none. */
function nonceOf(proof: string | null | undefined): string | undefined {
  if (!proof) return undefined
  const payload = JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString())
  return payload.nonce
}

const ok = { status: 200, body: { repos: [] } }

/** zds: the RFC header names the challenge, the body says something else entirely. */
const nonceChallengeHeaderOnly = {
  status: 401,
  body: { error: 'InvalidToken', message: 'Invalid token' },
  headers: {
    'www-authenticate': 'DPoP error="use_dpop_nonce", error_description="Resource server requires nonce"',
    'dpop-nonce': NONCE,
  },
}

/** The reference PDS: the body names it, in the OAuth spelling. */
const nonceChallengeBody = {
  status: 401,
  body: { error: 'use_dpop_nonce' },
  headers: { 'dpop-nonce': NONCE },
}

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  await initOAuth(config, 'http://plc.test', 'ws://relay.test')
})

beforeEach(async () => {
  await storeSession(DID, {
    pdsEndpoint: PDS,
    pdsAuthServer: PDS,
    accessToken: 'a-token',
    refreshToken: 'a-refresh-token',
    dpopJkt: 'jkt',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a nonce challenge carried only by the RFC header is retried with the nonce', async () => {
  const proofs = stubFetchSequence([nonceChallengeHeaderOnly, ok])

  await expect(pdsXrpc(config, { did: DID }, 'com.atproto.space.listRepos')).resolves.toEqual({ repos: [] })

  // Two calls: the challenge, then the same request carrying the nonce.
  expect(proofs).toHaveLength(2)
  expect(nonceOf(proofs[0])).toBeUndefined()
  expect(nonceOf(proofs[1])).toBe(NONCE)

  // Nothing about the grant was wrong, so the session survives.
  expect(await getSession(DID)).not.toBeNull()
})

test('a nonce challenge named in the body is still retried', async () => {
  const proofs = stubFetchSequence([nonceChallengeBody, ok])

  await expect(pdsXrpc(config, { did: DID }, 'com.atproto.space.listRepos')).resolves.toEqual({ repos: [] })
  expect(nonceOf(proofs[1])).toBe(NONCE)
  expect(await getSession(DID)).not.toBeNull()
})

test('satisfying the challenge hands the caller whatever the request really answers', async () => {
  // The nonce was the only thing wrong with the first call; the second gets far
  // enough to be judged on its merits. That answer belongs to the caller
  // untouched, and the session — never the thing at fault — survives.
  const proofs = stubFetchSequence([nonceChallengeHeaderOnly, { status: 400, body: { error: 'InvalidRequest' } }])

  await expect(pdsXrpc(config, { did: DID }, 'com.atproto.space.listRepos')).rejects.toMatchObject({ status: 400 })

  expect(proofs).toHaveLength(2)
  expect(nonceOf(proofs[1])).toBe(NONCE)
  expect(await getSession(DID)).not.toBeNull()
})

test('an invalid token that merely carries a nonce is not read as a challenge', async () => {
  // A PDS may attach `DPoP-Nonce` to every 401. Only `use_dpop_nonce` marks a
  // challenge — this one is a real token failure and belongs to the refresh
  // path, which here is refused again and ends as a prompt to authorize.
  const deadToken = {
    status: 401,
    body: { error: 'InvalidToken' },
    headers: {
      'www-authenticate': 'DPoP error="invalid_token", error_description="Token is invalid"',
      'dpop-nonce': NONCE,
    },
  }
  const refreshed = {
    status: 200,
    body: { access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 3600 },
  }
  const proofs = stubFetchSequence([deadToken, refreshed, deadToken, deadToken])

  await expect(pdsXrpc(config, { did: DID }, 'com.atproto.space.listRepos')).rejects.toMatchObject({ status: 401 })

  // The first retry is the refresh, not a nonce replay: no nonce was adopted.
  expect(nonceOf(proofs[0])).toBeUndefined()
  expect(await getSession(DID)).toBeNull()
})
