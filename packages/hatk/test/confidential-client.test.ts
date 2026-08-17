import { beforeAll, expect, test } from 'vitest'
import { getClientMetadata, getClientJwks, isConfidentialClient, initOAuth } from '../src/oauth/server.ts'
import { parseJwt, importPublicKey, verifyEs256, base64UrlDecode } from '../src/oauth/crypto.ts'
import { setupFixtureDatabase } from './fixture.ts'
import { OAUTH_DDL } from '../src/oauth/db.ts'
import { runSQL } from '../src/database/db.ts'

// Registering as a confidential client is what buys the 2-year session and
// exempts us from the consent screen atproto forces on every public-client
// authorization request. The PDS decides purely from the metadata document and
// the signature on our client assertion, so both have to be exactly right.

const ISSUER = 'https://example.app'
const LOOPBACK = 'http://127.0.0.1:3000'

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: `${ISSUER}/oauth-client-metadata.json`, client_name: 'test', scope: 'atproto' }],
} as any

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  await initOAuth(config, 'http://plc.test', 'ws://relay.test')
})

test('a hosted deployment registers as confidential', () => {
  expect(isConfidentialClient(ISSUER)).toBe(true)

  const metadata = getClientMetadata(ISSUER, config) as any
  expect(metadata.token_endpoint_auth_method).toBe('private_key_jwt')
  // atproto rejects private_key_jwt metadata that omits the signing alg.
  expect(metadata.token_endpoint_auth_signing_alg).toBe('ES256')
  expect(metadata.jwks_uri).toBe(`${ISSUER}/oauth/client-jwks.json`)
  // jwks and jwks_uri are mutually exclusive upstream.
  expect(metadata.jwks).toBeUndefined()
})

test('a loopback deployment stays public', () => {
  // Local dev has no fetchable jwks_uri, so it must not claim to be confidential.
  expect(isConfidentialClient(LOOPBACK)).toBe(false)

  const metadata = getClientMetadata(LOOPBACK, config) as any
  expect(metadata.token_endpoint_auth_method).toBe('none')
  // atproto rejects a signing alg on a public client.
  expect(metadata.token_endpoint_auth_signing_alg).toBeUndefined()
  expect(metadata.jwks_uri).toBeUndefined()
})

test('the advertised JWKS carries a usable verification key', () => {
  const jwks = getClientJwks()
  expect(jwks.keys).toHaveLength(1)
  const [key] = jwks.keys as any[]
  expect(key.kty).toBe('EC')
  expect(key.crv).toBe('P-256')
  expect(key.alg).toBe('ES256')
  expect(key.use).toBe('sig')
  expect(key.kid).toBeTruthy()
  // Public half only — the private component must never be served.
  expect(key.d).toBeUndefined()
})

test('the client-auth key is distinct from the access-token signing key', async () => {
  const { getJwks } = await import('../src/oauth/server.ts')
  const [clientKey] = getClientJwks().keys as any[]
  const [serverKey] = getJwks().keys as any[]
  // Rotating the access-token key must not invalidate every PDS session, which
  // it would if the two roles shared one key.
  expect(clientKey.kid).not.toBe(serverKey.kid)
  expect(clientKey.x).not.toBe(serverKey.x)
})

test('client assertions verify against the advertised key and claim what a PDS checks', async () => {
  // Drive a real PAR so the assertion is built exactly as it is in production.
  const captured = await captureParBody()

  expect(captured.get('client_assertion_type')).toBe(
    'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
  )
  const assertion = captured.get('client_assertion')!
  expect(assertion).toBeTruthy()

  const { header, payload } = parseJwt(assertion)
  const clientId = `${ISSUER}/oauth-client-metadata.json`

  expect(header.alg).toBe('ES256')
  expect(header.kid).toBe((getClientJwks().keys as any[])[0].kid)
  // RFC 7523: sub identifies the client, aud the authorization server.
  expect(payload.iss).toBe(clientId)
  expect(payload.sub).toBe(clientId)
  expect(payload.aud).toBe('https://pds.test')
  expect(payload.jti).toBeTruthy()
  expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  // Short-lived — a leaked assertion shouldn't be replayable for long.
  expect(payload.exp - payload.iat).toBeLessThanOrEqual(300)

  // And the signature verifies against the key we publish.
  const [jwk] = getClientJwks().keys as any[]
  const publicKey = await importPublicKey(jwk)
  const [h, p, sig] = assertion.split('.')
  const ok = await verifyEs256(publicKey, base64UrlDecode(sig), new TextEncoder().encode(`${h}.${p}`))
  expect(ok).toBe(true)
})

/**
 * Run `serverLogin` against a stubbed PDS and hand back the PAR body it sent.
 */
async function captureParBody(): Promise<URLSearchParams> {
  const { serverLogin } = await import('../src/oauth/server.ts')
  const realFetch = globalThis.fetch
  let parBody: URLSearchParams | undefined

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url

    if (url.includes('.well-known/oauth-protected-resource')) {
      return jsonResponse({ authorization_servers: ['https://pds.test'] })
    }
    if (url.includes('.well-known/oauth-authorization-server')) {
      return jsonResponse({
        issuer: 'https://pds.test',
        pushed_authorization_request_endpoint: 'https://pds.test/oauth/par',
        authorization_endpoint: 'https://pds.test/oauth/authorize',
        token_endpoint: 'https://pds.test/oauth/token',
      })
    }
    if (url.includes('/oauth/par')) {
      parBody = new URLSearchParams(init.body)
      return jsonResponse({ request_uri: 'urn:req:1', expires_in: 300 })
    }
    return jsonResponse({})
  }) as any

  try {
    await serverLogin(config, '', { prompt: 'create', pds: 'pds.test' })
  } finally {
    globalThis.fetch = realFetch
  }

  if (!parBody) throw new Error('PAR was never sent')
  return parBody
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
