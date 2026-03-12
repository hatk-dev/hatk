/**
 * CAR (Content Addressable aRchive) parser.
 *
 * CAR files bundle content-addressed blocks into a single binary container.
 * They're used by the AT Protocol firehose (`com.atproto.sync.getRepo`) to
 * deliver entire repos and by commit events to deliver individual changes.
 *
 * Format: `varint(headerLen) | CBOR(header) | block*`
 * Each block: `varint(blockLen) | CID | data`
 *
 * @see https://ipld.io/specs/transport/car/carv1/
 * @module
 */

import { cborDecode } from './cbor.ts'
import { cidToString, readVarint } from './cid.ts'

/**
 * Parses a CID (Content Identifier) from raw bytes at the given offset.
 *
 * Handles both CIDv0 (bare SHA-256 multihash, starts with `0x12`) and
 * CIDv1 (version + codec + multihash with varint-encoded lengths).
 *
 * @returns A tuple of `[cidBytes, nextOffset]`
 */
function parseCidFromBytes(bytes: Uint8Array, offset: number): [Uint8Array, number] {
  const firstByte = bytes[offset]

  if (firstByte === 0x12) {
    // CIDv0: SHA-256 multihash (0x12 = sha2-256, 0x20 = 32 bytes)
    return [bytes.slice(offset, offset + 34), offset + 34]
  }

  // CIDv1: version + codec + multihash
  let pos = offset
  const [version, afterVersion] = readVarint(bytes, pos)
  if (version !== 1) throw new Error(`Unsupported CID version: ${version}`)
  pos = afterVersion

  const [_codec, afterCodec] = readVarint(bytes, pos)
  pos = afterCodec

  const [_hashFn, afterHashFn] = readVarint(bytes, pos)
  pos = afterHashFn

  const [digestLen, afterDigestLen] = readVarint(bytes, pos)
  pos = afterDigestLen + digestLen

  return [bytes.slice(offset, pos), pos]
}

/**
 * Parses a CARv1 binary frame into its root CIDs and block map.
 *
 * @param carBytes - Raw CAR file bytes (e.g. from `getRepo` or a firehose commit)
 * @returns `roots` — ordered list of root CID strings; `blocks` — map of CID string → raw block data
 *
 * @example
 * ```ts
 * const car = new Uint8Array(await res.arrayBuffer())
 * const { roots, blocks } = parseCarFrame(car)
 * const commitData = blocks.get(roots[0])
 * ```
 */
export function parseCarFrame(carBytes: Uint8Array): {
  roots: string[]
  blocks: Map<string, Uint8Array>
} {
  let offset = 0

  // Read header length (varint-prefixed CBOR)
  const [headerLen, afterHeaderLen] = readVarint(carBytes, offset)
  offset = afterHeaderLen

  // Decode header CBOR
  const headerSlice = carBytes.slice(offset, offset + headerLen)
  const { value: header } = cborDecode(headerSlice)
  offset += headerLen

  // Our CBOR decoder converts tag-42 CIDs to { $link: "b..." } objects,
  // so roots may already be decoded strings
  const roots = (header.roots || []).map((root: any) => root?.$link ?? cidToString(root))

  // Parse blocks: each is varint(len) + CID + data
  const blocks = new Map<string, Uint8Array>()

  while (offset < carBytes.length) {
    const [blockLen, afterBlockLen] = readVarint(carBytes, offset)
    offset = afterBlockLen
    if (blockLen === 0) break

    const [cidBytes, afterCid] = parseCidFromBytes(carBytes, offset)
    const cid = cidToString(cidBytes)

    const dataLen = blockLen - (afterCid - offset)
    const data = carBytes.slice(afterCid, afterCid + dataLen)

    blocks.set(cid, data)
    offset = afterCid + dataLen
  }

  return { roots, blocks }
}
