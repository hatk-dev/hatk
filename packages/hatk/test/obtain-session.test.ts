import { beforeAll, beforeEach, afterEach, expect, test } from 'vitest'
import { initOAuth, obtainSession, ObtainSessionError, getClientJwks } from '../src/oauth/server.ts'
import { getSession, OAUTH_DDL } from '../src/oauth/db.ts'
import { parseJwt } from '../src/oauth/crypto.ts'
import { setupFixtureDatabase } from './fixture.ts'
import { runSQL } from '../src/database/db.ts'

// A session for another account, handed over by its authorization server
// outside the redirect flow — a group host creating a group for this app. The
// call has to look like one to the token endpoint (client auth, DPoP), and the
// session has to land where a login's would, bound to the same key.

const ISSUER = 'https://example.app'
const HOST = 'https://host.test'
const ENDPOINT = `${HOST}/xrpc/fyi.opensocial.provisionGroup`
const GROUP = 'did:plc:group'

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: `${ISSUER}/oauth-client-metadata.json`, client_name: 'test', scope: 'atproto' }],
} as any

type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
let seen: Seen[]
let realFetch: typeof fetch
/** What the endpoint answers, in order; the last one repeats. */
let answers: Array<{ status: number; body: unknown; headers?: Record<string, string> }>
/** The authorization server the group's PDS names. */
let authServer: string

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  await initOAuth(config, 'https://plc.test', 'ws://relay.test')
})

beforeEach(() => {
  seen = []
  authServer = HOST
  answers = [{ status: 200, body: session() }]
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url === ENDPOINT) {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      const a = answers.length > 1 ? answers.shift()! : answers[0]
      return new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json', ...a.headers },
      })
    }
    if (url === `https://plc.test/${GROUP}`) {
      return json({
        id: GROUP,
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: HOST }],
      })
    }
    if (url === `${HOST}/.well-known/oauth-protected-resource`) return json({ authorization_servers: [authServer] })
    if (url.endsWith('/.well-known/oauth-authorization-server'))
      return json({
        issuer: authServer,
        token_endpoint: `${authServer}/oauth/token`,
        authorization_endpoint: `${authServer}/oauth/authorize`,
      })
    return json({}, 404)
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function session(extra: Record<string, unknown> = {}) {
  return {
    did: GROUP,
    session: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'DPoP', expires_in: 900, sub: GROUP, ...extra },
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('calls the endpoint as the OAuth client, with DPoP, and stores the session for its sub', async () => {
  const out = await obtainSession(
    config,
    ENDPOINT,
    { handle: 'club.test' },
    { headers: { authorization: 'Bearer sa' } },
  )
  expect(out.did).toBe(GROUP)
  expect(out.response).toMatchObject({ did: GROUP })

  const [call] = seen
  expect(call.headers.authorization).toBe('Bearer sa')
  expect(call.body).toMatchObject({
    handle: 'club.test',
    client_id: `${ISSUER}/oauth-client-metadata.json`,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
  })
  // Addressed to the endpoint's authorization server, signed with the published key.
  const assertion = parseJwt(call.body.client_assertion as string)
  expect(assertion.payload.aud).toBe(HOST)
  expect(assertion.header.kid).toBe((getClientJwks().keys as any[])[0].kid)
  // A DPoP proof for this request, from the key sessions are bound to.
  const proof = parseJwt(call.headers.DPoP)
  expect(proof.payload).toMatchObject({ htm: 'POST', htu: ENDPOINT })

  const stored = (await getSession(GROUP))!
  expect(stored).toMatchObject({
    pds_endpoint: HOST,
    pds_auth_server: HOST,
    pds_token_endpoint: `${HOST}/oauth/token`,
    access_token: 'at-1',
    refresh_token: 'rt-1',
  })
})

test('remembers the scope it asked for and the scope it was granted', async () => {
  // A host may grant less than was asked; what tells a later refusal apart
  // from an outdated session is having both.
  answers = [{ status: 200, body: session({ scope: 'atproto repo:app.example.profile' }) }]
  await obtainSession(config, ENDPOINT, {
    handle: 'club.test',
    scope: 'atproto repo:app.example.profile repo:app.example.item',
  })
  expect(await getSession(GROUP)).toMatchObject({
    requested_scope: 'atproto repo:app.example.profile repo:app.example.item',
    granted_scope: 'atproto repo:app.example.profile',
  })
})

test('answers a nonce challenge once', async () => {
  answers = [
    { status: 400, body: { error: 'use_dpop_nonce' }, headers: { 'DPoP-Nonce': 'n1' } },
    { status: 200, body: session() },
  ]
  await obtainSession(config, ENDPOINT, {})
  expect(seen).toHaveLength(2)
  expect(parseJwt(seen[1].headers.DPoP).payload.nonce).toBe('n1')
})

test("passes the endpoint's refusal on by its error name", async () => {
  answers = [{ status: 400, body: { error: 'UntrustedApp', message: 'not an app this host provisions for' } }]
  const err = await obtainSession(config, ENDPOINT, {}).catch((e) => e)
  expect(err).toBeInstanceOf(ObtainSessionError)
  expect(err).toMatchObject({ error: 'UntrustedApp', message: 'not an app this host provisions for', status: 400 })
})

test('refuses an answer with no session in it', async () => {
  answers = [{ status: 200, body: { did: GROUP } }]
  const err = await obtainSession(config, ENDPOINT, {}).catch((e) => e)
  expect(err).toMatchObject({ error: 'NoSession' })
})

test("refuses a session for an account the endpoint's server does not serve", async () => {
  // The group's PDS names a different authorization server, so this endpoint
  // has no business issuing sessions for it.
  authServer = 'https://elsewhere.test'
  const err = await obtainSession(config, ENDPOINT, {}).catch((e) => e)
  expect(err).toMatchObject({ error: 'WrongAuthServer' })
})

test('accepts a bare token response as the whole body', async () => {
  answers = [{ status: 200, body: session().session }]
  const out = await obtainSession(config, ENDPOINT, {})
  expect(out.did).toBe(GROUP)
})
