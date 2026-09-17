import { expect, test } from 'vitest'
import { cborDecode } from '../src/cbor.ts'
import { CidLink, cborEncode, cidFor } from './firehose-frame.ts'

// The firehose puts two CBOR items back to back (header, then body) and the
// relay never pads between them, so the decoder's returned offset has to land
// exactly on the next item. Most of the width variants below (1/2/4/8-byte
// lengths, negative ints, non-CID tags) never show up in the fixture encoder,
// so they are hand-assembled from the RFC 8949 byte layout.

function bytes(...b: number[]): Uint8Array {
  return new Uint8Array(b)
}

test('decodes the values the fixture encoder produces, round trip', () => {
  const value = {
    text: 'hello',
    n: 42,
    ok: true,
    nothing: null,
    list: [1, 'two', false],
    nested: { deep: { deeper: 'yes' } },
  }
  expect(cborDecode(cborEncode(value)).value).toEqual(value)
})

test('returns the offset just past the item so concatenated items can be walked', () => {
  const first = cborEncode({ op: 1, t: '#commit' })
  const second = cborEncode({ seq: 7 })
  const frame = new Uint8Array([...first, ...second])

  const head = cborDecode(frame)
  expect(head.offset).toBe(first.length)
  expect(head.value).toEqual({ op: 1, t: '#commit' })

  const body = cborDecode(frame, head.offset)
  expect(body.value).toEqual({ seq: 7 })
  expect(body.offset).toBe(frame.length)
})

test('reads unsigned integers in every argument width', () => {
  expect(cborDecode(bytes(0x17)).value).toBe(23) // inline
  expect(cborDecode(bytes(0x18, 0xff)).value).toBe(255) // 1-byte
  expect(cborDecode(bytes(0x19, 0x01, 0x00)).value).toBe(256) // 2-byte
  expect(cborDecode(bytes(0x1a, 0x00, 0x01, 0x00, 0x00)).value).toBe(65536) // 4-byte
  // 8-byte: 2^32 + 1, which would overflow a 32-bit shift-based decoder
  expect(cborDecode(bytes(0x1b, 0, 0, 0, 1, 0, 0, 0, 1)).value).toBe(4294967297)
})

test('4-byte lengths above 2^31 are not read as negative', () => {
  // 0xff000000 flips the sign bit; a `<<`-based decoder would produce a negative length
  expect(cborDecode(bytes(0x1a, 0xff, 0x00, 0x00, 0x00)).value).toBe(0xff000000)
})

test('decodes negative integers as -1 - n', () => {
  expect(cborDecode(bytes(0x20)).value).toBe(-1)
  expect(cborDecode(bytes(0x29)).value).toBe(-10)
  expect(cborDecode(bytes(0x38, 0x63)).value).toBe(-100)
})

test('byte strings come back as a view over the input, not a copy', () => {
  const input = cborEncode(new Uint8Array([1, 2, 3, 4]))
  const { value } = cborDecode(input)
  expect(value).toBeInstanceOf(Uint8Array)
  expect(Array.from(value)).toEqual([1, 2, 3, 4])
  // Same backing buffer: CAR block payloads can be many MB and must not be duplicated
  expect(value.buffer).toBe(input.buffer)
})

test('text strings decode as UTF-8', () => {
  const s = 'héllo — 日本'
  expect(cborDecode(cborEncode(s)).value).toBe(s)
})

test('a text string longer than 255 bytes uses the 2-byte length header', () => {
  const s = 'x'.repeat(300)
  const encoded = cborEncode(s)
  expect(encoded[0]).toBe(0x79) // major 3, info 25
  expect(cborDecode(encoded).value).toBe(s)
})

test('a tag-42 CID link decodes to a { $link } object with the multibase prefix stripped', () => {
  const block = cborEncode({ hello: 'world' })
  const link = cidFor(block)
  const { value } = cborDecode(cborEncode({ ref: link }))
  expect(value).toEqual({ ref: { $link: link.toString() } })
  expect(value.ref.$link).toMatch(/^bafyrei/)
})

test('tags other than 42 are transparent and yield the tagged value', () => {
  // tag 1 (epoch datetime) wrapping the integer 100
  expect(cborDecode(bytes(0xc1, 0x18, 0x64)).value).toBe(100)
})

test('simple values decode to false, true, null, and undefined', () => {
  expect(cborDecode(bytes(0xf4)).value).toBe(false)
  expect(cborDecode(bytes(0xf5)).value).toBe(true)
  expect(cborDecode(bytes(0xf6)).value).toBe(null)
  expect(cborDecode(bytes(0xf7)).value).toBe(undefined)
})

test('empty containers decode to empty containers', () => {
  expect(cborDecode(bytes(0x80)).value).toEqual([])
  expect(cborDecode(bytes(0xa0)).value).toEqual({})
})

test('an array with more than 23 elements uses the 1-byte length header', () => {
  const arr = Array.from({ length: 30 }, (_, i) => i)
  const encoded = cborEncode(arr)
  expect(encoded[0]).toBe(0x98)
  expect(cborDecode(encoded).value).toEqual(arr)
})

test('CID links nested inside arrays decode in place', () => {
  const a = cidFor(cborEncode('a'))
  const b = cidFor(cborEncode('b'))
  const { value } = cborDecode(cborEncode({ links: [a, b] }))
  expect(value.links).toEqual([{ $link: a.toString() }, { $link: b.toString() }])
  expect(a).toBeInstanceOf(CidLink)
})
