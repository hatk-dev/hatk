/**
 * Minimal CBOR (RFC 8949) decoder with DAG-CBOR CID support.
 *
 * Returns `{ value, offset }` so callers can decode concatenated CBOR values —
 * the AT Protocol firehose sends frames as two back-to-back CBOR items
 * (header + body).
 *
 * DAG-CBOR tag 42 (CID links) are decoded as `{ $link: "bafy..." }` objects,
 * matching the convention used by the AT Protocol.
 *
 * @see https://www.rfc-editor.org/rfc/rfc8949 — CBOR spec
 * @see https://ipld.io/specs/codecs/dag-cbor/spec/ — DAG-CBOR spec
 * @module
 */

import { cidToString } from './cid.ts'

/** CBOR tag number for DAG-CBOR CID links. */
const CBOR_TAG_CID = 42

interface DecodeResult {
  /** The decoded JavaScript value. */
  value: any
  /** Byte offset immediately after the decoded value — use as `startOffset` to decode the next item. */
  offset: number
}

/**
 * Decodes a single CBOR value from a byte array.
 *
 * Supports all major types: unsigned/negative integers, byte/text strings,
 * arrays, maps, tags (with special handling for CID tag 42), and simple
 * values (true, false, null).
 *
 * @param bytes - Raw CBOR bytes
 * @param startOffset - Byte position to start decoding from (default `0`)
 * @returns The decoded value and the offset of the next byte after it
 *
 * @example
 * ```ts
 * // Decode a single value
 * const { value } = cborDecode(bytes)
 *
 * // Decode two concatenated values (firehose frame)
 * const { value: header, offset } = cborDecode(frameBytes)
 * const { value: body } = cborDecode(frameBytes, offset)
 * ```
 */
export function cborDecode(bytes: Uint8Array, startOffset = 0): DecodeResult {
  let offset = startOffset

  function read(): any {
    const initial = bytes[offset++]
    const major = initial >> 5
    const info = initial & 0x1f

    let length = info
    if (info === 24) length = bytes[offset++]
    else if (info === 25) {
      length = (bytes[offset++] << 8) | bytes[offset++]
    } else if (info === 26) {
      length = bytes[offset++] * 0x1000000 + bytes[offset++] * 0x10000 + bytes[offset++] * 0x100 + bytes[offset++]
    } else if (info === 27) {
      // 8-byte integer — read as Number (safe up to 2^53)
      length =
        bytes[offset++] * 0x100000000000000 +
        bytes[offset++] * 0x1000000000000 +
        bytes[offset++] * 0x10000000000 +
        bytes[offset++] * 0x100000000 +
        bytes[offset++] * 0x1000000 +
        bytes[offset++] * 0x10000 +
        bytes[offset++] * 0x100 +
        bytes[offset++]
    }

    switch (major) {
      case 0:
        return length // unsigned int
      case 1:
        return -1 - length // negative int
      case 2: {
        // byte string — use subarray (view, no copy)
        const data = bytes.subarray(offset, offset + length)
        offset += length
        return data
      }
      case 3: {
        // text string
        const data = new TextDecoder().decode(bytes.subarray(offset, offset + length))
        offset += length
        return data
      }
      case 4: {
        // array
        const arr: any[] = []
        for (let i = 0; i < length; i++) arr.push(read())
        return arr
      }
      case 5: {
        // map
        const obj: Record<string, any> = {}
        for (let i = 0; i < length; i++) {
          const key = read() as string
          obj[key] = read()
        }
        return obj
      }
      case 6: {
        // tag
        const taggedValue = read()
        if (length === CBOR_TAG_CID) {
          // DAG-CBOR CID link: strip 0x00 multibase prefix, return as { $link }
          return { $link: cidToString(taggedValue.slice(1)) }
        }
        return taggedValue
      }
      case 7: {
        // special values
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        return undefined
      }
    }
  }

  const value = read()
  return { value, offset }
}
