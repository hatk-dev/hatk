import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createHandler, registerCoreHandlers } from '../src/server.ts'
import { callXrpc } from '../src/xrpc.ts'
import { initOAuth } from '../src/oauth/server.ts'
import { OAUTH_DDL, storeOAuthRequest, storeSession } from '../src/oauth/db.ts'
import {
  createAccountsCookie,
  createSessionCookie,
  getAccountsCookieName,
  getSessionCookieName,
  parseAccountsCookie,
} from '../src/oauth/session.ts'
import { ProxyError, ScopeMissingProxyError } from '../src/pds-proxy.ts'
import { registerLabelModule } from '../src/labels.ts'
import { defineFeed, registerFeed } from '../src/feeds.ts'
import { querySQL, runSQL, setRepoStatus } from '../src/database/db.ts'
import { setupFixtureDatabase, PUBLIC_COLLECTION } from './fixture.ts'

// With OAuth configured the server grows a second face: the metadata
// documents a PDS reads, the login/callback/token dance, the browser session
// and account-switching cookies, and the write endpoints that proxy to the
// user's PDS. The PDS itself is always a stubbed fetch here.

const pds = vi.hoisted(() => ({
  pdsCreateRecord: vi.fn(async () => ({ uri: 'at://did:plc:me/x/1', cid: 'c1' })),
  pdsPutRecord: vi.fn(async () => ({ uri: 'at://did:plc:me/x/rk', cid: 'c2' })),
  pdsDeleteRecord: vi.fn(async () => ({})),
  pdsApplyWrites: vi.fn(async () => ({ results: [] })),
  pdsUploadBlob: vi.fn(async () => ({ blob: { ref: { $link: 'bafyblob' } } })),
}))
vi.mock('../src/pds-proxy.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/pds-proxy.ts')>()),
  ...pds,
}))

const ISSUER = 'https://example.app'
const AUTH_SERVER = 'https://auth.test'
const AUTHORIZE = `${AUTH_SERVER}/authz/start`
const PAR = `${AUTH_SERVER}/authz/par`
const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: `${ISSUER}/oauth-client-metadata.json`, client_name: 'test', scope: 'atproto' }],
} as any

const ALICE = { did: 'did:plc:alice', handle: 'alice.test' }
const BOB = { did: 'did:plc:bob', handle: 'bob.test' }

const handler = () => createHandler({ collections: [PUBLIC_COLLECTION], publicDir: null, oauth: config, admins: [] })
const get = (path: string, headers?: Record<string, string>) =>
  handler()(new Request(`http://localhost${path}`, { headers }))
const post = (path: string, body: BodyInit | null, headers?: Record<string, string>, h = handler()) =>
  h(new Request(`http://localhost${path}`, { method: 'POST', body, headers }))

/** Cookie header carrying a session for `who`, plus (optionally) an accounts list. */
async function cookies(who: { did: string; handle: string } | null, accounts?: { did: string; handle: string }[]) {
  const parts: string[] = []
  if (who) parts.push(`${getSessionCookieName()}=${await createSessionCookie(who)}`)
  if (accounts) parts.push(`${getAccountsCookieName()}=${await createAccountsCookie(accounts)}`)
  return { cookie: parts.join('; ') }
}

/** Turn a response's Set-Cookie headers into a map of name → value (or '' when cleared). */
function setCookies(res: Response) {
  const out: Record<string, { value: string; cleared: boolean }> = {}
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(';')
    const [name, value] = pair.split('=')
    out[name] = { value, cleared: attrs.some((a) => a.trim() === 'Max-Age=0') }
  }
  return out
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) if (stmt.trim()) await runSQL(stmt)
  await initOAuth(config, 'http://plc.test', 'ws://relay.test')
  registerCoreHandlers([PUBLIC_COLLECTION], config)
  registerLabelModule('spam', {
    definition: { identifier: 'spam', severity: 'alert', blurs: 'content', defaultSetting: 'warn' },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  delete process.env.DEV_MODE
  ;(globalThis as any).__hatk_viewer = null
})

// --- metadata ---

test('the OAuth metadata documents are published from the issuer', async () => {
  const as = await (await get('/.well-known/oauth-authorization-server')).json()
  expect(as.issuer).toBe(ISSUER)
  expect(as.token_endpoint).toBe(`${ISSUER}/oauth/token`)

  const pr = await (await get('/.well-known/oauth-protected-resource')).json()
  expect(pr).toMatchObject({ resource: ISSUER, authorization_servers: [ISSUER], scopes_supported: ['atproto'] })

  const jwks = await (await get('/oauth/jwks')).json()
  expect(jwks.keys[0]).toMatchObject({ kty: 'EC', use: 'sig' })
  expect(jwks.keys[0].d).toBeUndefined()

  for (const path of ['/oauth/client-metadata.json', '/oauth-client-metadata.json']) {
    const meta = await (await get(path)).json()
    expect(meta.client_id).toBe(`${ISSUER}/oauth-client-metadata.json`)
  }
  const clientJwks = await (await get('/oauth/client-jwks.json')).json()
  expect(clientJwks.keys[0]).toMatchObject({ kty: 'EC', use: 'sig' })
  expect(clientJwks.keys[0].d).toBeUndefined()
})

// --- viewer resolution ---

test('a bad bearer token is ignored rather than failing the request, so the caller is simply anonymous', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const malformed = await get('/xrpc/dev.hatk.getPreferences', { authorization: 'DPoP not.a.jwt', dpop: 'x' })
  expect(malformed.status).toBe(401)
  const wrongScheme = await get('/xrpc/dev.hatk.getPreferences', { authorization: 'Bearer abc' })
  expect(wrongScheme.status).toBe(401)
  stdout.mockRestore()
})

test('a session cookie identifies the viewer for browser requests', async () => {
  const res = await get('/xrpc/dev.hatk.getPreferences', await cookies(ALICE))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ preferences: {} })
})

// --- login ---

test('login needs a handle unless creating an account', async () => {
  expect(await (await get('/oauth/login')).json()).toEqual({ error: 'handle required' })
})

test('a login whose discovery fails is reported as a 400 with the reason', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('nope', { status: 500 })),
  )
  const res = await get('/oauth/login?handle=alice.test')
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'resolveHandle failed: 500' })
})

test('a successful login redirects to the PDS authorize endpoint and drops any stale session', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url === 'http://plc.test/did:plc:tester') {
        return jsonResponse({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.test' }] })
      }
      if (url.includes('.well-known/oauth-protected-resource'))
        return jsonResponse({ authorization_servers: [AUTH_SERVER] })
      if (url.includes('.well-known/oauth-authorization-server')) {
        return jsonResponse({
          issuer: AUTH_SERVER,
          authorization_endpoint: AUTHORIZE,
          token_endpoint: `${AUTH_SERVER}/authz/token`,
          pushed_authorization_request_endpoint: PAR,
        })
      }
      if (url === PAR) return jsonResponse({ request_uri: 'urn:req:1', expires_in: 300 })
      return new Response(null, { status: 404 })
    }),
  )
  const res = await get('/oauth/login?handle=did:plc:tester', await cookies(ALICE))
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  expect(location.origin + location.pathname).toBe(AUTHORIZE)
  expect(location.searchParams.get('request_uri')).toBe('urn:req:1')
  expect(setCookies(res)[getSessionCookieName()].cleared).toBe(true)
})

// --- PAR / authorize / callback / token ---

test('PAR requires a DPoP proof and reports a bad one as a 400', async () => {
  const noDpop = await post('/oauth/par', 'client_id=x', { 'content-type': 'application/x-www-form-urlencoded' })
  expect(await noDpop.json()).toEqual({ error: 'DPoP header required' })

  const form = await post('/oauth/par', 'client_id=x', {
    'content-type': 'application/x-www-form-urlencoded',
    dpop: 'not-a-proof',
  })
  expect(form.status).toBe(400)
  const asJson = await post('/oauth/par', JSON.stringify({ client_id: 'x' }), { dpop: 'not-a-proof' })
  expect(asJson.status).toBe(400)
})

test('authorize needs a live request_uri and then redirects to the stored PDS endpoint', async () => {
  expect(await (await get('/oauth/authorize')).json()).toEqual({ error: 'request_uri required' })
  expect(await (await get('/oauth/authorize?request_uri=urn:nope')).json()).toEqual({
    error: 'Invalid or expired request_uri',
  })

  await storeOAuthRequest('urn:ours:1', {
    clientId: 'client',
    redirectUri: 'https://client.test/cb',
    codeChallenge: 'cc',
    dpopJkt: 'jkt',
    pdsRequestUri: 'urn:pds:1',
    pdsAuthServer: AUTH_SERVER,
    pdsAuthorizationEndpoint: AUTHORIZE,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  })
  const res = await get('/oauth/authorize?request_uri=urn:ours:1')
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  expect(location.origin + location.pathname).toBe(AUTHORIZE)
  expect(location.searchParams.get('request_uri')).toBe('urn:pds:1')
})

test("a callback carrying our own issuer is the SPA's and is left to the client app", async () => {
  expect((await get(`/oauth/callback?iss=${encodeURIComponent(ISSUER)}&code=x`)).status).toBe(404)
})

test('a PDS error on callback sends the browser home with the error and no session', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const res = await get('/oauth/callback?error=access_denied&error_description=user%20said%20no&state=unknown')
  stdout.mockRestore()
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/?error=access_denied&error_description=user+said+no')
  expect(setCookies(res)[getSessionCookieName()].cleared).toBe(true)
})

test('a callback without a code is rejected', async () => {
  expect(await (await get('/oauth/callback?state=s')).json()).toEqual({ error: 'Missing code' })
})

test('a callback whose state matches no pending request is a 4xx, not a server error', async () => {
  // A login tab left open past the request's expiry, or a back-button replay of
  // a completed login, lands here. Nothing is wrong with the server.
  const res = await get('/oauth/callback?code=abc&state=nothing-pending')
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'No matching authorization request found' })
})

test('the token endpoint requires DPoP and answers OAuth errors in the standard shape', async () => {
  const noDpop = await post('/oauth/token', 'grant_type=authorization_code', {
    'content-type': 'application/x-www-form-urlencoded',
  })
  expect(noDpop.status).toBe(400)
  expect(await noDpop.json()).toEqual({ error: 'invalid_request', error_description: 'DPoP header required' })

  const noGrant = await post('/oauth/token', JSON.stringify({}), { dpop: 'x' })
  expect(noGrant.status).toBe(400)
  expect(await noGrant.json()).toEqual({ error: 'invalid_request', error_description: 'grant_type is required' })

  const badGrant = await post('/oauth/token', 'grant_type=password', {
    'content-type': 'application/x-www-form-urlencoded',
    dpop: 'x',
  })
  expect(await badGrant.json()).toMatchObject({ error: 'unsupported_grant_type' })

  // A failure that is not an OAuthError (here: an unparseable DPoP proof on a
  // real grant) is not dressed up as one.
  const crashed = await post('/oauth/token', JSON.stringify({ grant_type: 'authorization_code' }), { dpop: 'x' })
  expect(crashed.status).toBe(500)
})

// --- dev login + account switching ---

test('the dev login route does not exist outside dev mode', async () => {
  expect((await get('/__dev/login?did=did:plc:x')).status).toBe(404)
})

test('in dev mode a session can be minted for any DID and shows up as a switchable account', async () => {
  process.env.DEV_MODE = '1'
  expect(await (await get('/__dev/login')).json()).toEqual({ error: 'did required' })

  await setRepoStatus('did:plc:dev', 'active', undefined, { handle: 'dev.test' })
  const login = await get('/__dev/login?did=did:plc:dev')
  expect(await login.json()).toEqual({ ok: true })
  const jar = setCookies(login)
  const cookie = Object.entries(jar)
    .map(([k, v]) => `${k}=${v.value}`)
    .join('; ')

  const accounts = await (await get('/auth/accounts', { cookie })).json()
  // In dev every remembered account is switchable, grant or no grant.
  expect(accounts).toEqual({
    accounts: [{ did: 'did:plc:dev', handle: 'dev.test', available: true }],
    active: 'did:plc:dev',
  })
})

test('an anonymous browser has no accounts', async () => {
  expect(await (await get('/auth/accounts')).json()).toEqual({ accounts: [], active: null })
})

test('a session without an accounts cookie is adopted into the list and the cookie is written back', async () => {
  const res = await get('/auth/accounts', await cookies(ALICE))
  const body = await res.json()
  // No server-side grant behind this session, so it is listed but not switchable.
  expect(body).toEqual({ accounts: [{ ...ALICE, available: false }], active: ALICE.did })
  const written = setCookies(res)[getAccountsCookieName()]
  expect(written.cleared).toBe(false)
  const healed = await parseAccountsCookie(
    new Request('http://x', { headers: { cookie: `${getAccountsCookieName()}=${written.value}` } }),
  )
  expect(healed).toEqual([ALICE])
})

test('switching validates the request and refuses accounts the browser never signed into', async () => {
  const h = await cookies(ALICE, [ALICE])
  expect(await (await post('/auth/switch', 'garbage', h)).json()).toEqual({ error: 'Invalid JSON body' })
  expect(await (await post('/auth/switch', JSON.stringify({}), h)).json()).toEqual({ error: 'did required' })
  const forbidden = await post('/auth/switch', JSON.stringify({ did: BOB.did }), h)
  expect(forbidden.status).toBe(403)
})

test('switching to an account whose grant is gone drops it from the list', async () => {
  const res = await post('/auth/switch', JSON.stringify({ did: BOB.did }), await cookies(ALICE, [ALICE, BOB]))
  expect(res.status).toBe(409)
  const jar = setCookies(res)[getAccountsCookieName()]
  expect(jar.cleared).toBe(false)
  const remaining = await parseAccountsCookie(
    new Request('http://x', { headers: { cookie: `${getAccountsCookieName()}=${jar.value}` } }),
  )
  expect(remaining).toEqual([ALICE])

  // When it was the only account the cookie is cleared instead.
  const last = await post('/auth/switch', JSON.stringify({ did: BOB.did }), await cookies(null, [BOB]))
  expect(setCookies(last)[getAccountsCookieName()].cleared).toBe(true)
})

test('switching to an account with a stored grant issues a fresh session with the current handle', async () => {
  await storeSession(BOB.did, {
    pdsEndpoint: 'https://pds.test',
    pdsAuthServer: AUTH_SERVER,
    accessToken: 'a',
    refreshToken: 'r',
    dpopJkt: 'j',
  })
  await setRepoStatus(BOB.did, 'active', undefined, { handle: 'bob-renamed.test' })

  const res = await post('/auth/switch', JSON.stringify({ did: BOB.did }), await cookies(ALICE, [ALICE, BOB]))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ did: BOB.did, handle: 'bob-renamed.test' })
  const jar = setCookies(res)
  expect(jar[getSessionCookieName()].cleared).toBe(false)
  expect(jar[getAccountsCookieName()].cleared).toBe(false)

  // The new session cookie really is Bob's.
  const who = await get('/auth/accounts', { cookie: `${getSessionCookieName()}=${jar[getSessionCookieName()].value}` })
  expect((await who.json()).active).toBe(BOB.did)
  // And the switch list now knows the new handle, with Bob switchable.
  const list = await (
    await get('/auth/accounts', { cookie: `${getAccountsCookieName()}=${jar[getAccountsCookieName()].value}` })
  ).json()
  expect(list.accounts).toContainEqual({ did: BOB.did, handle: 'bob-renamed.test', available: true })
})

test('logging out clears the session and forgets that account, keeping the others', async () => {
  const anonymous = await post('/auth/logout', null)
  expect(anonymous.status).toBe(200)
  expect(Object.keys(setCookies(anonymous))).toEqual([getSessionCookieName()])

  const res = await post('/auth/logout', null, await cookies(ALICE, [ALICE, BOB]))
  const jar = setCookies(res)
  expect(jar[getSessionCookieName()].cleared).toBe(true)
  const remaining = await parseAccountsCookie(
    new Request('http://x', {
      headers: { cookie: `${getAccountsCookieName()}=${jar[getAccountsCookieName()].value}` },
    }),
  )
  expect(remaining).toEqual([BOB])

  // The last account out clears the list entirely.
  const last = await post('/auth/logout', null, await cookies(ALICE, [ALICE]))
  expect(setCookies(last)[getAccountsCookieName()].cleared).toBe(true)
})

// --- proxied writes ---

test('writes require a viewer and are proxied to the PDS as that viewer', async () => {
  expect((await post('/xrpc/dev.hatk.createRecord', '{}')).status).toBe(401)
  expect((await post('/xrpc/dev.hatk.deleteRecord', '{}')).status).toBe(401)
  expect((await post('/xrpc/dev.hatk.putRecord', '{}')).status).toBe(401)
  expect((await post('/xrpc/dev.hatk.uploadBlob', new Uint8Array([1]))).status).toBe(401)

  const h = await cookies(ALICE)
  const created = await post(
    '/xrpc/dev.hatk.createRecord',
    JSON.stringify({ collection: 'xyz.c', record: { a: 1 } }),
    h,
  )
  expect(await created.json()).toEqual({ uri: 'at://did:plc:me/x/1', cid: 'c1' })
  expect(pds.pdsCreateRecord).toHaveBeenCalledWith(config, ALICE, { collection: 'xyz.c', record: { a: 1 } })

  await post('/xrpc/dev.hatk.deleteRecord', JSON.stringify({ collection: 'xyz.c', rkey: 'r' }), h)
  expect(pds.pdsDeleteRecord).toHaveBeenCalledWith(config, ALICE, { collection: 'xyz.c', rkey: 'r' })

  await post('/xrpc/dev.hatk.putRecord', JSON.stringify({ collection: 'xyz.c', rkey: 'r', record: {} }), h)
  expect(pds.pdsPutRecord).toHaveBeenCalledWith(config, ALICE, { collection: 'xyz.c', rkey: 'r', record: {} })

  const blob = await post('/xrpc/dev.hatk.uploadBlob', new Uint8Array([7, 8]), { ...h, 'content-type': 'image/png' })
  expect(await blob.json()).toEqual({ blob: { ref: { $link: 'bafyblob' } } })
  expect(pds.pdsUploadBlob).toHaveBeenCalledWith(config, ALICE, new Uint8Array([7, 8]), 'image/png')
})

test('a PDS refusal is relayed with its status, and a scope refusal signs the browser out', async () => {
  const h = await cookies(ALICE)
  pds.pdsCreateRecord.mockRejectedValueOnce(new ProxyError(400, 'InvalidRecord'))
  const refused = await post('/xrpc/dev.hatk.createRecord', '{}', h)
  expect(refused.status).toBe(400)
  expect(await refused.json()).toEqual({ error: 'InvalidRecord', handle: ALICE.handle })

  for (const [route, fn] of [
    ['deleteRecord', pds.pdsDeleteRecord],
    ['putRecord', pds.pdsPutRecord],
    ['uploadBlob', pds.pdsUploadBlob],
  ] as const) {
    fn.mockRejectedValueOnce(new ScopeMissingProxyError())
    const res = await post(`/xrpc/dev.hatk.${route}`, route === 'uploadBlob' ? new Uint8Array([1]) : '{}', h)
    expect(res.status, route).toBe(401)
    expect(await res.json()).toEqual({ error: 'ScopeMissingError', handle: ALICE.handle })
    expect(setCookies(res)[getSessionCookieName()].cleared).toBe(true)
  }

  // Anything that is not a ProxyError is a plain 500, on every write route.
  for (const [route, fn] of [
    ['createRecord', pds.pdsCreateRecord],
    ['deleteRecord', pds.pdsDeleteRecord],
    ['putRecord', pds.pdsPutRecord],
    ['uploadBlob', pds.pdsUploadBlob],
  ] as const) {
    fn.mockRejectedValueOnce(new Error('socket hang up'))
    const crashed = await post(`/xrpc/dev.hatk.${route}`, route === 'uploadBlob' ? new Uint8Array([1]) : '{}', h)
    expect(crashed.status, route).toBe(500)
    expect(await crashed.json()).toEqual({ error: 'socket hang up' })
  }
})

// --- in-process core handlers (used by SSR through callXrpc) ---

test('the in-process write and preference handlers require a viewer', async () => {
  for (const nsid of [
    'dev.hatk.getPreferences',
    'dev.hatk.putPreference',
    'dev.hatk.createRecord',
    'dev.hatk.deleteRecord',
    'dev.hatk.putRecord',
    'dev.hatk.uploadBlob',
    'dev.hatk.applyWrites',
    'dev.hatk.push.registerToken',
    'dev.hatk.push.unregisterToken',
    'dev.hatk.createReport',
  ]) {
    await expect(callXrpc(nsid, {}, {}), nsid).rejects.toThrow('Authentication required')
  }
})

test('the in-process read handlers mirror their HTTP counterparts', async () => {
  await expect(callXrpc('dev.hatk.getFeed')).rejects.toThrow('Missing feed parameter')
  await expect(callXrpc('dev.hatk.getFeed', { feed: 'nope' })).rejects.toThrow('Unknown feed: nope')

  registerFeed(
    'inproc',
    defineFeed({
      collection: PUBLIC_COLLECTION,
      label: 'In process',
      generate: async (ctx) => ctx.ok({ uris: [`viewer:${ctx.viewer?.did ?? 'anon'}`] }),
    }),
  )
  ;(globalThis as any).__hatk_viewer = ALICE
  expect(await callXrpc('dev.hatk.getFeed', { feed: 'inproc' })).toEqual({ uris: [`viewer:${ALICE.did}`] })
  expect((await callXrpc('dev.hatk.describeFeeds')).feeds).toContainEqual({ name: 'inproc', label: 'In process' })

  const { collections } = await callXrpc('dev.hatk.describeCollections')
  expect(collections).toEqual([
    {
      collection: PUBLIC_COLLECTION,
      columns: expect.arrayContaining([{ name: 'text', originalName: 'text', type: 'TEXT', required: true }]),
    },
  ])
  expect((await callXrpc('dev.hatk.describeLabels')).definitions.map((d: any) => d.identifier)).toEqual(['spam'])
})

test('in-process preferences validate the body and persist per viewer', async () => {
  ;(globalThis as any).__hatk_viewer = ALICE
  await expect(callXrpc('dev.hatk.putPreference', {}, { value: 1 })).rejects.toThrow('Missing or invalid key')
  await expect(callXrpc('dev.hatk.putPreference', {}, { key: 'k' })).rejects.toThrow('Missing value')
  expect(await callXrpc('dev.hatk.putPreference', {}, { key: 'lang', value: 'en' })).toEqual({ success: true })
  expect(await callXrpc('dev.hatk.getPreferences')).toEqual({ preferences: { lang: 'en' } })
})

test('in-process writes proxy to the PDS with the viewer and input', async () => {
  ;(globalThis as any).__hatk_viewer = ALICE
  await callXrpc('dev.hatk.createRecord', {}, { collection: 'xyz.c', record: {} })
  expect(pds.pdsCreateRecord).toHaveBeenCalledWith(config, ALICE, { collection: 'xyz.c', record: {} })
  await callXrpc('dev.hatk.deleteRecord', {}, { collection: 'xyz.c', rkey: 'r' })
  expect(pds.pdsDeleteRecord).toHaveBeenCalledWith(config, ALICE, { collection: 'xyz.c', rkey: 'r' })
  await callXrpc('dev.hatk.putRecord', {}, { collection: 'xyz.c', rkey: 'r', record: {} })
  expect(pds.pdsPutRecord).toHaveBeenCalledWith(config, ALICE, { collection: 'xyz.c', rkey: 'r', record: {} })
  await callXrpc('dev.hatk.applyWrites', {}, { writes: [] })
  expect(pds.pdsApplyWrites).toHaveBeenCalledWith(config, ALICE, { writes: [] })
  await callXrpc('dev.hatk.uploadBlob', {}, new Uint8Array([1]))
  expect(pds.pdsUploadBlob).toHaveBeenCalledWith(config, ALICE, new Uint8Array([1]), 'application/octet-stream')
})

test('push tokens are validated, stored per viewer and removable', async () => {
  ;(globalThis as any).__hatk_viewer = ALICE
  await expect(callXrpc('dev.hatk.push.registerToken', {}, {})).rejects.toThrow('Missing or invalid token')
  await expect(callXrpc('dev.hatk.push.registerToken', {}, { token: 't', platform: 'pager' })).rejects.toThrow(
    'Invalid platform',
  )
  await expect(callXrpc('dev.hatk.push.unregisterToken', {}, {})).rejects.toThrow('Missing or invalid token')

  expect(await callXrpc('dev.hatk.push.registerToken', {}, { token: 'tok1' })).toEqual({ success: true })
  await callXrpc('dev.hatk.push.registerToken', {}, { token: 'tok2', platform: 'fcm' })
  const rows = (await querySQL(`SELECT token, platform FROM _push_tokens WHERE did = $1 ORDER BY token`, [
    ALICE.did,
  ])) as any[]
  expect(rows).toEqual([
    { token: 'tok1', platform: 'apns' },
    { token: 'tok2', platform: 'fcm' },
  ])

  expect(await callXrpc('dev.hatk.push.unregisterToken', {}, { token: 'tok1' })).toEqual({ success: true })
  expect(await querySQL(`SELECT token FROM _push_tokens WHERE did = $1`, [ALICE.did])).toEqual([{ token: 'tok2' }])
})

test('reports are validated against the known labels and filed with the subject DID', async () => {
  ;(globalThis as any).__hatk_viewer = ALICE
  const subject = { uri: `at://${BOB.did}/${PUBLIC_COLLECTION}/1` }
  await expect(callXrpc('dev.hatk.createReport', {}, { label: 'spam' })).rejects.toThrow('Missing subject')
  await expect(callXrpc('dev.hatk.createReport', {}, { subject })).rejects.toThrow('Missing or invalid label')
  await expect(callXrpc('dev.hatk.createReport', {}, { subject, label: 'nope' })).rejects.toThrow('Unknown label: nope')
  await expect(
    callXrpc('dev.hatk.createReport', {}, { subject, label: 'spam', reason: 'x'.repeat(2001) }),
  ).rejects.toThrow('2000 characters')
  await expect(
    callXrpc('dev.hatk.createReport', {}, { subject: { uri: 'https://not.at' }, label: 'spam' }),
  ).rejects.toThrow('Invalid subject URI')
  await expect(callXrpc('dev.hatk.createReport', {}, { subject: { other: 1 }, label: 'spam' })).rejects.toThrow(
    'Subject must have uri or did',
  )

  const byUri = await callXrpc('dev.hatk.createReport', {}, { subject, label: 'spam', reason: 'ugh' })
  expect(byUri).toMatchObject({ subject, label: 'spam', reason: 'ugh', reportedBy: ALICE.did })
  expect(typeof byUri.id).toBe('number')

  const byDid = await callXrpc('dev.hatk.createReport', {}, { subject: { did: BOB.did }, label: 'spam' })
  expect(byDid.reason).toBeNull()

  const rows = (await querySQL(`SELECT subject_uri, subject_did FROM _reports ORDER BY id`)) as any[]
  expect(rows).toEqual([
    { subject_uri: subject.uri, subject_did: BOB.did },
    { subject_uri: `at://${BOB.did}`, subject_did: BOB.did },
  ])
})
