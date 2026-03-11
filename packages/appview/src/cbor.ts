// CBOR decoder from scratch (RFC 8949)
// Returns { value, offset } so we can split firehose frames
// (two concatenated CBOR values: header + body)

import { cidToString } from './cid.ts'

const CBOR_TAG_CID = 42

interface DecodeResult {
  value: any
  offset: number
}

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
