import { beforeAll, describe, expect, test } from 'vitest'
import { createDpopProof, parseDpopProof } from '../src/oauth/dpop.ts'
import {
  base64UrlEncode,
  computeJwkThumbprint,
  createJwt,
  generateKeyPair,
  importPrivateKey,
  parseJwt,
  sha256,
  signEs256,
  signJwt,
} from '../src/oauth/crypto.ts'

// A DPoP proof binds a request to a key. The parser is the whole check on the
// server side, so every field it looks at gets a test that forges that field
// alone and expects a refusal; the builder is what hatk sends to PDSes, so its
// output has to survive that same parser and carry what a PDS reads.

const URL_ = 'https://example.app/oauth/token'

let priv: JsonWebKey
let pub: JsonWebKey
let jkt: string

beforeAll(async () => {
  const kp = await generateKeyPair()
  priv = kp.privateJwk
  pub = kp.publicJwk
  jkt = await computeJwkThumbprint(pub)
})

/** A proof with one claim overridden, signed with the real key. */
async function forge(overrides: {
  header?: Record<string, unknown>
  payload?: Record<string, unknown>
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y },
    ...overrides.header,
  }
  const payload = { jti: 'jti-1', htm: 'POST', htu: URL_, iat: now, ...overrides.payload }
  return signJwt(header, payload, await importPrivateKey(priv))
}

describe('createDpopProof', () => {
  test('carries only the public half of the key', async () => {
    const proof = await createDpopProof(priv, pub, 'POST', URL_)
    const { header } = parseJwt(proof)

    expect(header.typ).toBe('dpop+jwt')
    expect(header.alg).toBe('ES256')
    expect(header.jwk).toEqual({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y })
    // The private component and any JWK metadata (kid, alg, use) must not leak.
    expect(header.jwk.d).toBeUndefined()
    expect(Object.keys(header.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y'])
  })

  test('names the method and URL, with the query stripped from htu', async () => {
    // RFC 9449 §4.2: htu is the URL without query or fragment.
    const proof = await createDpopProof(priv, pub, 'GET', `${URL_}?foo=bar`)
    const { payload } = parseJwt(proof)

    expect(payload.htm).toBe('GET')
    expect(payload.htu).toBe(URL_)
    expect(payload.jti).toBeTruthy()
    expect(Math.abs(payload.iat - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2)
  })

  test('every proof has a fresh jti', async () => {
    const a = parseJwt(await createDpopProof(priv, pub, 'POST', URL_)).payload.jti
    const b = parseJwt(await createDpopProof(priv, pub, 'POST', URL_)).payload.jti
    expect(a).not.toBe(b)
  })

  test('binds an access token by its hash and omits ath without one', async () => {
    const withToken = parseJwt(await createDpopProof(priv, pub, 'POST', URL_, 'the-token')).payload
    const without = parseJwt(await createDpopProof(priv, pub, 'POST', URL_)).payload

    expect(withToken.ath).toBe(base64UrlEncode(await sha256('the-token')))
    expect(without.ath).toBeUndefined()
  })

  test('echoes a server nonce only when given one', async () => {
    const withNonce = parseJwt(await createDpopProof(priv, pub, 'POST', URL_, undefined, 'n-1')).payload
    const without = parseJwt(await createDpopProof(priv, pub, 'POST', URL_)).payload

    expect(withNonce.nonce).toBe('n-1')
    expect(without.nonce).toBeUndefined()
  })

  test('is accepted by the parser with the expected key and token', async () => {
    const proof = await createDpopProof(priv, pub, 'POST', URL_, 'the-token')
    const result = await parseDpopProof(proof, 'POST', URL_, jkt, 'the-token')

    expect(result.jkt).toBe(jkt)
    expect(result.jwk).toEqual(parseJwt(proof).header.jwk)
    expect(result.jti).toBe(parseJwt(proof).payload.jti)
  })
})

describe('parseDpopProof', () => {
  test('returns the key thumbprint, jti and iat of a valid proof', async () => {
    const proof = await forge({})
    const result = await parseDpopProof(proof, 'POST', URL_)

    expect(result.jkt).toBe(jkt)
    expect(result.jti).toBe('jti-1')
    expect(typeof result.iat).toBe('number')
  })

  test('refuses a typ other than dpop+jwt', async () => {
    // An access token replayed as a proof must not pass as one.
    await expect(parseDpopProof(await forge({ header: { typ: 'JWT' } }), 'POST', URL_)).rejects.toThrow(/typ/)
  })

  test('refuses an alg other than ES256', async () => {
    await expect(parseDpopProof(await forge({ header: { alg: 'HS256' } }), 'POST', URL_)).rejects.toThrow(/ES256/)
  })

  test('refuses a proof with no EC key in the header', async () => {
    await expect(parseDpopProof(await forge({ header: { jwk: { kty: 'RSA' } } }), 'POST', URL_)).rejects.toThrow(
      /EC key/,
    )
    await expect(parseDpopProof(await forge({ header: { jwk: undefined } }), 'POST', URL_)).rejects.toThrow(/EC key/)
  })

  test('refuses a signature made by a different key', async () => {
    // Header claims our key; signature comes from another. Binding to the
    // header key is the point, so this is the forgery that matters most.
    const other = await generateKeyPair()
    const now = Math.floor(Date.now() / 1000)
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } }
    const payload = { jti: 'j', htm: 'POST', htu: URL_, iat: now }
    const input = new TextEncoder().encode(
      `${base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))}.${base64UrlEncode(
        new TextEncoder().encode(JSON.stringify(payload)),
      )}`,
    )
    const sig = await signEs256(await importPrivateKey(other.privateJwk), input)
    const proof = createJwt(header, payload, sig)

    await expect(parseDpopProof(proof, 'POST', URL_)).rejects.toThrow(/signature invalid/)
  })

  test('refuses a proof for a different method', async () => {
    await expect(parseDpopProof(await forge({ payload: { htm: 'GET' } }), 'POST', URL_)).rejects.toThrow(/htm mismatch/)
  })

  test('refuses a proof for a different URL', async () => {
    await expect(
      parseDpopProof(await forge({ payload: { htu: 'https://other.app/oauth/token' } }), 'POST', URL_),
    ).rejects.toThrow(/htu mismatch/)
  })

  test('htu comparison ignores query, trailing slash and case', async () => {
    // Proxies and clients disagree about these; RFC 9449 says compare without
    // the query and none of them should cost a login.
    const proof = await forge({ payload: { htu: 'HTTPS://EXAMPLE.APP/oauth/token/' } })
    await expect(parseDpopProof(proof, 'POST', `${URL_}?x=1`)).resolves.toBeTruthy()
  })

  test('refuses a proof issued too long ago', async () => {
    const stale = Math.floor(Date.now() / 1000) - 301
    await expect(parseDpopProof(await forge({ payload: { iat: stale } }), 'POST', URL_)).rejects.toThrow(
      /expired or invalid iat/,
    )
  })

  test('refuses a proof from the future beyond clock skew', async () => {
    const future = Math.floor(Date.now() / 1000) + 61
    await expect(parseDpopProof(await forge({ payload: { iat: future } }), 'POST', URL_)).rejects.toThrow(
      /expired or invalid iat/,
    )
  })

  test('refuses a proof with no iat', async () => {
    await expect(parseDpopProof(await forge({ payload: { iat: undefined } }), 'POST', URL_)).rejects.toThrow(
      /expired or invalid iat/,
    )
  })

  test('refuses a proof with no jti', async () => {
    // Without a jti there is nothing for replay detection to key on.
    await expect(parseDpopProof(await forge({ payload: { jti: undefined } }), 'POST', URL_)).rejects.toThrow(
      /missing jti/,
    )
  })

  test('refuses a valid proof from a key other than the one expected', async () => {
    // The token was bound to one key at PAR; a proof from a different key,
    // however well-formed, is someone else.
    const other = await generateKeyPair()
    const proof = await createDpopProof(other.privateJwk, other.publicJwk, 'POST', URL_)

    await expect(parseDpopProof(proof, 'POST', URL_, jkt)).rejects.toThrow(/key mismatch/)
  })

  test('refuses a proof whose ath does not hash the presented token', async () => {
    const proof = await createDpopProof(priv, pub, 'POST', URL_, 'token-a')

    await expect(parseDpopProof(proof, 'POST', URL_, undefined, 'token-b')).rejects.toThrow(/ath mismatch/)
  })

  test('a proof without ath is refused when a token is presented', async () => {
    const proof = await createDpopProof(priv, pub, 'POST', URL_)

    await expect(parseDpopProof(proof, 'POST', URL_, undefined, 'token-a')).rejects.toThrow(/ath mismatch/)
  })

  test('ath is not required when no token is presented', async () => {
    // PAR and the token endpoint are called before any access token exists.
    const proof = await createDpopProof(priv, pub, 'POST', URL_)
    await expect(parseDpopProof(proof, 'POST', URL_)).resolves.toBeTruthy()
  })
})
