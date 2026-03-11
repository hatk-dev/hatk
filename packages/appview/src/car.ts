// CAR (Content Addressable aRchive) parser from scratch
// CAR files bundle content-addressed blocks — used in firehose events

import { cborDecode } from './cbor.ts'
import { cidToString, readVarint } from './cid.ts'

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
