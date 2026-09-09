import { beforeAll, beforeEach, expect, test } from 'vitest'
import { buildAuthorizeRedirect, handleCallback, initOAuth, serverLogin } from '../src/oauth/server.ts'
import { OAUTH_DDL, getSession, storeOAuthRequest } from '../src/oauth/db.ts'
import { querySQL, runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// An auth server publishes where its endpoints live in
// /.well-known/oauth-authorization-server. Rebuilding those URLs as
// `${issuer}/oauth/authorize` instead only ever agreed with bsky.social and the
// reference PDS by coincidence: anyone else serving them from other paths got a
// PAR that worked followed by a redirect into a 404. These tests hold the
// advertised paths, not the conventional ones.

const ISSUER = 'https://example.app'
const AUTH_SERVER = 'https://auth.test'

// Deliberately nothing like the paths that used to be hardcoded.
const AUTHORIZE = `${AUTH_SERVER}/authz/start`
const TOKEN = `${AUTH_SERVER}/authz/token`
const PAR = `${AUTH_SERVER}/authz/par`

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: `${ISSUER}/oauth-client-metadata.json`, client_name: 'test', scope: 'atproto' }],
} as any

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** Stub an auth server that serves every endpoint from a path of its own choosing. */
function stubAuthServer(options: { authorizationEndpoint?: string; onFetch?: (url: string, init?: any) => void }) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    options.onFetch?.(url, init)

    if (url.includes('.well-known/oauth-protected-resource')) {
      return jsonResponse({ authorization_servers: [AUTH_SERVER] })
    }
    if (url.includes('.well-known/oauth-authorization-server')) {
      return jsonResponse({
        issuer: AUTH_SERVER,
        authorization_endpoint: options.authorizationEndpoint ?? AUTHORIZE,
        token_endpoint: TOKEN,
        pushed_authorization_request_endpoint: PAR,
      })
    }
    if (url === PAR) return jsonResponse({ request_uri: 'urn:req:1', expires_in: 300 })
    if (url === TOKEN) {
      return jsonResponse({ access_token: 'at', refresh_token: 'rt', sub: 'did:plc:tester', expires_in: 3600 })
    }
    return jsonResponse({})
  }) as any
  return () => {
    globalThis.fetch = realFetch
  }
}

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  await initOAuth(config, 'http://plc.test', 'ws://relay.test')
})

beforeEach(async () => {
  await runSQL('DELETE FROM _oauth_requests')
  await runSQL('DELETE FROM _oauth_sessions')
})

test('login goes to the advertised authorization endpoint', async () => {
  const seen: string[] = []
  const restore = stubAuthServer({ onFetch: (url) => seen.push(url) })
  let redirect: string
  try {
    redirect = await serverLogin(config, '', { prompt: 'create', pds: 'pds.test' })
  } finally {
    restore()
  }

  const url = new URL(redirect)
  expect(url.origin + url.pathname).toBe(AUTHORIZE)
  expect(url.searchParams.get('request_uri')).toBe('urn:req:1')
  expect(url.searchParams.get('client_id')).toBe(`${ISSUER}/oauth-client-metadata.json`)
  // And the PAR itself went to the advertised path, not `${issuer}/oauth/par`.
  expect(seen).toContain(PAR)
})

test('the advertised endpoints are stored for the requests that follow', async () => {
  const restore = stubAuthServer({})
  try {
    await serverLogin(config, '', { prompt: 'create', pds: 'pds.test' })
  } finally {
    restore()
  }

  // The callback and the refresh happen on later requests with nothing but this
  // row to go on, so the endpoints have to outlive the metadata fetch.
  const [row] = (await querySQL('SELECT * FROM _oauth_requests', [])) as any[]
  expect(row.pds_authorization_endpoint).toBe(AUTHORIZE)
  expect(row.pds_token_endpoint).toBe(TOKEN)
})

test('an authorization endpoint with its own query keeps it', async () => {
  const restore = stubAuthServer({ authorizationEndpoint: `${AUTH_SERVER}/authz?tenant=grain` })
  let redirect: string
  try {
    redirect = await serverLogin(config, '', { prompt: 'create', pds: 'pds.test' })
  } finally {
    restore()
  }

  // RFC 6749 §3.1 allows it, and `${endpoint}?${params}` would have produced a
  // second `?` and dropped the tenant.
  const url = new URL(redirect)
  expect(url.searchParams.get('tenant')).toBe('grain')
  expect(url.searchParams.get('request_uri')).toBe('urn:req:1')
})

test('the code is exchanged at the advertised token endpoint', async () => {
  const seen: string[] = []
  const restore = stubAuthServer({ onFetch: (url) => seen.push(url) })
  try {
    await serverLogin(config, '', { prompt: 'create', pds: 'pds.test' })
    const [row] = (await querySQL('SELECT pds_state FROM _oauth_requests', [])) as any[]
    await handleCallback(config, 'auth-code', row.pds_state, AUTH_SERVER)
  } finally {
    restore()
  }

  expect(seen).toContain(TOKEN)
  expect(seen.some((url) => url.endsWith('/oauth/token'))).toBe(false)

  // The session keeps it too, so refreshing a year from now doesn't guess.
  const session = await getSession('did:plc:tester')
  expect(session.pds_token_endpoint).toBe(TOKEN)
})

test('requests that predate the stored endpoints still redirect', async () => {
  // Rows written by an older build have no endpoint columns; they fall back to
  // the paths this used to hardcode rather than failing an in-flight login.
  await storeOAuthRequest('urn:ietf:params:oauth:request_uri:legacy', {
    clientId: `${ISSUER}/oauth-client-metadata.json`,
    redirectUri: `${ISSUER}/oauth/callback`,
    codeChallenge: 'challenge',
    dpopJkt: 'jkt',
    pdsRequestUri: 'urn:req:legacy',
    pdsAuthServer: AUTH_SERVER,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })

  const [row] = (await querySQL('SELECT * FROM _oauth_requests', [])) as any[]
  const redirect = new URL(buildAuthorizeRedirect(config, row))
  expect(redirect.origin + redirect.pathname).toBe(`${AUTH_SERVER}/oauth/authorize`)
  expect(redirect.searchParams.get('request_uri')).toBe('urn:req:legacy')
})
