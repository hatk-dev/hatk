import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initOAuth, refreshPdsSession } from '../src/oauth/server.ts'
import { OAUTH_DDL, getSession, storeSession } from '../src/oauth/db.ts'
import { parseJwt } from '../src/oauth/crypto.ts'
import { runSQL } from '../src/database/db.ts'
import { emit } from '../src/logger.ts'
import { setupFixtureDatabase } from './fixture.ts'

vi.mock('../src/logger.ts', { spy: true })

// A PDS access token lives an hour; the session lives months. Everything
// between is `refreshPdsSession`, and a wrong answer here either logs a user
// out for nothing or leaves a dead token in the row to fail every proxy call.

const ISSUER = 'https://example.app'
const LOOPBACK = 'http://localhost:3000'
const CLIENT_ID = `${ISSUER}/oauth-client-metadata.json`
const PDS = 'https://pds.example.com'
const AUTH = 'https://auth.example.com'
const TOKEN = `${AUTH}/tok`
const DID = 'did:plc:alice'

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: CLIENT_ID, client_name: 'test', scope: 'atproto' }],
} as any

interface Call {
  url: string
  init?: RequestInit
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const formOf = (call: Call) => new URLSearchParams(String(call.init?.body))
const proofOf = (call: Call) => (call.init!.headers as Record<string, string>).DPoP

function stubFetch(handler: (url: string, n: number) => Response) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      const n = (counts.get(url) ?? 0) + 1
      counts.set(url, n)
      return handler(url, n)
    }),
  )
  return calls
}

const fullSession = {
  did: DID,
  pds_endpoint: PDS,
  pds_auth_server: AUTH,
  pds_token_endpoint: TOKEN,
  refresh_token: 'rt-old',
  dpop_jkt: 'jkt',
}

const granted = { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  await initOAuth(config, 'http://plc.test', 'ws://relay.test')
})

beforeEach(async () => {
  await runSQL('DELETE FROM _oauth_sessions')
  await storeSession(DID, {
    pdsEndpoint: PDS,
    pdsAuthServer: AUTH,
    pdsTokenEndpoint: TOKEN,
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    dpopJkt: 'jkt',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('refreshPdsSession', () => {
  test('a session without a refresh token cannot be refreshed and asks nothing', async () => {
    const calls = stubFetch(() => json(granted))

    expect(await refreshPdsSession(config, { ...fullSession, refresh_token: '' })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('exchanges the refresh token at the stored endpoint as the confidential client', async () => {
    const calls = stubFetch(() => json(granted))

    const result = await refreshPdsSession(config, fullSession)

    expect(result).toEqual({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: expect.any(Number) })
    expect(result!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(TOKEN)
    const form = formOf(calls[0])
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('rt-old')
    expect(form.get('client_id')).toBe(CLIENT_ID)
    // Confidential: the assertion is for the auth server, signed by the client key.
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    expect(parseJwt(form.get('client_assertion')!).payload.aud).toBe(AUTH)
    // The proof is for the token endpoint and carries no access token hash.
    const proof = parseJwt(proofOf(calls[0])).payload
    expect(proof.htu).toBe(TOKEN)
    expect(proof.htm).toBe('POST')
    expect(proof.ath).toBeUndefined()

    // The row now holds the new tokens and still knows where to refresh next time.
    const session = await getSession(DID)
    expect(session).toMatchObject({
      access_token: 'at-new',
      refresh_token: 'rt-new',
      pds_endpoint: PDS,
      pds_auth_server: AUTH,
      pds_token_endpoint: TOKEN,
      dpop_jkt: 'jkt',
    })
    expect(Number(session.token_expires_at)).toBe(result!.expiresAt)
  })

  test('keeps the old refresh token when the server does not rotate it', async () => {
    stubFetch(() => json({ access_token: 'at-new' }))

    const result = await refreshPdsSession(config, fullSession)

    expect(result).toEqual({ accessToken: 'at-new', refreshToken: undefined, expiresAt: undefined })
    const session = await getSession(DID)
    expect(session.refresh_token).toBe('rt-old')
    expect(session.token_expires_at).toBeNull()
  })

  test('a session from before the endpoint column falls back to the auth server path', async () => {
    const calls = stubFetch(() => json(granted))

    await refreshPdsSession(config, { ...fullSession, pds_token_endpoint: undefined })

    expect(calls[0].url).toBe(`${AUTH}/oauth/token`)
  })

  test('a session older still falls back to the PDS itself', async () => {
    // Before pds_auth_server existed the PDS was assumed to be its own auth server.
    const calls = stubFetch(() => json(granted))

    await refreshPdsSession(config, { ...fullSession, pds_token_endpoint: undefined, pds_auth_server: undefined })

    expect(calls[0].url).toBe(`${PDS}/oauth/token`)
    expect(parseJwt(formOf(calls[0]).get('client_assertion')!).payload.aud).toBe(PDS)
  })

  test('a nonce challenge is answered with a proof carrying the nonce', async () => {
    const calls = stubFetch((_url, n) =>
      n === 1 ? json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-1' }) : json(granted),
    )

    const result = await refreshPdsSession(config, fullSession)

    expect(result?.accessToken).toBe('at-new')
    expect(calls).toHaveLength(2)
    expect(parseJwt(proofOf(calls[0])).payload.nonce).toBeUndefined()
    expect(parseJwt(proofOf(calls[1])).payload.nonce).toBe('n-1')
    expect(String(calls[1].init?.body)).toBe(String(calls[0].init?.body))
    expect((await getSession(DID)).access_token).toBe('at-new')
  })

  test('a nonce challenge naming no nonce is a failed refresh', async () => {
    const calls = stubFetch(() => json({ error: 'use_dpop_nonce' }, 400))

    expect(await refreshPdsSession(config, fullSession)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  test('a refused refresh drops the session so the user is asked to sign in', async () => {
    // The grant is gone (revoked, expired, or the PDS moved). Keeping the row
    // would have every later proxy call fail the same way, forever.
    stubFetch(() => json({ error: 'invalid_grant' }, 400))

    expect(await refreshPdsSession(config, fullSession)).toBeNull()
    expect(await getSession(DID)).toBeNull()
  })

  test('a refused refresh logs why, since the status is the same for every reason', async () => {
    vi.mocked(emit).mockClear()
    stubFetch((_url, n) =>
      n === 1
        ? json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-1' })
        : json({ error: 'invalid_grant', error_description: 'Refresh token replayed' }, 400),
    )

    await refreshPdsSession(config, fullSession)

    const refusals = vi.mocked(emit).mock.calls.filter(([m, o]) => m === 'oauth' && o === 'pds_session_refresh_error')
    expect(refusals.map(([, , data]) => data)).toEqual([
      {
        status: 400,
        did: DID,
        pds_endpoint: PDS,
        error: 'invalid_grant',
        error_description: 'Refresh token replayed',
      },
    ])
  })

  test('a refusal after the nonce retry also drops the session', async () => {
    stubFetch((_url, n) =>
      n === 1 ? json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n-1' }) : json({ error: 'invalid_grant' }, 400),
    )

    expect(await refreshPdsSession(config, fullSession)).toBeNull()
    expect(await getSession(DID)).toBeNull()
  })

  test('a loopback deployment refreshes as a public client with the encoded client_id', async () => {
    // Local dev has no fetchable JWKS, so it must not send an assertion, and
    // its client_id is the loopback form the atproto spec defines.
    const loopbackConfig = {
      issuer: LOOPBACK,
      scopes: ['atproto'],
      clients: [{ client_id: LOOPBACK, client_name: 'dev', scope: 'atproto repo:x' }],
    } as any
    const calls = stubFetch(() => json(granted))

    await refreshPdsSession(loopbackConfig, fullSession)

    const form = formOf(calls[0])
    expect(form.get('client_assertion')).toBeNull()
    expect(form.get('client_assertion_type')).toBeNull()
    const clientId = new URL(form.get('client_id')!)
    expect(clientId.origin + clientId.pathname).toBe('http://localhost/')
    // RFC 8252: the redirect is on 127.0.0.1, never the literal "localhost".
    expect(clientId.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/oauth/callback')
    expect(clientId.searchParams.get('scope')).toBe('atproto repo:x')
  })

  describe('one refresh per DID', () => {
    // The reference auth server revokes a whole grant when a refresh token is
    // used twice. Every case here is a second caller that must not spend one.

    test('callers that find the token expired together share one exchange', async () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const calls: Call[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(input), init })
          await held
          return json(granted)
        }),
      )

      const first = refreshPdsSession(config, { ...fullSession, access_token: 'at-old' })
      const second = refreshPdsSession(config, { ...fullSession, access_token: 'at-old' })
      release()

      expect(await first).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' })
      expect(await second).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' })
      expect(calls).toHaveLength(1)
      expect((await getSession(DID)).refresh_token).toBe('rt-new')
    })

    test('a caller holding a session read before a finished refresh gets what it stored', async () => {
      stubFetch(() => json(granted))
      await refreshPdsSession(config, fullSession)
      const calls = stubFetch(() => json({ error: 'invalid_grant' }, 400))

      const result = await refreshPdsSession(config, { ...fullSession, access_token: 'at-old' })

      expect(result).toEqual({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: expect.any(Number) })
      expect(calls).toHaveLength(0)
      expect((await getSession(DID)).access_token).toBe('at-new')
    })

    test('a renewal that kept the refresh token is told apart by the access token', async () => {
      stubFetch(() => json({ access_token: 'at-new', expires_in: 3600 }))
      await refreshPdsSession(config, fullSession)
      const calls = stubFetch(() => json({ error: 'invalid_grant' }, 400))

      const result = await refreshPdsSession(config, { ...fullSession, access_token: 'at-old' })

      expect(result).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-old' })
      expect(calls).toHaveLength(0)
    })

    test('a caller whose session ended meanwhile asks nothing', async () => {
      await runSQL('DELETE FROM _oauth_sessions')
      const calls = stubFetch(() => json(granted))

      expect(await refreshPdsSession(config, { ...fullSession, access_token: 'at-old' })).toBeNull()
      expect(calls).toHaveLength(0)
    })

    test('the next expiry refreshes again', async () => {
      stubFetch(() => json(granted))
      await refreshPdsSession(config, { ...fullSession, access_token: 'at-old' })
      const calls = stubFetch(() => json({ access_token: 'at-3', refresh_token: 'rt-3', expires_in: 3600 }))

      const result = await refreshPdsSession(config, {
        ...fullSession,
        access_token: 'at-new',
        refresh_token: 'rt-new',
      })

      expect(result?.accessToken).toBe('at-3')
      expect(calls).toHaveLength(1)
      expect(formOf(calls[0]).get('refresh_token')).toBe('rt-new')
    })
  })
})
