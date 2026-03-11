// CID (Content Identifier) + base32 + varint — from scratch
// CIDs are self-describing content hashes used throughout AT Protocol

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

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

export function cidToString(cidBytes: Uint8Array): string {
  // base32lower with 'b' multibase prefix
  return `b${base32Encode(cidBytes)}`
}

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
