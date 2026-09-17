import { expect, test } from 'vitest'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { decodeBase58btc, parseMultibaseKey, SignatureError, verifySignature } from '../src/spaces/verify.ts'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58btc(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let leading = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    leading += '1'
  }
  return (
    leading +
    digits
      .reverse()
      .map((d) => BASE58[d])
      .join('')
  )
}

function multikey(prefix: number[], key: Uint8Array): string {
  return 'z' + encodeBase58btc(new Uint8Array([...prefix, ...key]))
}

const SECP_PREFIX = [0xe7, 0x01]
const P256_PREFIX = [0x80, 0x24]

// --- base58btc ---

test('decodes a known base58btc vector', () => {
  expect(new TextDecoder().decode(decodeBase58btc('StV1DL6CwTryKyV'))).toBe('hello world')
})

test('leading zero bytes survive the round trip', () => {
  // Every leading zero is a '1' the arithmetic would otherwise drop, and a
  // dropped one shifts the multicodec prefix and misreads the curve.
  const bytes = new Uint8Array([0, 0, 1, 2, 3])
  expect([...decodeBase58btc(encodeBase58btc(bytes))]).toEqual([0, 0, 1, 2, 3])
})

test('an empty string decodes to no bytes', () => {
  expect(decodeBase58btc('')).toHaveLength(0)
})

test('a character outside the alphabet is refused', () => {
  // '0', 'O', 'I' and 'l' are excluded precisely because they are confusable.
  expect(() => decodeBase58btc('abc0def')).toThrow(SignatureError)
})

// --- Multikeys ---

test('a secp256k1 key is recognised by its multicodec prefix', () => {
  const pub = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
  const parsed = parseMultibaseKey(multikey(SECP_PREFIX, pub))
  expect(parsed.curve).toBe('secp256k1')
  expect([...parsed.bytes]).toEqual([...pub])
})

test('a p256 key is recognised by its own prefix', () => {
  const pub = p256.getPublicKey(p256.utils.randomSecretKey(), true)
  const parsed = parseMultibaseKey(multikey(P256_PREFIX, pub))
  expect(parsed.curve).toBe('p256')
  expect([...parsed.bytes]).toEqual([...pub])
})

test('a key that is not multibase is refused', () => {
  expect(() => parseMultibaseKey('QmNotMultibase')).toThrow(/not base58btc multibase/)
})

test('a curve atproto does not allow is refused rather than guessed', () => {
  const pub = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
  expect(() => parseMultibaseKey(multikey([0xed, 0x01], pub))).toThrow(/neither secp256k1 nor p256/)
})

// --- Signatures ---

function sign(curve: typeof secp256k1 | typeof p256, message: string) {
  const priv = curve.utils.randomSecretKey()
  const pub = curve.getPublicKey(priv, true)
  const signature = curve.sign(sha256(new TextEncoder().encode(message)), priv)
  return { pub, signature }
}

test('a real secp256k1 signature verifies', () => {
  // The curve most did:plc accounts sign with, and the one WebCrypto does not
  // implement — the whole reason this module exists.
  const { pub, signature } = sign(secp256k1, 'a notice')
  const key = parseMultibaseKey(multikey(SECP_PREFIX, pub))
  expect(verifySignature(key, signature, new TextEncoder().encode('a notice'))).toBe(true)
})

test('a real p256 signature verifies', () => {
  const { pub, signature } = sign(p256, 'a notice')
  const key = parseMultibaseKey(multikey(P256_PREFIX, pub))
  expect(verifySignature(key, signature, new TextEncoder().encode('a notice'))).toBe(true)
})

test('a signature over different bytes does not verify', () => {
  const { pub, signature } = sign(secp256k1, 'a notice')
  const key = parseMultibaseKey(multikey(SECP_PREFIX, pub))
  expect(verifySignature(key, signature, new TextEncoder().encode('another notice'))).toBe(false)
})

test('a signature is not accepted against a different key', () => {
  const { signature } = sign(secp256k1, 'a notice')
  const other = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
  const key = parseMultibaseKey(multikey(SECP_PREFIX, other))
  expect(verifySignature(key, signature, new TextEncoder().encode('a notice'))).toBe(false)
})

test('a signature of the wrong length is refused before any curve maths', () => {
  const { pub } = sign(secp256k1, 'a notice')
  const key = parseMultibaseKey(multikey(SECP_PREFIX, pub))
  expect(verifySignature(key, new Uint8Array(32), new TextEncoder().encode('a notice'))).toBe(false)
})

test('a signature naming the wrong curve fails rather than throwing', () => {
  const { pub, signature } = sign(secp256k1, 'a notice')
  const mislabelled = parseMultibaseKey(multikey(P256_PREFIX, pub))
  expect(verifySignature(mislabelled, signature, new TextEncoder().encode('a notice'))).toBe(false)
})

test('a garbage key fails verification instead of crashing', () => {
  const key = { curve: 'secp256k1' as const, bytes: new Uint8Array(33).fill(9) }
  expect(verifySignature(key, new Uint8Array(64), new TextEncoder().encode('x'))).toBe(false)
})
