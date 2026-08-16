/**
 * Builds real `com.atproto.sync.subscribeRepos` frames for tests.
 *
 * hatk only ships decoders (cbor.ts, car.ts), so exercising the relay path
 * end-to-end needs an encoder. This is the minimum DAG-CBOR + CAR writer that
 * produces bytes `parseCarFrame` and `cborDecode` accept — enough to prove the
 * relay wire and the Jetstream wire converge on identical rows, not a general
 * purpose CBOR library.
 */
import { createHash } from 'node:crypto'
import { base32Encode } from '../src/cid.ts'

/** DAG-CBOR CID: 0x01 version, 0x71 dag-cbor codec, 0x12 sha2-256, 0x20 length. */
const CID_PREFIX = new Uint8Array([0x01, 0x71, 0x12, 0x20])

const enc = new TextEncoder()

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** CBOR major-type header: type in the top 3 bits, length inline or in 1/2/4 following bytes. */
function header(major: number, length: number): Uint8Array {
  if (length < 24) return new Uint8Array([(major << 5) | length])
  if (length < 0x100) return new Uint8Array([(major << 5) | 24, length])
  if (length < 0x10000) return new Uint8Array([(major << 5) | 25, length >> 8, length & 0xff])
  return new Uint8Array([
    (major << 5) | 26,
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  ])
}

/** A CID link, encoded as CBOR tag 42 with the 0x00 multibase prefix DAG-CBOR requires. */
export class CidLink {
  constructor(public bytes: Uint8Array) {}
  toString(): string {
    return 'b' + base32Encode(this.bytes).toLowerCase().replace(/=+$/, '')
  }
}

export function cborEncode(value: any): Uint8Array {
  if (value instanceof CidLink) {
    const payload = concat([new Uint8Array([0x00]), value.bytes])
    return concat([header(6, 42), header(2, payload.length), payload])
  }
  if (value instanceof Uint8Array) {
    return concat([header(2, value.length), value])
  }
  if (typeof value === 'string') {
    const b = enc.encode(value)
    return concat([header(3, b.length), b])
  }
  if (typeof value === 'number') {
    if (value < 0) throw new Error('negative numbers not needed by these fixtures')
    return header(0, value)
  }
  if (typeof value === 'boolean') return new Uint8Array([value ? 0xf5 : 0xf4])
  if (value === null) return new Uint8Array([0xf6])
  if (Array.isArray(value)) {
    return concat([header(4, value.length), ...value.map(cborEncode)])
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return concat([header(5, keys.length), ...keys.flatMap((k) => [cborEncode(k), cborEncode(value[k])])])
  }
  throw new Error(`cborEncode: unsupported ${typeof value}`)
}

/** The CID of a DAG-CBOR block, as the network computes it: sha256 over the encoded bytes. */
export function cidFor(block: Uint8Array): CidLink {
  const digest = new Uint8Array(createHash('sha256').update(block).digest())
  return new CidLink(concat([CID_PREFIX, digest]))
}

function varint(n: number): Uint8Array {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return new Uint8Array(out)
}

/** A CAR v1 with one root and the given blocks, matching what `blocks` carries on a #commit. */
export function buildCar(root: CidLink, blocks: Array<{ cid: CidLink; bytes: Uint8Array }>): Uint8Array {
  const headerBytes = cborEncode({ version: 1, roots: [root] })
  const parts: Uint8Array[] = [varint(headerBytes.length), headerBytes]
  for (const { cid, bytes } of blocks) {
    const body = concat([cid.bytes, bytes])
    parts.push(varint(body.length), body)
  }
  return concat(parts)
}

export interface FrameOp {
  action: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: Record<string, any>
}

/**
 * A complete `#commit` frame: CBOR header immediately followed by the CBOR
 * body, exactly as the relay puts it on the wire.
 */
export function buildCommitFrame(did: string, seq: number, ops: FrameOp[]): Uint8Array {
  const blocks: Array<{ cid: CidLink; bytes: Uint8Array }> = []
  const wireOps = ops.map((op) => {
    if (op.action === 'delete') {
      return { action: 'delete', path: `${op.collection}/${op.rkey}`, cid: null }
    }
    const bytes = cborEncode(op.record)
    const cid = cidFor(bytes)
    blocks.push({ cid, bytes })
    return { action: op.action, path: `${op.collection}/${op.rkey}`, cid }
  })

  // The root block stands in for the signed commit; the indexer only reads
  // `ops` and `blocks`, so its contents just need to be a valid block.
  const rootBytes = cborEncode({ did, rev: 'revfixture', version: 3 })
  const root = cidFor(rootBytes)
  blocks.push({ cid: root, bytes: rootBytes })

  return concat([
    cborEncode({ op: 1, t: '#commit' }),
    cborEncode({ seq, repo: did, ops: wireOps, blocks: buildCar(root, blocks) }),
  ])
}

/** An `#identity` frame. `handle` is optional per the lexicon. */
export function buildIdentityFrame(did: string, handle?: string): Uint8Array {
  const body: Record<string, any> = { seq: 1, did }
  if (handle !== undefined) body.handle = handle
  return concat([cborEncode({ op: 1, t: '#identity' }), cborEncode(body)])
}

/** The Jetstream v2 envelope for the same commit, for wire-equivalence tests. */
export function jetstreamCommitFrame(did: string, seq: number, op: FrameOp): string {
  const payload: Record<string, any> = {
    $type: 'network.bsky.jetstream.subscribeEvents#commit',
    did,
    seq,
    time: '2026-08-15T00:00:00.000Z',
    operation: op.action,
    collection: op.collection,
    rkey: op.rkey,
    rev: 'revfixture',
  }
  if (op.action !== 'delete' && op.record) {
    payload.cid = cidFor(cborEncode(op.record)).toString()
    payload.record = op.record
  }
  return JSON.stringify({ $type: 'message', payload })
}
