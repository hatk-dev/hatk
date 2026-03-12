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
 * Parses a CARv1 stream incrementally from a `ReadableStream`.
 *
 * Instead of buffering the entire CAR into a single ArrayBuffer, this reads
 * chunks from the stream and parses blocks as they arrive. Each block's data
 * is `.slice()`d into its own small `Uint8Array`, allowing V8 to GC individual
 * blocks as they're consumed during the MST walk.
 *
 * This is critical for backfill where multiple workers download 30-90MB CARs
 * concurrently — buffered downloads cause OOMs because `ArrayBuffer` memory
 * is "external" to V8's heap and not controlled by `--max-old-space-size`.
 *
 * @param body - The response body stream (e.g. `res.body` from `fetch()`)
 * @returns `roots` — root CID strings; `blocks` — map of CID → block data; `byteLength` — total bytes read
 */
export async function parseCarStream(body: ReadableStream<Uint8Array>): Promise<{
  roots: string[]
  blocks: Map<string, Uint8Array>
  byteLength: number
}> {
  const reader = body.getReader()

  // Growable buffer with position tracking. We reuse a single allocation and
  // compact (shift data to front) when the read position passes the midpoint,
  // avoiding per-chunk allocations and subarray references that pin old memory.
  let buf = new Uint8Array(64 * 1024)
  let pos = 0 // read cursor
  let len = 0 // bytes of valid data in buf
  let byteLength = 0

  // Ensure at least `need` bytes are available at buf[pos..pos+need)
  async function fill(need: number): Promise<boolean> {
    while (len - pos < need) {
      const { done, value } = await reader.read()
      if (done) return (len - pos) >= need
      byteLength += value.length

      // Compact: shift remaining data to front when read cursor passes midpoint
      if (pos > 0 && pos > buf.length >>> 1) {
        buf.copyWithin(0, pos, len)
        len -= pos
        pos = 0
      }

      // Grow if needed
      const required = len + value.length
      if (required > buf.length) {
        const newBuf = new Uint8Array(Math.max(required, buf.length * 2))
        newBuf.set(buf.subarray(0, len))
        buf = newBuf
      }

      buf.set(value, len)
      len += value.length
    }
    return true
  }

  function consume(n: number): void {
    pos += n
  }

  // Read a varint starting at buf[pos]
  function readVarintFromBuf(): [number, number] {
    let value = 0
    let shift = 0
    let p = pos
    while (p < len) {
      const byte = buf[p++]
      value |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return [value, p - pos]
      shift += 7
      if (shift > 35) throw new Error('Varint too long')
    }
    throw new Error('Unexpected end of varint')
  }

  // Parse header: varint(headerLen) + CBOR(header)
  if (!(await fill(1))) throw new Error('Empty CAR stream')

  // Prefetch up to 10 bytes for the varint; readVarintFromBuf bounds to `len`
  await fill(10)
  const [headerLen, headerVarintSize] = readVarintFromBuf()
  consume(headerVarintSize)

  if (!(await fill(headerLen))) throw new Error('Truncated CAR header')
  // .slice() copies out of the reusable buffer
  const headerSlice = buf.slice(pos, pos + headerLen)
  const { value: header } = cborDecode(headerSlice)
  consume(headerLen)

  const roots = (header.roots || []).map((root: any) => root?.$link ?? cidToString(root))

  // Parse blocks
  const blocks = new Map<string, Uint8Array>()

  while (true) {
    if (!(await fill(1))) break

    // Prefetch up to 10 bytes for the varint; readVarintFromBuf bounds to `len`
    await fill(10)
    const [blockLen, blockVarintSize] = readVarintFromBuf()
    consume(blockVarintSize)
    if (blockLen === 0) break

    if (!(await fill(blockLen))) throw new Error('Truncated CAR block')

    const [cidBytes, afterCid] = parseCidFromBytes(buf, pos)
    const cid = cidToString(cidBytes)
    const cidLen = afterCid - pos
    // .slice() creates an independent copy — the buffer can be reused
    const data = buf.slice(afterCid, afterCid + blockLen - cidLen)

    blocks.set(cid, data)
    consume(blockLen)
  }

  reader.releaseLock()
  // Release the internal buffer
  buf = null!
  return { roots, blocks, byteLength }
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
