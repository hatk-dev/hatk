import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

// Handle resolution asks DNS before any PDS; no test here reaches a resolver.
vi.mock('node:dns/promises', () => ({
  resolveTxt: async () => {
    throw new Error('ENOTFOUND')
  },
}))
import {
  buildAuthorizeRedirect,
  getAuthServerMetadata,
  getProtectedResourceMetadata,
  handleCallback,
  handlePar,
  initOAuth,
  serverLogin,
} from '../src/oauth/server.ts'
import { OAUTH_DDL, getSession, storeOAuthRequest } from '../src/oauth/db.ts'
import { createDpopProof } from '../src/oauth/dpop.ts'
import { computeJwkThumbprint, generateKeyPair, parseJwt } from '../src/oauth/crypto.ts'
import { querySQL, runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// The client-facing half of the authorization server: a browser client PARs
// to us, we PAR to the user's PDS on its behalf, the PDS sends the user back
// to our callback, and we exchange that code for a PDS session before minting
// a code of our own for the client. Every hop talks to a stubbed network.

const ISSUER = 'https://example.app'
const CLIENT_ID = `${ISSUER}/oauth-client-metadata.json`
const CLIENT_REDIRECT = `${ISSUER}/oauth/callback`
const PAR_URL = `${ISSUER}/oauth/par`

const PLC = 'http://plc.test'
const RELAY = 'ws://relay.test'
const PDS = 'https://pds.example.com'
const AUTH = 'https://auth.example.com'
const AUTHORIZE = `${AUTH}/authz`
const TOKEN = `${AUTH}/tok`
const PDS_PAR = `${AUTH}/pushed`
const DID = 'did:plc:alice'

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: CLIENT_ID, client_name: 'test', scope: 'atproto', redirect_uris: [CLIENT_REDIRECT] }],
} as any

interface Call {
  url: string
  init?: RequestInit
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** The form body a call carried. */
const formOf = (call: Call) => new URLSearchParams(String(call.init?.body))
/** The DPoP proof header a call carried. */
const proofOf = (call: Call) => (call.init!.headers as Record<string, string>).DPoP

/**
 * A network where the handle resolves, the DID lives on PDS, PDS points at
 * AUTH, and AUTH serves its endpoints from unconventional paths. `override`
 * gets first refusal on every URL.
 */
function stubNetwork(
  override: (url: string, init: RequestInit | undefined, n: number) => Response | undefined = () => undefined,
) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      const n = (counts.get(url) ?? 0) + 1
      counts.set(url, n)
      const custom = override(url, init, n)
      if (custom) return custom

      if (url.startsWith('http://relay.test/xrpc/com.atproto.identity.resolveHandle')) return json({ did: DID })
      if (url === `${PLC}/${DID}`) {
        return json({
          service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
        })
      }
      if (url === `${PDS}/.well-known/oauth-protected-resource`) return json({ authorization_servers: [AUTH] })
      if (url === `${AUTH}/.well-known/oauth-authorization-server`) {
        return json({
          issuer: AUTH,
          authorization_endpoint: AUTHORIZE,
          token_endpoint: TOKEN,
          pushed_authorization_request_endpoint: PDS_PAR,
        })
      }
      if (url === PDS_PAR) return json({ request_uri: 'urn:pds:req', expires_in: 300 })
      if (url === TOKEN) return json({ access_token: 'at', refresh_token: 'rt', sub: DID, expires_in: 3600 })
      return json({ error: 'unstubbed' }, 404)
    }),
  )
  return calls
}

let clientPriv: JsonWebKey
let clientPub: JsonWebKey
let clientJkt: string

/** A fresh browser-client DPoP proof for our PAR endpoint. */
const clientProof = () => createDpopProof(clientPriv, clientPub, 'POST', PAR_URL)

const parBody = (extra: Record<string, string> = {}) => ({
  client_id: CLIENT_ID,
  redirect_uri: CLIENT_REDIRECT,
  code_challenge: 'client-challenge',
  code_challenge_method: 'S256',
  state: 'client-state',
  scope: 'atproto',
  login_hint: 'alice.test',
  ...extra,
})

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  await initOAuth(config, PLC, RELAY)
  const kp = await generateKeyPair()
  clientPriv = kp.privateJwk
  clientPub = kp.publicJwk
  clientJkt = await computeJwkThumbprint(clientPub)
})

beforeEach(async () => {
  await runSQL('DELETE FROM _oauth_requests')
  await runSQL('DELETE FROM _oauth_sessions')
  await runSQL('DELETE FROM _oauth_codes')
  await runSQL('DELETE FROM _oauth_dpop_jtis')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('metadata documents', () => {
  test('the auth server document advertises our endpoints and DPoP', () => {
    const meta = getAuthServerMetadata(ISSUER, config)
    expect(meta).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
      jwks_uri: `${ISSUER}/oauth/jwks`,
      scopes_supported: ['atproto'],
      dpop_signing_alg_values_supported: ['ES256'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    })
  })

  test('the protected resource document names ourselves as the auth server', () => {
    expect(getProtectedResourceMetadata(ISSUER, config)).toEqual({
      resource: ISSUER,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['atproto'],
    })
  })
})

describe('handlePar', () => {
  test('a login by handle resolves it, discovers the PDS, and pushes to its auth server', async () => {
    const calls = stubNetwork()

    const result = await handlePar(config, parBody(), await clientProof(), PAR_URL)

    expect(result.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/)
    expect(result.expires_in).toBe(600)

    const urls = calls.map((c) => c.url)
    // The well-known lookup comes first and finds nothing for a .test name.
    expect(urls.some((u) => u.includes('com.atproto.identity.resolveHandle?handle=alice.test'))).toBe(true)
    expect(urls).toContain(`${PLC}/${DID}`)
    expect(urls).toContain(PDS_PAR)

    // The PDS-facing PAR is on our behalf, as the confidential client we are.
    const par = formOf(calls.find((c) => c.url === PDS_PAR)!)
    expect(par.get('client_id')).toBe(CLIENT_ID)
    expect(par.get('redirect_uri')).toBe(`${ISSUER}/oauth/callback`)
    expect(par.get('response_type')).toBe('code')
    expect(par.get('code_challenge_method')).toBe('S256')
    expect(par.get('scope')).toBe('atproto')
    expect(par.get('login_hint')).toBe('alice.test')
    expect(par.get('prompt')).toBeNull()
    expect(par.get('client_assertion')).toBeTruthy()

    // Everything the later requests need was written down.
    const [row] = (await querySQL('SELECT * FROM _oauth_requests', [])) as any[]
    expect(row).toMatchObject({
      request_uri: result.request_uri,
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_REDIRECT,
      state: 'client-state',
      code_challenge: 'client-challenge',
      dpop_jkt: clientJkt,
      pds_request_uri: 'urn:pds:req',
      pds_auth_server: AUTH,
      pds_authorization_endpoint: AUTHORIZE,
      pds_token_endpoint: TOKEN,
      pds_endpoint: PDS,
      pds_state: par.get('state'),
      did: DID,
      login_hint: 'alice.test',
    })
    expect(row.pds_code_verifier).toBeTruthy()

    // And the authorize hop goes where the auth server said, carrying the PDS's request_uri.
    const redirect = new URL(buildAuthorizeRedirect(config, row))
    expect(redirect.origin + redirect.pathname).toBe(AUTHORIZE)
    expect(redirect.searchParams.get('request_uri')).toBe('urn:pds:req')
    expect(redirect.searchParams.get('client_id')).toBe(CLIENT_ID)
  })

  test('a login_hint that is already a DID skips handle resolution', async () => {
    const calls = stubNetwork()

    await handlePar(config, parBody({ login_hint: DID }), await clientProof(), PAR_URL)

    expect(calls.some((c) => c.url.includes('resolveHandle'))).toBe(false)
    expect(calls.some((c) => c.url === `${PLC}/${DID}`)).toBe(true)
  })

  test('an unresolvable handle is reported as such', async () => {
    stubNetwork((url) => (url.includes('resolveHandle') ? json({ error: 'InvalidRequest' }, 400) : undefined))

    await expect(handlePar(config, parBody(), await clientProof(), PAR_URL)).rejects.toThrow('Handle not found')
  })

  test('the default scope is asked of the PDS when the client names none', async () => {
    const calls = stubNetwork()

    await handlePar(config, parBody({ scope: '' }), await clientProof(), PAR_URL)

    expect(formOf(calls.find((c) => c.url === PDS_PAR)!).get('scope')).toBe('atproto transition:generic')
  })

  describe('prompt=create', () => {
    test('treats login_hint as a PDS host, forwards the prompt and records no DID', async () => {
      const calls = stubNetwork()

      await handlePar(
        config,
        parBody({ prompt: 'create', login_hint: 'pds.example.com' }),
        await clientProof(),
        PAR_URL,
      )

      // The auth server comes from the PDS directly — no handle, no PLC.
      const urls = calls.map((c) => c.url)
      expect(urls).not.toContain(`${PLC}/${DID}`)
      expect(urls.some((u) => u.includes('resolveHandle'))).toBe(false)
      expect(urls).toContain(`${PDS}/.well-known/oauth-protected-resource`)

      const par = formOf(calls.find((c) => c.url === PDS_PAR)!)
      expect(par.get('prompt')).toBe('create')
      expect(par.get('login_hint')).toBeNull()

      const [row] = (await querySQL('SELECT did, pds_endpoint FROM _oauth_requests', [])) as any[]
      expect(row.did).toBeNull()
      expect(row.pds_endpoint).toBe(PDS)
    })

    test('a localhost PDS is reached over plain http', async () => {
      const calls = stubNetwork((url) =>
        url === 'http://localhost:2583/.well-known/oauth-protected-resource'
          ? json({ authorization_servers: [AUTH] })
          : undefined,
      )

      await handlePar(config, parBody({ prompt: 'create', login_hint: 'localhost:2583' }), await clientProof(), PAR_URL)

      expect(calls.map((c) => c.url)).toContain('http://localhost:2583/.well-known/oauth-protected-resource')
    })

    test('a full URL is used as given', async () => {
      const calls = stubNetwork((url) =>
        url === 'http://pds.internal:3000/.well-known/oauth-protected-resource'
          ? json({ authorization_servers: [AUTH] })
          : undefined,
      )

      await handlePar(
        config,
        parBody({ prompt: 'create', login_hint: 'http://pds.internal:3000' }),
        await clientProof(),
        PAR_URL,
      )

      expect(calls.map((c) => c.url)).toContain('http://pds.internal:3000/.well-known/oauth-protected-resource')
    })

    test('a PDS that names no auth server cannot host a signup', async () => {
      stubNetwork((url) =>
        url === `${PDS}/.well-known/oauth-protected-resource` ? json({ authorization_servers: [] }) : undefined,
      )

      await expect(
        handlePar(config, parBody({ prompt: 'create', login_hint: 'pds.example.com' }), await clientProof(), PAR_URL),
      ).rejects.toThrow(/No auth server for PDS/)
    })
  })

  describe('the PDS-facing PAR', () => {
    test('a nonce challenge is answered with a proof carrying the nonce', async () => {
      const calls = stubNetwork((url, _init, n) =>
        url === PDS_PAR && n === 1 ? json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-1' }) : undefined,
      )

      const result = await handlePar(config, parBody(), await clientProof(), PAR_URL)

      const pars = calls.filter((c) => c.url === PDS_PAR)
      expect(pars).toHaveLength(2)
      expect(parseJwt(proofOf(pars[0])).payload.nonce).toBeUndefined()
      expect(parseJwt(proofOf(pars[1])).payload.nonce).toBe('n-1')
      // The same request body both times — only the proof changed.
      expect(String(pars[1].init?.body)).toBe(String(pars[0].init?.body))
      expect(result.request_uri).toBeTruthy()
    })

    test('a refusal after the nonce retry is surfaced with its description', async () => {
      stubNetwork((url, _init, n) => {
        if (url !== PDS_PAR) return undefined
        if (n === 1) return json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-1' })
        return json({ error: 'invalid_client', error_description: 'unknown client' }, 401)
      })

      await expect(handlePar(config, parBody(), await clientProof(), PAR_URL)).rejects.toThrow(
        'PDS PAR failed: 401 unknown client',
      )
    })

    test('any other refusal is surfaced with its description', async () => {
      stubNetwork((url) =>
        url === PDS_PAR ? json({ error: 'invalid_scope', error_description: 'scope not allowed' }, 400) : undefined,
      )

      await expect(handlePar(config, parBody(), await clientProof(), PAR_URL)).rejects.toThrow(
        'PDS PAR failed: 400 scope not allowed',
      )
    })

    test('an auth server that advertises no authorization endpoint is refused', async () => {
      // Guessing `${issuer}/oauth/authorize` is what used to send users into a 404.
      stubNetwork((url) =>
        url === `${AUTH}/.well-known/oauth-authorization-server`
          ? json({ issuer: AUTH, token_endpoint: TOKEN })
          : undefined,
      )

      await expect(handlePar(config, parBody(), await clientProof(), PAR_URL)).rejects.toThrow(
        /advertises no authorization_endpoint/,
      )
    })

    test('an auth server that advertises no token endpoint is refused', async () => {
      stubNetwork((url) =>
        url === `${AUTH}/.well-known/oauth-authorization-server`
          ? json({ issuer: AUTH, authorization_endpoint: AUTHORIZE })
          : undefined,
      )

      await expect(handlePar(config, parBody(), await clientProof(), PAR_URL)).rejects.toThrow(
        /advertises no token_endpoint/,
      )
    })

    test('PAR falls back to the conventional path when the metadata omits it', async () => {
      const calls = stubNetwork((url) => {
        if (url === `${AUTH}/.well-known/oauth-authorization-server`) {
          return json({ issuer: AUTH, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN })
        }
        if (url === `${AUTH}/oauth/par`) return json({ request_uri: 'urn:pds:legacy', expires_in: 300 })
        return undefined
      })

      await handlePar(config, parBody(), await clientProof(), PAR_URL)

      expect(calls.map((c) => c.url)).toContain(`${AUTH}/oauth/par`)
    })
  })

  describe('client validation', () => {
    test('a replayed client proof is refused', async () => {
      stubNetwork()
      const proof = await clientProof()
      await handlePar(config, parBody(), proof, PAR_URL)

      await expect(handlePar(config, parBody(), proof, PAR_URL)).rejects.toThrow(/jti replay/)
    })

    test('client_id is required and must be registered', async () => {
      stubNetwork()
      await expect(handlePar(config, parBody({ client_id: '' }), await clientProof(), PAR_URL)).rejects.toThrow(
        'client_id is required',
      )
      await expect(
        handlePar(config, parBody({ client_id: 'https://stranger.example/m.json' }), await clientProof(), PAR_URL),
      ).rejects.toThrow(/Unknown client/)
    })

    test('redirect_uri is required and must be one the client registered', async () => {
      stubNetwork()
      await expect(handlePar(config, parBody({ redirect_uri: '' }), await clientProof(), PAR_URL)).rejects.toThrow(
        'redirect_uri is required',
      )
      await expect(
        handlePar(config, parBody({ redirect_uri: `${ISSUER}/elsewhere` }), await clientProof(), PAR_URL),
      ).rejects.toThrow('Invalid redirect_uri')
    })

    test('PKCE is mandatory and only S256 is accepted', async () => {
      stubNetwork()
      await expect(handlePar(config, parBody({ code_challenge: '' }), await clientProof(), PAR_URL)).rejects.toThrow(
        'code_challenge is required',
      )
      await expect(
        handlePar(config, parBody({ code_challenge_method: 'plain' }), await clientProof(), PAR_URL),
      ).rejects.toThrow('Only S256 supported')
    })

    test('nothing is pushed to the PDS before the client checks out', async () => {
      const calls = stubNetwork()
      await handlePar(config, parBody({ redirect_uri: '' }), await clientProof(), PAR_URL).catch(() => {})

      expect(calls).toHaveLength(0)
    })
  })
})

describe('buildAuthorizeRedirect', () => {
  test('a request that never reached the PDS cannot be redirected', () => {
    expect(() => buildAuthorizeRedirect(config, { pds_auth_server: AUTH })).toThrow(/missing PDS data/)
    expect(() => buildAuthorizeRedirect(config, { pds_request_uri: 'urn:x' })).toThrow(/missing PDS data/)
  })
})

describe('handleCallback', () => {
  /** A request row as handlePar leaves it, with the PDS state to match on. */
  async function storePending(overrides: Record<string, unknown> = {}) {
    await storeOAuthRequest('urn:ietf:params:oauth:request_uri:pending', {
      clientId: CLIENT_ID,
      redirectUri: CLIENT_REDIRECT,
      state: 'client-state',
      codeChallenge: 'client-challenge',
      dpopJkt: clientJkt,
      pdsRequestUri: 'urn:pds:req',
      pdsAuthServer: AUTH,
      pdsAuthorizationEndpoint: AUTHORIZE,
      pdsTokenEndpoint: TOKEN,
      pdsEndpoint: PDS,
      pdsCodeVerifier: 'pds-verifier',
      pdsState: 'pds-state',
      did: DID,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      ...overrides,
    })
  }

  test('exchanges the code, stores the PDS session, and mints a code for the client', async () => {
    await storePending()
    const calls = stubNetwork()

    const result = await handleCallback(config, 'pds-code', 'pds-state', AUTH)

    // The exchange itself: our verifier, our client_id, our redirect, DPoP-bound.
    const exchange = calls.find((c) => c.url === TOKEN)!
    const form = formOf(exchange)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('pds-code')
    expect(form.get('code_verifier')).toBe('pds-verifier')
    expect(form.get('client_id')).toBe(CLIENT_ID)
    expect(form.get('redirect_uri')).toBe(`${ISSUER}/oauth/callback`)
    expect(form.get('client_assertion')).toBeTruthy()
    expect(parseJwt(proofOf(exchange)).payload.htu).toBe(TOKEN)

    // The PDS session is what every later proxy call runs on.
    const session = await getSession(DID)
    expect(session).toMatchObject({
      pds_endpoint: PDS,
      pds_auth_server: AUTH,
      pds_token_endpoint: TOKEN,
      access_token: 'at',
      refresh_token: 'rt',
    })
    expect(Number(session.token_expires_at)).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // The client gets a one-time code of ours, its own state, and our iss.
    expect(result.did).toBe(DID)
    expect(result.requestUri).toBe('urn:ietf:params:oauth:request_uri:pending')
    expect(result.clientState).toBe('client-state')
    const redirect = new URL(result.clientRedirectUri)
    expect(redirect.origin + redirect.pathname).toBe(CLIENT_REDIRECT)
    expect(redirect.searchParams.get('state')).toBe('client-state')
    expect(redirect.searchParams.get('iss')).toBe(ISSUER)
    const code = redirect.searchParams.get('code')!
    const [row] = (await querySQL('SELECT request_uri FROM _oauth_codes WHERE code = $1', [code])) as any[]
    expect(row.request_uri).toBe('urn:ietf:params:oauth:request_uri:pending')
  })

  test('a signup flow learns its DID from the token response', async () => {
    // prompt=create stored no DID; the PDS's `sub` is the first time we see it.
    await storePending({ did: undefined })
    stubNetwork()

    await handleCallback(config, 'pds-code', 'pds-state', AUTH)

    const [row] = (await querySQL('SELECT did FROM _oauth_requests', [])) as any[]
    expect(row.did).toBe(DID)
  })

  test('a request without a PDS state is still matched by issuer', async () => {
    // Rows from before pds_state existed can only be found this way.
    await storePending({ pdsState: undefined })
    stubNetwork()

    const result = await handleCallback(config, 'pds-code', null, AUTH)
    expect(result.did).toBe(DID)
  })

  test('a callback matching nothing is refused before any exchange', async () => {
    const calls = stubNetwork()

    await expect(handleCallback(config, 'pds-code', 'never-stored', AUTH)).rejects.toThrow(
      'No matching authorization request found',
    )
    expect(calls).toHaveLength(0)
  })

  test('an expired request does not match', async () => {
    await storePending({ expiresAt: Math.floor(Date.now() / 1000) - 1 })
    stubNetwork()

    await expect(handleCallback(config, 'pds-code', 'pds-state', AUTH)).rejects.toThrow(
      'No matching authorization request found',
    )
  })

  test('a token endpoint stored by an older build is guessed from the auth server', async () => {
    await storePending({ pdsTokenEndpoint: undefined })
    const calls = stubNetwork((url) =>
      url === `${AUTH}/oauth/token` ? json({ access_token: 'at', sub: DID }) : undefined,
    )

    await handleCallback(config, 'pds-code', 'pds-state', AUTH)

    expect(calls.map((c) => c.url)).toContain(`${AUTH}/oauth/token`)
  })

  test('a nonce challenge from the token endpoint is answered once', async () => {
    await storePending()
    const calls = stubNetwork((url, _init, n) =>
      url === TOKEN && n === 1 ? json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-tok' }) : undefined,
    )

    const result = await handleCallback(config, 'pds-code', 'pds-state', AUTH)

    const exchanges = calls.filter((c) => c.url === TOKEN)
    expect(exchanges).toHaveLength(2)
    expect(parseJwt(proofOf(exchanges[1])).payload.nonce).toBe('n-tok')
    expect(result.did).toBe(DID)
  })

  test('a nonce challenge that names no nonce cannot be answered', async () => {
    await storePending()
    stubNetwork((url) => (url === TOKEN ? json({ error: 'use_dpop_nonce' }, 400) : undefined))

    await expect(handleCallback(config, 'pds-code', 'pds-state', AUTH)).rejects.toThrow(
      /nonce required but not provided/,
    )
  })

  test('a refusal after the nonce retry is surfaced', async () => {
    await storePending()
    stubNetwork((url, _init, n) => {
      if (url !== TOKEN) return undefined
      if (n === 1) return json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-tok' })
      return json({ error: 'invalid_grant', error_description: 'code already used' }, 400)
    })

    await expect(handleCallback(config, 'pds-code', 'pds-state', AUTH)).rejects.toThrow(
      'PDS token exchange failed: 400 code already used',
    )
  })

  test('any other refusal is surfaced and no session is stored', async () => {
    await storePending()
    stubNetwork((url) => (url === TOKEN ? json({ error: 'invalid_grant' }, 400) : undefined))

    await expect(handleCallback(config, 'pds-code', 'pds-state', AUTH)).rejects.toThrow(
      'PDS token exchange failed: 400 invalid_grant',
    )
    expect(await getSession(DID)).toBeNull()
  })

  test('a token response without a subject is useless', async () => {
    await storePending()
    stubNetwork((url) => (url === TOKEN ? json({ access_token: 'at' }) : undefined))

    await expect(handleCallback(config, 'pds-code', 'pds-state', AUTH)).rejects.toThrow(/missing sub/)
  })
})

describe('serverLogin', () => {
  test('a login by handle resolves it, pushes to the PDS with the handle as hint, and redirects to authorize', async () => {
    const calls = stubNetwork()

    const redirect = new URL(await serverLogin(config, 'alice.test'))

    expect(redirect.origin + redirect.pathname).toBe(AUTHORIZE)
    expect(redirect.searchParams.get('request_uri')).toBe('urn:pds:req')
    expect(redirect.searchParams.get('client_id')).toBe(CLIENT_ID)

    const par = formOf(calls.find((c) => c.url === PDS_PAR)!)
    expect(par.get('login_hint')).toBe('alice.test')
    expect(par.get('prompt')).toBeNull()
    // The configured scopes are what the PDS is asked for.
    expect(par.get('scope')).toBe('atproto')

    // Nothing but this row exists when the callback comes in.
    const [row] = (await querySQL('SELECT * FROM _oauth_requests', [])) as any[]
    expect(row).toMatchObject({
      redirect_uri: '/',
      did: DID,
      login_hint: 'alice.test',
      pds_state: par.get('state'),
      pds_authorization_endpoint: AUTHORIZE,
      pds_token_endpoint: TOKEN,
      pds_endpoint: PDS,
    })
  })

  test('a login by DID skips handle resolution', async () => {
    const calls = stubNetwork()

    await serverLogin(config, DID)

    expect(calls.some((c) => c.url.includes('resolveHandle'))).toBe(false)
    expect(formOf(calls.find((c) => c.url === PDS_PAR)!).get('login_hint')).toBe(DID)
  })

  test('a nonce challenge from the PDS PAR is answered once', async () => {
    const calls = stubNetwork((url, _init, n) =>
      url === PDS_PAR && n === 1 ? json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-1' }) : undefined,
    )

    const redirect = new URL(await serverLogin(config, 'alice.test'))

    expect(redirect.searchParams.get('request_uri')).toBe('urn:pds:req')
    const pars = calls.filter((c) => c.url === PDS_PAR)
    expect(pars).toHaveLength(2)
    expect(parseJwt(proofOf(pars[1])).payload.nonce).toBe('n-1')
  })

  test('a refusal after the nonce retry is surfaced', async () => {
    stubNetwork((url, _init, n) => {
      if (url !== PDS_PAR) return undefined
      if (n === 1) return json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-1' })
      return json({ error: 'invalid_client', error_description: 'unknown client' }, 401)
    })

    await expect(serverLogin(config, 'alice.test')).rejects.toThrow('PDS PAR failed: 401 unknown client')
  })

  test('any other refusal is surfaced and nothing is stored', async () => {
    stubNetwork((url) => (url === PDS_PAR ? json({ error: 'invalid_scope' }, 400) : undefined))

    await expect(serverLogin(config, 'alice.test')).rejects.toThrow('PDS PAR failed: 400 invalid_scope')
    expect(await querySQL('SELECT 1 FROM _oauth_requests', [])).toHaveLength(0)
  })

  test('a signup names no DID and forwards the prompt', async () => {
    const calls = stubNetwork()

    await serverLogin(config, '', { prompt: 'create', pds: 'pds.example.com' })

    const par = formOf(calls.find((c) => c.url === PDS_PAR)!)
    expect(par.get('prompt')).toBe('create')
    expect(par.get('login_hint')).toBeNull()
    expect(calls.some((c) => c.url.includes('resolveHandle') || c.url.startsWith(PLC))).toBe(false)
  })
})
