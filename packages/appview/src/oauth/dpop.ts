// packages/appview/src/oauth/dpop.ts

import {
  parseJwt,
  importPublicKey,
  verifyEs256,
  computeJwkThumbprint,
  sha256,
  base64UrlEncode,
  signJwt,
  importPrivateKey,
} from './crypto.ts'

export interface DpopResult {
  jkt: string
  jti: string
  iat: number
  jwk: JsonWebKey
}

/** Validate a DPoP proof JWT from a client request. */
export async function parseDpopProof(
  proof: string,
  method: string,
  url: string,
  expectedJkt?: string,
  accessToken?: string,
): Promise<DpopResult> {
  const { header, payload, signatureInput, signature } = parseJwt(proof)

  if (header.typ !== 'dpop+jwt') throw new Error('DPoP proof must have typ dpop+jwt')
  if (header.alg !== 'ES256') throw new Error('DPoP proof must use ES256')
  if (!header.jwk || header.jwk.kty !== 'EC') throw new Error('DPoP proof must contain EC key')

  const publicKey = await importPublicKey(header.jwk)
  const valid = await verifyEs256(publicKey, signature, signatureInput)
  if (!valid) throw new Error('DPoP proof signature invalid')

  if (payload.htm !== method) throw new Error('DPoP htm mismatch')

  const normalizeUrl = (u: string) => u.replace(/\/$/, '').split('?')[0].toLowerCase()
  if (normalizeUrl(payload.htu) !== normalizeUrl(url)) throw new Error('DPoP htu mismatch')

  const now = Math.floor(Date.now() / 1000)
  if (!payload.iat || payload.iat > now + 60 || payload.iat < now - 300) {
    throw new Error('DPoP proof expired or invalid iat')
  }
  if (!payload.jti) throw new Error('DPoP proof missing jti')

  const jkt = await computeJwkThumbprint(header.jwk)
  if (expectedJkt && jkt !== expectedJkt) throw new Error('DPoP key mismatch')

  if (accessToken) {
    const tokenHash = await sha256(accessToken)
    const expectedAth = base64UrlEncode(tokenHash)
    if (payload.ath !== expectedAth) throw new Error('DPoP ath mismatch')
  }

  return { jkt, jti: payload.jti, iat: payload.iat, jwk: header.jwk }
}

/** Create a DPoP proof JWT for making requests to a PDS (server-as-client). */
export async function createDpopProof(
  privateJwk: JsonWebKey,
  publicJwk: JsonWebKey,
  method: string,
  url: string,
  accessToken?: string,
  nonce?: string,
): Promise<string> {
  const privateKey = await importPrivateKey(privateJwk)
  const minimalPublicJwk = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }

  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: minimalPublicJwk }
  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: method,
    htu: url.split('?')[0],
    iat: Math.floor(Date.now() / 1000),
  }
  if (accessToken) {
    const hash = await sha256(accessToken)
    payload.ath = base64UrlEncode(hash)
  }
  if (nonce) payload.nonce = nonce

  return signJwt(header, payload, privateKey)
}
