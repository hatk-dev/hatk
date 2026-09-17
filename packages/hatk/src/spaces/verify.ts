/**
 * Verifying a signature made by somebody else's atproto signing key.
 *
 * Everything hatk signs, it signs with ES256, because it chose its own keys and
 * WebCrypto implements that curve. Everything it has to *verify* here was
 * signed by an account it does not control, and most `did:plc` accounts sign
 * with secp256k1 — a curve WebCrypto does not implement at all. So the two
 * curves atproto allows are handled explicitly, over @noble/curves.
 *
 * A key arrives as a multibase string in a DID document's verification method
 * (`publicKeyMultibase` on a `Multikey`): base58btc, prefixed with a multicodec
 * varint naming the curve, then the compressed point. The prefix is the only
 * thing that says which curve it is, so it is read rather than guessed.
 */

import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Multicodec varints for the two curves atproto allows. */
const SECP256K1_PREFIX = [0xe7, 0x01]
const P256_PREFIX = [0x80, 0x24]

export type AtprotoCurve = 'secp256k1' | 'p256'

export class SignatureError extends Error {}

/**
 * Decode base58btc. Written out rather than pulled in: it is short, it is the
 * only encoding needed, and a wrong answer here fails closed rather than
 * silently accepting something.
 */
export function decodeBase58btc(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0)
  const bytes: number[] = [0]
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char)
    if (value < 0) throw new SignatureError(`Not base58btc: ${char}`)
    let carry = value
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  // Every leading '1' is a leading zero byte that the arithmetic above drops.
  for (const char of input) {
    if (char !== '1') break
    bytes.push(0)
  }
  return new Uint8Array(bytes.reverse())
}

export interface PublicKey {
  curve: AtprotoCurve
  /** The compressed point, 33 bytes. */
  bytes: Uint8Array
}

/** Read a `publicKeyMultibase` from a DID document's verification method. */
export function parseMultibaseKey(multibase: string): PublicKey {
  if (!multibase.startsWith('z')) throw new SignatureError('Key is not base58btc multibase')
  const decoded = decodeBase58btc(multibase.slice(1))
  const starts = (prefix: number[]) => prefix.every((b, i) => decoded[i] === b)
  if (starts(SECP256K1_PREFIX)) return { curve: 'secp256k1', bytes: decoded.slice(SECP256K1_PREFIX.length) }
  if (starts(P256_PREFIX)) return { curve: 'p256', bytes: decoded.slice(P256_PREFIX.length) }
  throw new SignatureError('Key is neither secp256k1 nor p256')
}

/**
 * Verify a raw `r || s` signature over `message`.
 *
 * Low-S is required — atproto mandates it and a malleable signature would let
 * the same assertion be presented twice with different bytes — and is what
 * @noble enforces by default.
 *
 * `prehash: false` says the second argument is already a digest, and is not
 * optional: @noble/curves hashes it again without it, so every signature from
 * a real counterparty is rejected while one this module both makes and checks
 * still matches. A test that signs through the same call cannot see that, so
 * the vectors in the suite are fixed bytes from the library atproto signs
 * with rather than a round trip through this one.
 */
export function verifySignature(key: PublicKey, signature: Uint8Array, message: Uint8Array): boolean {
  if (signature.length !== 64) return false
  const digest = sha256(message)
  try {
    const curve = key.curve === 'secp256k1' ? secp256k1 : p256
    return curve.verify(signature, digest, key.bytes, { prehash: false })
  } catch {
    // A malformed point or scalar is a failed verification, not a crash.
    return false
  }
}
