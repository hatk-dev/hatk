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
 * A memory-efficient block map that stores byte offsets into the original CAR
 * buffer instead of copying block data. Implements the same `get`/`delete`/`size`
 * interface as `Map<string, Uint8Array>` so it can be used as a drop-in replacement.
 */
export class LazyBlockMap {
  private offsets: Map<string, [number, number]>
  private carBytes: Uint8Array | null

  constructor(carBytes: Uint8Array, offsets: Map<string, [number, number]>) {
    this.carBytes = carBytes
    this.offsets = offsets
  }

  get(cid: string): Uint8Array | undefined {
    const range = this.offsets.get(cid)
    if (!range || !this.carBytes) return undefined
    return this.carBytes.subarray(range[0], range[1])
  }

  delete(cid: string): boolean {
    return this.offsets.delete(cid)
  }

  get size(): number {
    return this.offsets.size
  }

  *[Symbol.iterator](): IterableIterator<[string, Uint8Array]> {
    for (const [cid, range] of this.offsets) {
      if (!this.carBytes) return
      yield [cid, this.carBytes.subarray(range[0], range[1])]
    }
  }

  /** Release the underlying CAR buffer */
  free(): void {
    this.carBytes = null
    this.offsets.clear()
  }
}

/**
 * Parses a CARv1 binary frame into its root CIDs and a lazy block map.
 *
 * The block map stores byte offsets into `carBytes` rather than copying data,
 * reducing heap usage from O(total block bytes) to O(number of blocks * 16 bytes).
 *
 * @param carBytes - Raw CAR file bytes (e.g. from `getRepo` or a firehose commit)
 * @returns `roots` — ordered list of root CID strings; `blocks` — lazy block map
 */
export function parseCarFrame(carBytes: Uint8Array): {
  roots: string[]
  blocks: LazyBlockMap
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

  // Build offset index: CID → [start, end] into carBytes
  const offsets = new Map<string, [number, number]>()

  while (offset < carBytes.length) {
    const [blockLen, afterBlockLen] = readVarint(carBytes, offset)
    offset = afterBlockLen
    if (blockLen === 0) break

    const [cidBytes, afterCid] = parseCidFromBytes(carBytes, offset)
    const cid = cidToString(cidBytes)

    const dataLen = blockLen - (afterCid - offset)
    offsets.set(cid, [afterCid, afterCid + dataLen])
    offset = afterCid + dataLen
  }

  return { roots, blocks: new LazyBlockMap(carBytes, offsets) }
}
