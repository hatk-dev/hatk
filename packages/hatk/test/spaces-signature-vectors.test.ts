/**
 * Fixed signatures from the library atproto signs with.
 *
 * Every other test of this module makes its signature by calling the same
 * curve library it then verifies with, so an error in how that library is
 * called cancels out and the suite stays green while no real counterparty can
 * be verified. That happened: @noble/curves hashes the message again unless
 * told the argument is already a digest, and a community host's write notices
 * were refused for a day with the tests passing throughout.
 *
 * These bytes were produced by @noble/curves 1.9.7 — the version
 * `@atproto/crypto` uses — signing `sha256(message)` with low-S and taking the
 * compact 64-byte form, which is exactly what `Secp256k1Keypair.sign` does.
 * They are constants on purpose: nothing here can drift with them.
 */
import { expect, test } from 'vitest'
import { verifySignature } from '../src/spaces/verify.ts'

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'))

/** The `header.payload` of a notice JWT, signed as-is. */
const MESSAGE = new TextEncoder().encode(
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NksifQ.eyJpc3MiOiJkaWQ6cGxjOmF1dGhvcml0eSIsImF1ZCI6ImRpZDp3ZWI6YXBwdmlldy50ZXN0I2F0cHJvdG9fc3BhY2Vfc3luY2VyIiwibHhtIjoiY29tLmF0cHJvdG8uc3BhY2Uubm90aWZ5V3JpdGUiLCJleHAiOjQxMDI0NDQ4MDB9',
)

const VECTORS = {
  secp256k1: {
    pub: '034646ae5047316b4230d0086c8acec687f00b1cd9d1dc634f6cb358ac0a9a8fff',
    sig: '413bc9ce80356d9a7d4511d5d869b1aa01de3fd821365365af91b7ec6170f16078090759c2410a8e5648b15e512dcbb7b5e275e759f97025f4ae0c7e5b4cd44f',
  },
  p256: {
    pub: '02557b119063cf7ca9f131b4c4e36917e9b2c53f9799a2007e7bfec044be1ed541',
    sig: '4a948cde546287f5d10554e1fc965b3349af361101de52c8df1a5e73b76afc3e26413f6fb9242a30c004d91f1e879b2e55fec2fb4db4e564d12ad6fb563553a7',
  },
} as const

for (const curve of ['secp256k1', 'p256'] as const) {
  test(`a ${curve} signature made the way atproto makes one verifies`, () => {
    const { pub, sig } = VECTORS[curve]
    expect(verifySignature({ curve, bytes: bytes(pub) }, bytes(sig), MESSAGE)).toBe(true)
  })

  test(`a ${curve} signature over different bytes does not`, () => {
    const { pub, sig } = VECTORS[curve]
    const other = new TextEncoder().encode('eyJ0eXAiOiJKV1QifQ.eyJpc3MiOiJkaWQ6cGxjOnNvbWVib2R5In0')
    expect(verifySignature({ curve, bytes: bytes(pub) }, bytes(sig), other)).toBe(false)
  })

  test(`a ${curve} signature does not verify against the other curve's key`, () => {
    const { sig } = VECTORS[curve]
    const otherCurve = curve === 'secp256k1' ? 'p256' : 'secp256k1'
    expect(verifySignature({ curve, bytes: bytes(VECTORS[otherCurve].pub) }, bytes(sig), MESSAGE)).toBe(false)
  })
}
