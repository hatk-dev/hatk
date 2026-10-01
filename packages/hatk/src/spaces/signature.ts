/**
 * The HTTP message signature a space credential travels with.
 *
 * RFC 9421, under the label `atproto-space`, signed ecdsa-p256-sha256 by a key
 * made for one credential and named by its did:key. Two shapes:
 *
 *   exchange   the delegation token is signed alone, and the signature names
 *              its key — that key is what the authority binds the credential
 *              to (`cnf.kid`)
 *   use        the credential is signed together with the DID the request is
 *              addressed to, so a credential lifted off one request cannot be
 *              replayed at another account by anyone without the key
 *
 * The signature is the raw 64-byte r || s, normalized to low-S: the reference
 * verifier accepts either, but a stricter one (noble's default) only low-S.
 */

import { signEs256 } from '../oauth/crypto.ts'

const LABEL = 'atproto-space'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Encode base58btc. The inverse of `decodeBase58btc` in verify.ts. */
export function encodeBase58btc(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    out += '1'
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]]
  return out
}

export interface SpaceSigKey {
  /** The public key as a P-256 did:key. */
  did: string
  sign: (data: Uint8Array) => Promise<Uint8Array>
}

/** A fresh P-256 key, held in memory only and never exported. */
export async function generateSpaceSigKey(): Promise<SpaceSigKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  // 0x04 || x || y. A did:key carries the compressed point behind the
  // p256-pub multicodec prefix (0x1200, varint 0x80 0x24).
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const compressed = new Uint8Array(33)
  compressed[0] = raw[64] & 1 ? 0x03 : 0x02
  compressed.set(raw.subarray(1, 33), 1)
  return {
    did: `did:key:z${encodeBase58btc(new Uint8Array([0x80, 0x24, ...compressed]))}`,
    sign: (data) => signEs256(pair.privateKey, data),
  }
}

/**
 * The bytes a signature covers: one line per covered field, then the
 * signature parameters, joined by LF with no trailing newline.
 */
export function signatureBase(authorization: string, params: string, audience?: string): Uint8Array {
  const lines = [`"authorization": ${authorization}`]
  if (audience !== undefined) lines.push(`"atproto-space-audience": ${audience}`)
  lines.push(`"@signature-params": ${params}`)
  return new TextEncoder().encode(lines.join('\n'))
}

/**
 * Authorization, audience and signature headers for a space request. Without
 * an audience this is the exchange; with one, a use of the credential.
 */
export async function spaceSigHeaders(
  key: SpaceSigKey,
  authorization: string,
  audience?: string,
): Promise<Record<string, string>> {
  const params =
    audience === undefined ? `("authorization");keyid="${key.did}"` : '("authorization" "atproto-space-audience")'
  const signature = await key.sign(signatureBase(authorization, params, audience))
  return {
    Authorization: authorization,
    ...(audience !== undefined ? { 'Atproto-Space-Audience': audience } : {}),
    'Signature-Input': `${LABEL}=${params}`,
    Signature: `${LABEL}=:${Buffer.from(signature).toString('base64')}:`,
  }
}
