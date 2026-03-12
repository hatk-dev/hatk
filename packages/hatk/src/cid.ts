/**
 * CID (Content Identifier), base32, and varint primitives.
 *
 * CIDs are self-describing content hashes used throughout the AT Protocol
 * to reference blocks in repos and CAR files. This module provides the
 * low-level encoding needed to convert raw CID bytes into their string
 * representation (base32lower with `b` multibase prefix).
 *
 * @see https://github.com/multiformats/cid
 * @module
 */

/** RFC 4648 base32 lowercase alphabet (no padding). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Encodes raw bytes as a base32 lowercase string (RFC 4648, no padding).
 *
 * @example
 * ```ts
 * base32Encode(new Uint8Array([0x01, 0x71])) // "afyq"
 * ```
 */
export function base32Encode(bytes: Uint8Array): string {
  let result = ''
  let bits = 0
  let value = 0

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += BASE32_ALPHABET[(value >> bits) & 31]
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }

  return result
}

/**
 * Converts raw CID bytes to their multibase-encoded string form (`b` prefix + base32lower).
 *
 * @example
 * ```ts
 * cidToString(cidBytes) // "bafyreig..."
 * ```
 */
export function cidToString(cidBytes: Uint8Array): string {
  return `b${base32Encode(cidBytes)}`
}

/**
 * Reads an unsigned LEB128 varint from a byte array.
 *
 * Varints are used extensively in CID encoding and CAR framing to represent
 * variable-length integers in a compact form.
 *
 * @param bytes - Source byte array
 * @param offset - Position to start reading from
 * @returns A tuple of `[value, nextOffset]`
 */
export function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0
  let shift = 0
  let pos = offset

  while (pos < bytes.length) {
    const byte = bytes[pos++]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [value, pos]
    shift += 7
    if (shift > 35) throw new Error('Varint too long')
  }

  throw new Error('Unexpected end of varint')
}
