import { expect, test } from 'vitest'
import { base32Encode, cidToString, readVarint } from '../src/cid.ts'
import { cborEncode, cidFor } from './firehose-frame.ts'

// CID strings are the keys of every block map and every record row's `cid`
// column, so the base32 output has to match what the rest of the network
// produces byte for byte — a wrong final-group pad, for instance, would make
// every CID from a CAR disagree with the same CID from Jetstream JSON.

test('base32Encode matches the RFC 4648 test vectors (lowercase, unpadded)', () => {
  const enc = (s: string) => base32Encode(new TextEncoder().encode(s))
  expect(enc('')).toBe('')
  expect(enc('f')).toBe('my')
  expect(enc('fo')).toBe('mzxq')
  expect(enc('foo')).toBe('mzxw6')
  expect(enc('foob')).toBe('mzxw6yq')
  expect(enc('fooba')).toBe('mzxw6ytb')
  expect(enc('foobar')).toBe('mzxw6ytboi')
})

test('base32Encode of a CID prefix matches the documented example', () => {
  expect(base32Encode(new Uint8Array([0x01, 0x71]))).toBe('afyq')
})

test('cidToString prefixes the base32 body with the multibase b', () => {
  const block = cborEncode({ x: 1 })
  const link = cidFor(block)
  expect(cidToString(link.bytes)).toBe(link.toString())
  expect(cidToString(link.bytes).startsWith('bafyrei')).toBe(true)
})

test('cidToString agrees with the independently-computed fixture string', () => {
  // The fixture's CidLink.toString uses Node's Buffer-free path through base32Encode
  // as well, so cross-check against a hand-built expectation for a dag-cbor sha256 CID
  // of a known block: the empty map.
  const empty = cborEncode({})
  expect(cidToString(cidFor(empty).bytes)).toBe('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua')
})

test('readVarint reads single-byte values and reports the next offset', () => {
  expect(readVarint(new Uint8Array([0x05]), 0)).toEqual([5, 1])
  expect(readVarint(new Uint8Array([0x00, 0x7f]), 1)).toEqual([127, 2])
})

test('readVarint decodes multi-byte LEB128 values', () => {
  expect(readVarint(new Uint8Array([0x80, 0x01]), 0)).toEqual([128, 2])
  expect(readVarint(new Uint8Array([0xac, 0x02]), 0)).toEqual([300, 2])
  // 4-byte: 2^21
  expect(readVarint(new Uint8Array([0x80, 0x80, 0x80, 0x01]), 0)).toEqual([2097152, 4])
})

test('readVarint starts at the given offset rather than the buffer start', () => {
  const buf = new Uint8Array([0xff, 0xff, 0xac, 0x02, 0x99])
  expect(readVarint(buf, 2)).toEqual([300, 4])
})

test('readVarint throws when the continuation bit runs off the end of the buffer', () => {
  // A truncated CAR block header must not be silently read as a small length
  expect(() => readVarint(new Uint8Array([0x80, 0x80]), 0)).toThrow('Unexpected end of varint')
  expect(() => readVarint(new Uint8Array([]), 0)).toThrow('Unexpected end of varint')
})

test('readVarint rejects a varint longer than the 35-bit ceiling', () => {
  // Six continuation bytes exceeds anything a CAR header or block length needs;
  // treating it as valid would let a corrupt stream request a giant allocation.
  const runaway = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])
  expect(() => readVarint(runaway, 0)).toThrow('Varint too long')
})
