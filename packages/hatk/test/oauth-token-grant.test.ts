import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { OAuthError, authenticate, getClientJwks, getJwks, handleToken, initOAuth } from '../src/oauth/server.ts'
import {
  OAUTH_DDL,
  getOAuthRequest,
  getRefreshToken,
  storeAuthCode,
  storeOAuthRequest,
  storeRefreshToken,
} from '../src/oauth/db.ts'
import { createDpopProof } from '../src/oauth/dpop.ts'
import {
  base64UrlDecode,
  base64UrlEncode,
  computeJwkThumbprint,
  generateKeyPair,
  importPrivateKey,
  importPublicKey,
  parseJwt,
  sha256,
  signJwt,
  verifyEs256,
} from '../src/oauth/crypto.ts'
import { runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// Our own token endpoint: the code grant that turns a callback into a
// DPoP-bound access token, the refresh grant that rotates it, and the
// `authenticate` check every API call runs the result through. No network is
// involved — the PDS side was settled at the callback.

const ISSUER = 'https://example.app'
const CLIENT_ID = `${ISSUER}/oauth-client-metadata.json`
const CLIENT_REDIRECT = `${ISSUER}/oauth/callback`
const TOKEN_URL = `${ISSUER}/oauth/token`
const API_URL = `${ISSUER}/xrpc/dev.hatk.something`
const DID = 'did:plc:alice'
const VERIFIER = 'client-code-verifier'

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: CLIENT_ID, client_name: 'test', scope: 'atproto', redirect_uris: [CLIENT_REDIRECT] }],
} as any

let clientPriv: JsonWebKey
let clientPub: JsonWebKey
let clientJkt: string

const proofFor = (method: string, url: string, token?: string) =>
  createDpopProof(clientPriv, clientPub, method, url, token)

/** A request the callback has already completed: DID known, code issued. */
async function seedCompletedRequest(overrides: Record<string, unknown> = {}) {
  await storeOAuthRequest('urn:ietf:params:oauth:request_uri:done', {
    clientId: CLIENT_ID,
    redirectUri: CLIENT_REDIRECT,
    scope: 'atproto repo:x',
    codeChallenge: base64UrlEncode(await sha256(VERIFIER)),
    dpopJkt: clientJkt,
    did: DID,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  })
  await storeAuthCode('the-code', 'urn:ietf:params:oauth:request_uri:done')
}

const codeGrant = (extra: Record<string, string> = {}) => ({
  grant_type: 'authorization_code',
  code: 'the-code',
  client_id: CLIENT_ID,
  redirect_uri: CLIENT_REDIRECT,
  code_verifier: VERIFIER,
  ...extra,
})

/** Verify a token against our published JWKS and return its payload. */
async function verifyAccessToken(token: string) {
  const { header, payload, signatureInput, signature } = parseJwt(token)
  const [jwk] = getJwks().keys as any[]
  expect(header.kid).toBe(jwk.kid)
  expect(await verifyEs256(await importPublicKey(jwk), signature, signatureInput)).toBe(true)
  return payload
}

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  await initOAuth(config, 'http://plc.test', 'ws://relay.test')
  const kp = await generateKeyPair()
  clientPriv = kp.privateJwk
  clientPub = kp.publicJwk
  clientJkt = await computeJwkThumbprint(clientPub)
  await runSQL(`INSERT OR REPLACE INTO _repos (did, status, handle) VALUES ($1, 'active', 'alice.test')`, [DID])
})

beforeEach(async () => {
  for (const table of ['_oauth_requests', '_oauth_codes', '_oauth_refresh_tokens', '_oauth_dpop_jtis']) {
    await runSQL(`DELETE FROM ${table}`)
  }
})

describe('grant selection', () => {
  test('grant_type is required', async () => {
    await expect(handleToken(config, {}, await proofFor('POST', TOKEN_URL), TOKEN_URL)).rejects.toMatchObject({
      name: 'OAuthError',
      code: 'invalid_request',
      status: 400,
    })
  })

  test('an unknown grant is refused by name', async () => {
    await expect(
      handleToken(config, { grant_type: 'password' }, await proofFor('POST', TOKEN_URL), TOKEN_URL),
    ).rejects.toMatchObject({ code: 'unsupported_grant_type', description: 'Unsupported grant_type: password' })
  })

  test('OAuthError carries a code, a description and an HTTP status', () => {
    const err = new OAuthError('invalid_grant', 'nope', 401)
    expect(err.message).toBe('nope')
    expect(err.status).toBe(401)
    expect(new OAuthError('invalid_request', 'x').status).toBe(400)
  })
})

describe('authorization_code grant', () => {
  test('issues a DPoP-bound access token and a refresh token for the request', async () => {
    await seedCompletedRequest()

    const result = await handleToken(config, codeGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)

    expect(result.token_type).toBe('DPoP')
    expect(result.expires_in).toBe(3600)
    expect(result.sub).toBe(DID)
    // The handle rides along so the client can render without a second call.
    expect(result.handle).toBe('alice.test')

    const payload = await verifyAccessToken(result.access_token)
    expect(payload).toMatchObject({ iss: ISSUER, aud: ISSUER, sub: DID, client_id: CLIENT_ID, scope: 'atproto repo:x' })
    // Bound to the key that made the proof, so a stolen token is useless alone.
    expect(payload.cnf).toEqual({ jkt: clientJkt })
    expect(payload.exp - payload.iat).toBe(3600)

    const stored = await getRefreshToken(result.refresh_token)
    expect(stored).toMatchObject({ client_id: CLIENT_ID, did: DID, dpop_jkt: clientJkt, scope: 'atproto repo:x' })

    // The request is spent along with the code.
    expect(await getOAuthRequest('urn:ietf:params:oauth:request_uri:done')).toBeNull()
  })

  test('scope defaults to atproto when the request named none', async () => {
    await seedCompletedRequest({ scope: undefined })

    const result = await handleToken(config, codeGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)

    expect(parseJwt(result.access_token).payload.scope).toBe('atproto')
  })

  test('a code can only be exchanged once', async () => {
    await seedCompletedRequest()
    await handleToken(config, codeGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)

    await expect(handleToken(config, codeGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)).rejects.toThrow(
      /Invalid or expired authorization code/,
    )
  })

  test('every parameter is required', async () => {
    await seedCompletedRequest()
    for (const missing of ['code', 'client_id', 'redirect_uri', 'code_verifier']) {
      await expect(
        handleToken(config, codeGrant({ [missing]: '' }), await proofFor('POST', TOKEN_URL), TOKEN_URL),
      ).rejects.toThrow('Missing required parameters')
    }
  })

  test('a replayed DPoP proof is refused', async () => {
    await seedCompletedRequest()
    const proof = await proofFor('POST', TOKEN_URL)
    await handleToken(config, codeGrant(), proof, TOKEN_URL)
    await seedCompletedRequest()

    await expect(handleToken(config, codeGrant(), proof, TOKEN_URL)).rejects.toThrow(/jti replay/)
  })

  test('the code is tied to the request it was issued for', async () => {
    // The code is valid but its request has expired underneath it.
    await seedCompletedRequest({ expiresAt: Math.floor(Date.now() / 1000) - 1 })

    await expect(handleToken(config, codeGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)).rejects.toThrow(
      'Authorization request not found',
    )
  })

  test('client_id must match the PAR', async () => {
    await seedCompletedRequest()
    await expect(
      handleToken(config, codeGrant({ client_id: 'http://localhost:9' }), await proofFor('POST', TOKEN_URL), TOKEN_URL),
    ).rejects.toThrow('client_id mismatch')
  })

  test('redirect_uri must match the PAR', async () => {
    await seedCompletedRequest()
    await expect(
      handleToken(config, codeGrant({ redirect_uri: `${ISSUER}/other` }), await proofFor('POST', TOKEN_URL), TOKEN_URL),
    ).rejects.toThrow('redirect_uri mismatch')
  })

  test('the PKCE verifier must hash to the challenge', async () => {
    await seedCompletedRequest()

    await expect(
      handleToken(config, codeGrant({ code_verifier: 'wrong' }), await proofFor('POST', TOKEN_URL), TOKEN_URL),
    ).rejects.toThrow('PKCE verification failed')
  })

  test('the proof must come from the key that made the PAR', async () => {
    // An intercepted code presented with a different key gets nothing.
    await seedCompletedRequest()
    const other = await generateKeyPair()
    const proof = await createDpopProof(other.privateJwk, other.publicJwk, 'POST', TOKEN_URL)

    await expect(handleToken(config, codeGrant(), proof, TOKEN_URL)).rejects.toThrow('DPoP key mismatch')
  })

  test('a request that never learned its DID cannot be redeemed', async () => {
    await seedCompletedRequest({ did: undefined })

    await expect(handleToken(config, codeGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)).rejects.toThrow(
      /No DID associated/,
    )
  })
})

describe('refresh_token grant', () => {
  const refreshGrant = (extra: Record<string, string> = {}) => ({
    grant_type: 'refresh_token',
    refresh_token: 'rt-old',
    client_id: CLIENT_ID,
    ...extra,
  })

  async function seedRefreshToken(overrides: Record<string, unknown> = {}) {
    await storeRefreshToken('rt-old', {
      clientId: CLIENT_ID,
      did: DID,
      dpopJkt: clientJkt,
      scope: 'atproto',
      ...overrides,
    })
  }

  test('rotates the refresh token and issues a fresh access token', async () => {
    await seedRefreshToken()

    const result = await handleToken(config, refreshGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)

    const payload = await verifyAccessToken(result.access_token)
    expect(payload).toMatchObject({ sub: DID, client_id: CLIENT_ID, scope: 'atproto', cnf: { jkt: clientJkt } })
    expect(result.handle).toBe('alice.test')

    // The old token is dead; the new one is live and bound the same way.
    expect(result.refresh_token).not.toBe('rt-old')
    expect(Number((await getRefreshToken('rt-old')).revoked)).toBe(1)
    expect(await getRefreshToken(result.refresh_token)).toMatchObject({ client_id: CLIENT_ID, did: DID })
  })

  test('a rotated-out token is refused as invalid_grant', async () => {
    // RFC 6749 §5.2: the client must treat this as terminal and log in again.
    await seedRefreshToken()
    await handleToken(config, refreshGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)

    await expect(
      handleToken(config, refreshGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL),
    ).rejects.toMatchObject({ code: 'invalid_grant', description: 'Refresh token revoked' })
  })

  test('an unknown token is invalid_grant', async () => {
    await expect(
      handleToken(config, refreshGrant({ refresh_token: 'never' }), await proofFor('POST', TOKEN_URL), TOKEN_URL),
    ).rejects.toMatchObject({ code: 'invalid_grant', description: 'Invalid refresh token' })
  })

  test('an expired token is invalid_grant', async () => {
    await seedRefreshToken({ expiresAt: Math.floor(Date.now() / 1000) - 1 })

    await expect(
      handleToken(config, refreshGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL),
    ).rejects.toMatchObject({ code: 'invalid_grant', description: 'Refresh token expired' })
  })

  test('a token belongs to the client it was issued to', async () => {
    await seedRefreshToken()

    await expect(
      handleToken(
        config,
        refreshGrant({ client_id: 'http://localhost:9' }),
        await proofFor('POST', TOKEN_URL),
        TOKEN_URL,
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant', description: 'client_id mismatch' })
  })

  test('refresh_token and client_id are required', async () => {
    await expect(
      handleToken(config, refreshGrant({ refresh_token: '' }), await proofFor('POST', TOKEN_URL), TOKEN_URL),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  test('a replayed proof is an invalid_request, not a grant failure', async () => {
    await seedRefreshToken()
    const proof = await proofFor('POST', TOKEN_URL)
    await handleToken(config, refreshGrant(), proof, TOKEN_URL)

    await expect(handleToken(config, refreshGrant(), proof, TOKEN_URL)).rejects.toMatchObject({
      code: 'invalid_request',
      description: 'DPoP jti replay detected',
    })
  })
})

describe('authenticate', () => {
  async function issueToken(): Promise<string> {
    await seedCompletedRequest()
    const result = await handleToken(config, codeGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)
    return result.access_token
  }

  test('a token presented with a proof from its bound key names the user', async () => {
    const token = await issueToken()
    const proof = await proofFor('GET', API_URL, token)

    expect(await authenticate(`DPoP ${token}`, proof, 'GET', API_URL)).toEqual({ did: DID })
  })

  test('the scheme is case-insensitive', async () => {
    const token = await issueToken()
    expect(await authenticate(`dpop ${token}`, await proofFor('GET', API_URL, token), 'GET', API_URL)).toEqual({
      did: DID,
    })
  })

  test('no header, a Bearer header, or no proof means anonymous', async () => {
    const token = await issueToken()
    const proof = await proofFor('GET', API_URL, token)

    expect(await authenticate(null, proof, 'GET', API_URL)).toBeNull()
    // A DPoP-bound token must not be accepted as a bearer.
    expect(await authenticate(`Bearer ${token}`, proof, 'GET', API_URL)).toBeNull()
    expect(await authenticate(`DPoP ${token}`, null, 'GET', API_URL)).toBeNull()
  })

  test('an expired token is anonymous without checking the proof', async () => {
    const now = Math.floor(Date.now() / 1000)
    const kp = await generateKeyPair()
    const expired = await signJwt(
      { typ: 'at+jwt', alg: 'ES256' },
      { sub: DID, exp: now - 1, cnf: { jkt: clientJkt } },
      await importPrivateKey(kp.privateJwk),
    )

    expect(await authenticate(`DPoP ${expired}`, 'not-even-a-proof', 'GET', API_URL)).toBeNull()
  })

  test('a proof from a key other than the bound one is refused', async () => {
    const token = await issueToken()
    const other = await generateKeyPair()
    const proof = await createDpopProof(other.privateJwk, other.publicJwk, 'GET', API_URL, token)

    expect(await authenticate(`DPoP ${token}`, proof, 'GET', API_URL)).toBeNull()
  })

  test('a proof for a different request is refused', async () => {
    const token = await issueToken()
    const proof = await proofFor('POST', API_URL, token)

    await expect(authenticate(`DPoP ${token}`, proof, 'GET', API_URL)).rejects.toThrow(/htm mismatch/)
  })

  test('a token signed by someone other than us is refused', async () => {
    // Same claims, wrong key: the signature is the only thing that makes it ours.
    const now = Math.floor(Date.now() / 1000)
    const kp = await generateKeyPair()
    const forged = await signJwt(
      { typ: 'at+jwt', alg: 'ES256', kid: 'appview-oauth-key' },
      { iss: ISSUER, sub: DID, exp: now + 60, cnf: { jkt: clientJkt } },
      await importPrivateKey(kp.privateJwk),
    )
    const proof = await proofFor('GET', API_URL, forged)

    expect(await authenticate(`DPoP ${forged}`, proof, 'GET', API_URL)).toBeNull()
  })

  test('the published JWKS is the key tokens verify against', async () => {
    const token = await issueToken()
    const { signatureInput, signature } = parseJwt(token)
    const [jwk] = getJwks().keys as any[]
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256', kid: 'appview-oauth-key' })
    expect(jwk.d).toBeUndefined()
    expect(await verifyEs256(await importPublicKey(jwk), signature, signatureInput)).toBe(true)
    // Sanity: the raw signature is the 64-byte P-256 form, not DER.
    expect(base64UrlDecode(token.split('.')[2])).toHaveLength(64)
  })
})

describe('restart', () => {
  test('a restart reuses the stored keys, so tokens and PDS sessions survive it', async () => {
    // A PDS binds each session to the kid that authenticated it, and every
    // issued access token is signed by ours. Regenerating either on boot
    // would sign everyone out for no reason.
    await seedCompletedRequest()
    const { access_token } = await handleToken(config, codeGrant(), await proofFor('POST', TOKEN_URL), TOKEN_URL)
    const before = { server: getJwks().keys[0], client: getClientJwks().keys[0] }

    await initOAuth(config, 'http://plc.test', 'ws://relay.test')

    expect(getJwks().keys[0]).toEqual(before.server)
    expect(getClientJwks().keys[0]).toEqual(before.client)
    const proof = await proofFor('GET', API_URL, access_token)
    expect(await authenticate(`DPoP ${access_token}`, proof, 'GET', API_URL)).toEqual({ did: DID })
  })
})
