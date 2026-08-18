import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { pdsXrpc, ScopeMissingProxyError } from '../src/pds-proxy.ts'
import { initOAuth } from '../src/oauth/server.ts'
import { OAUTH_DDL, getSession, storeSession } from '../src/oauth/db.ts'
import { runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// A PDS refusing a call for want of a scope and a PDS refusing an expired token
// can say the same word. The reference answers ScopeMissingError and is handled
// directly; pds.js answers InvalidToken for a scope its permissioned space
// endpoints refuse, which reads as expiry until a refresh rules expiry out.
//
// A token minted seconds ago cannot be expired, so a refusal that survives a
// successful refresh is about the grant. Told apart, it becomes a prompt to
// authorize again — the only thing that can actually add the scope. Left alone,
// it was an opaque 500 the user could do nothing about.

const DID = 'did:plc:scopetest'
const PDS = 'https://pds.example.com'
const ISSUER = 'https://example.app'

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: `${ISSUER}/oauth-client-metadata.json`, client_name: 'test', scope: 'atproto' }],
} as any

/** Queue one response per fetch, in order. */
function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const calls: string[] = []
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input))
      const next = responses[Math.min(i++, responses.length - 1)]
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

const refused = { status: 401, body: { error: 'InvalidToken', message: 'Scope does not permit' } }
const refreshed = {
  status: 200,
  body: { access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 3600 },
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
    accessToken: 'stale-token',
    refreshToken: 'a-refresh-token',
    dpopJkt: 'jkt',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a refusal surviving a refresh asks the user to authorize again', async () => {
  // call → refused, refresh → ok, retry → refused again.
  stubFetchSequence([refused, refreshed, refused])

  await expect(pdsXrpc(config, { did: DID }, 'com.atproto.space.listRepos')).rejects.toBeInstanceOf(
    ScopeMissingProxyError,
  )

  // The session is dropped, so the next request sends the user through
  // authorization rather than replaying a grant that cannot serve them.
  expect(await getSession(DID)).toBeNull()
})

test('a genuinely expired token still just refreshes', async () => {
  stubFetchSequence([refused, refreshed, { status: 200, body: { repos: [] } }])

  await expect(pdsXrpc(config, { did: DID }, 'com.atproto.space.listRepos')).resolves.toEqual({
    repos: [],
  })

  expect(await getSession(DID)).not.toBeNull()
})

test('a scope refusal the PDS names outright is still handled first', async () => {
  // The reference PDS's spelling, which never reaches the refresh at all.
  stubFetchSequence([{ status: 403, body: { error: 'ScopeMissingError' } }])

  await expect(pdsXrpc(config, { did: DID }, 'com.atproto.space.listRepos')).rejects.toBeInstanceOf(
    ScopeMissingProxyError,
  )
  expect(await getSession(DID)).toBeNull()
})

test('an unrelated failure is left alone', async () => {
  // Not a token error, so no refresh and no session deletion — the caller sees
  // the PDS's own answer.
  stubFetchSequence([{ status: 400, body: { error: 'InvalidRequest', message: 'bad space' } }])

  await expect(pdsXrpc(config, { did: DID }, 'com.atproto.space.listRepos')).rejects.toMatchObject({
    status: 400,
  })
  expect(await getSession(DID)).not.toBeNull()
})
