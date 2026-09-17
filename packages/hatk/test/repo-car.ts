/**
 * A repo as a CAR file, for tests that exercise the backfill path.
 *
 * Shared because two suites need the same bytes: the backfill unit tests and
 * the repo/space integration tests, which must agree on what a repo looks
 * like or the seam between them is tested against a fiction.
 */
import { cidToString } from '../src/cid.ts'
import { CidLink, buildCar, cborEncode, cidFor } from './firehose-frame.ts'

const enc = new TextEncoder()

export interface RepoRecord {
  collection: string
  rkey: string
  record?: Record<string, unknown>
  /** Raw block bytes in place of an encoded record, for corrupt-block cases. */
  raw?: Uint8Array
}

/**
 * A minimal but real repo CAR: a signed-commit stand-in whose `data` points
 * at a one-node MST listing every record. `omitRoot` produces the shape of a
 * diff CAR compacted past the requested rev — blocks but no commit.
 */
export function buildRepoCar(
  did: string,
  rev: string,
  records: RepoRecord[],
  opts: { omitRoot?: boolean } = {},
): Uint8Array {
  const blocks: Array<{ cid: CidLink; bytes: Uint8Array }> = []
  const entries = records.map((r) => {
    const bytes = r.raw ?? cborEncode(r.record)
    const cid = cidFor(bytes)
    blocks.push({ cid, bytes })
    return { p: 0, k: enc.encode(`${r.collection}/${r.rkey}`), v: cid, t: null }
  })
  const mstBytes = cborEncode({ l: null, e: entries })
  const mstCid = cidFor(mstBytes)
  blocks.push({ cid: mstCid, bytes: mstBytes })
  const commitBytes = cborEncode({ did, version: 3, data: mstCid, rev, prev: null })
  const commitCid = cidFor(commitBytes)
  if (!opts.omitRoot) blocks.push({ cid: commitCid, bytes: commitBytes })
  return buildCar(commitCid, blocks)
}

/** The CID string hatk stores for a record, as the CAR parser spells it. */
export const cidOf = (record: Record<string, unknown>) => cidToString(cidFor(cborEncode(record)).bytes)

export const carResponse = (car: Uint8Array) =>
  new Response(car.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: { 'content-type': 'application/vnd.ipld.car' },
  })
