import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  OAUTH_DDL,
  checkAndStoreDpopJti,
  cleanupExpiredOAuth,
  consumeAuthCode,
  deleteOAuthRequest,
  deleteSession,
  getOAuthRequest,
  getRefreshToken,
  getServerKey,
  getSession,
  revokeRefreshToken,
  storeAuthCode,
  storeOAuthRequest,
  storeRefreshToken,
  storeServerKey,
  storeSession,
} from '../src/oauth/db.ts'
import { querySQL, runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// The OAuth tables are the only state the server has between the requests of
// a flow. What matters is which rows are found again, which are found only
// once, and which the sweeper takes away.

const now = () => Math.floor(Date.now() / 1000)

const baseRequest = {
  clientId: 'https://app.example/oauth-client-metadata.json',
  redirectUri: 'https://app.example/oauth/callback',
  codeChallenge: 'challenge',
  dpopJkt: 'jkt-1',
}

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
})

beforeEach(async () => {
  for (const table of [
    '_oauth_keys',
    '_oauth_sessions',
    '_oauth_requests',
    '_oauth_codes',
    '_oauth_refresh_tokens',
    '_oauth_dpop_jtis',
  ]) {
    await runSQL(`DELETE FROM ${table}`)
  }
})

describe('server keys', () => {
  test('a stored key comes back by kid, and an unknown kid is null', async () => {
    await storeServerKey('k1', '{"d":"priv"}', '{"x":"pub"}')

    expect(await getServerKey('k1')).toEqual({ privateKey: '{"d":"priv"}', publicKey: '{"x":"pub"}' })
    expect(await getServerKey('k2')).toBeNull()
  })

  test('storing a kid again replaces it', async () => {
    // Boot regenerates nothing if a key exists, so replace has to be explicit.
    await storeServerKey('k1', 'old-priv', 'old-pub')
    await storeServerKey('k1', 'new-priv', 'new-pub')

    expect(await getServerKey('k1')).toEqual({ privateKey: 'new-priv', publicKey: 'new-pub' })
  })
})

describe('authorization requests', () => {
  test('a live request is found by its request_uri with optional fields nulled', async () => {
    await storeOAuthRequest('urn:req:1', { ...baseRequest, expiresAt: now() + 600 })

    const row = await getOAuthRequest('urn:req:1')
    expect(row.client_id).toBe(baseRequest.clientId)
    expect(row.code_challenge_method).toBe('S256')
    expect(row.scope).toBeNull()
    expect(row.state).toBeNull()
    expect(row.did).toBeNull()
  })

  test('every optional field round-trips', async () => {
    await storeOAuthRequest('urn:req:2', {
      ...baseRequest,
      scope: 'atproto repo:x',
      state: 'client-state',
      codeChallengeMethod: 'S256',
      pdsRequestUri: 'urn:pds:req',
      pdsAuthServer: 'https://auth.test',
      pdsAuthorizationEndpoint: 'https://auth.test/authz',
      pdsTokenEndpoint: 'https://auth.test/tok',
      pdsEndpoint: 'https://pds.test',
      pdsCodeVerifier: 'verifier',
      pdsState: 'pds-state',
      did: 'did:plc:alice',
      loginHint: 'alice.test',
      expiresAt: now() + 600,
    })

    const row = await getOAuthRequest('urn:req:2')
    expect(row).toMatchObject({
      scope: 'atproto repo:x',
      state: 'client-state',
      pds_request_uri: 'urn:pds:req',
      pds_auth_server: 'https://auth.test',
      pds_authorization_endpoint: 'https://auth.test/authz',
      pds_token_endpoint: 'https://auth.test/tok',
      pds_endpoint: 'https://pds.test',
      pds_code_verifier: 'verifier',
      pds_state: 'pds-state',
      did: 'did:plc:alice',
      login_hint: 'alice.test',
    })
  })

  test('an expired request is not found even though its row remains', async () => {
    // A code exchanged after the request's window must not succeed on a row
    // the sweeper has not reached yet.
    await storeOAuthRequest('urn:req:old', { ...baseRequest, expiresAt: now() - 1 })

    expect(await getOAuthRequest('urn:req:old')).toBeNull()
    expect(await querySQL('SELECT 1 FROM _oauth_requests WHERE request_uri = $1', ['urn:req:old'])).toHaveLength(1)
  })

  test('a deleted request is gone', async () => {
    await storeOAuthRequest('urn:req:3', { ...baseRequest, expiresAt: now() + 600 })
    await deleteOAuthRequest('urn:req:3')

    expect(await getOAuthRequest('urn:req:3')).toBeNull()
  })
})

describe('authorization codes', () => {
  test('a code is redeemable exactly once', async () => {
    await storeAuthCode('code-1', 'urn:req:1')

    expect(await consumeAuthCode('code-1')).toBe('urn:req:1')
    // A replayed code must not hand out a second token.
    expect(await consumeAuthCode('code-1')).toBeNull()
  })

  test('an unknown code is null', async () => {
    expect(await consumeAuthCode('never-issued')).toBeNull()
  })
})

describe('sessions', () => {
  test('a session round-trips with optional fields nulled', async () => {
    await storeSession('did:plc:alice', {
      pdsEndpoint: 'https://pds.test',
      accessToken: 'at',
      dpopJkt: 'jkt',
    })

    const session = await getSession('did:plc:alice')
    expect(session).toMatchObject({
      did: 'did:plc:alice',
      pds_endpoint: 'https://pds.test',
      access_token: 'at',
      dpop_jkt: 'jkt',
      pds_auth_server: null,
      pds_token_endpoint: null,
      refresh_token: null,
      token_expires_at: null,
    })
  })

  test('storing a DID again replaces the whole session', async () => {
    // A refresh writes new tokens over the old; a fresh login for the same DID
    // must not leave two sessions behind.
    await storeSession('did:plc:alice', { pdsEndpoint: 'https://pds.test', accessToken: 'old', dpopJkt: 'jkt' })
    await storeSession('did:plc:alice', {
      pdsEndpoint: 'https://pds2.test',
      pdsAuthServer: 'https://auth.test',
      pdsTokenEndpoint: 'https://auth.test/tok',
      accessToken: 'new',
      refreshToken: 'rt',
      dpopJkt: 'jkt',
      tokenExpiresAt: 1234,
    })

    const rows = await querySQL('SELECT * FROM _oauth_sessions WHERE did = $1', ['did:plc:alice'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      pds_endpoint: 'https://pds2.test',
      pds_auth_server: 'https://auth.test',
      pds_token_endpoint: 'https://auth.test/tok',
      access_token: 'new',
      refresh_token: 'rt',
      token_expires_at: 1234,
    })
  })

  test('deleting a session makes it unfindable; unknown DIDs are null', async () => {
    await storeSession('did:plc:alice', { pdsEndpoint: 'https://pds.test', accessToken: 'at', dpopJkt: 'jkt' })
    await deleteSession('did:plc:alice')

    expect(await getSession('did:plc:alice')).toBeNull()
    expect(await getSession('did:plc:nobody')).toBeNull()
  })
})

describe('refresh tokens', () => {
  test('a stored token is found with a 14-day default expiry and unrevoked', async () => {
    const before = now()
    await storeRefreshToken('rt-1', { clientId: 'client', did: 'did:plc:alice', dpopJkt: 'jkt' })

    const row = await getRefreshToken('rt-1')
    expect(row).toMatchObject({ client_id: 'client', did: 'did:plc:alice', dpop_jkt: 'jkt', scope: null })
    expect(Number(row.revoked)).toBe(0)
    expect(Number(row.expires_at)).toBeGreaterThanOrEqual(before + 14 * 86400)
    expect(Number(row.expires_at)).toBeLessThanOrEqual(now() + 14 * 86400)
  })

  test('an explicit expiry and scope are kept', async () => {
    await storeRefreshToken('rt-2', {
      clientId: 'client',
      did: 'did:plc:alice',
      dpopJkt: 'jkt',
      scope: 'atproto',
      expiresAt: 42,
    })

    const row = await getRefreshToken('rt-2')
    expect(row.scope).toBe('atproto')
    expect(Number(row.expires_at)).toBe(42)
  })

  test('revoking marks the row rather than deleting it', async () => {
    // The row has to stay so a replay of the old token is recognised as
    // revoked, not as unknown.
    await storeRefreshToken('rt-3', { clientId: 'client', did: 'did:plc:alice', dpopJkt: 'jkt' })
    await revokeRefreshToken('rt-3')

    const row = await getRefreshToken('rt-3')
    expect(row).not.toBeNull()
    expect(Number(row.revoked)).toBe(1)
  })

  test('an unknown token is null', async () => {
    expect(await getRefreshToken('nope')).toBeNull()
  })
})

describe('DPoP jti replay protection', () => {
  test('a jti is accepted the first time and refused after', async () => {
    expect(await checkAndStoreDpopJti('jti-1', now() + 300)).toBe(true)
    expect(await checkAndStoreDpopJti('jti-1', now() + 300)).toBe(false)
  })

  test('different jtis do not interfere', async () => {
    expect(await checkAndStoreDpopJti('jti-a', now() + 300)).toBe(true)
    expect(await checkAndStoreDpopJti('jti-b', now() + 300)).toBe(true)
  })
})

describe('cleanupExpiredOAuth', () => {
  test('sweeps only what has lapsed', async () => {
    const t = now()
    await checkAndStoreDpopJti('jti-old', t - 1)
    await checkAndStoreDpopJti('jti-live', t + 300)
    await storeOAuthRequest('urn:req:old', { ...baseRequest, expiresAt: t - 1 })
    await storeOAuthRequest('urn:req:live', { ...baseRequest, expiresAt: t + 600 })
    await storeRefreshToken('rt-revoked', { clientId: 'c', did: 'd', dpopJkt: 'j' })
    await revokeRefreshToken('rt-revoked')
    await storeRefreshToken('rt-expired', { clientId: 'c', did: 'd', dpopJkt: 'j', expiresAt: t - 1 })
    await storeRefreshToken('rt-live', { clientId: 'c', did: 'd', dpopJkt: 'j' })
    // Codes are swept by age, not an expiry column.
    await runSQL('INSERT INTO _oauth_codes (code, request_uri, created_at) VALUES ($1, $2, $3)', [
      'code-old',
      'urn:req:x',
      t - 601,
    ])
    await storeAuthCode('code-live', 'urn:req:y')

    await cleanupExpiredOAuth()

    // A swept jti is acceptable again; a live one is still a replay.
    expect(await checkAndStoreDpopJti('jti-old', t + 300)).toBe(true)
    expect(await checkAndStoreDpopJti('jti-live', t + 300)).toBe(false)
    expect(await querySQL('SELECT 1 FROM _oauth_requests WHERE request_uri = $1', ['urn:req:old'])).toHaveLength(0)
    expect(await getOAuthRequest('urn:req:live')).not.toBeNull()
    expect(await getRefreshToken('rt-revoked')).toBeNull()
    expect(await getRefreshToken('rt-expired')).toBeNull()
    expect(await getRefreshToken('rt-live')).not.toBeNull()
    expect(await consumeAuthCode('code-old')).toBeNull()
    expect(await consumeAuthCode('code-live')).toBe('urn:req:y')
  })
})
