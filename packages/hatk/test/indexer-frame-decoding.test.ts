/**
 * Everything the relay puts on the socket reaches `processMessage` first, and
 * the relay is not the only thing that can put bytes there. A frame that is
 * truncated, mislabelled, or missing the block its own op points at must cost
 * that frame and nothing else — the stream keeps running either way.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { querySQL, runSQL, setRepoStatus } from '../src/database/db.ts'
import {
  _flushForTests,
  _resetCursorStateForTests,
  configureIndexer,
  getLastSeq,
  processMessage,
} from '../src/indexer.ts'
import { CidLink, buildCar, buildCommitFrame, buildIdentityFrame, cborEncode, cidFor } from './firehose-frame.ts'

const DID = 'did:plc:framedecoder'
const COLLECTIONS = new Set([PUBLIC_COLLECTION])

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** A frame with hand-built header and body, for shapes the relay would never send. */
function frame(header: Record<string, any>, body: Record<string, any>): Uint8Array {
  return concat([cborEncode(header), cborEncode(body)])
}

/**
 * A `#commit` whose ops and CAR blocks are set independently, so an op can
 * point at a block that is missing, corrupt, or has no CID at all.
 */
function commitFrame(
  ops: Array<Record<string, any>>,
  blocks: Array<{ cid: CidLink; bytes: Uint8Array }>,
  seq = 1,
): Uint8Array {
  const rootBytes = cborEncode({ did: DID, rev: 'revfixture', version: 3 })
  const root = cidFor(rootBytes)
  return frame(
    { op: 1, t: '#commit' },
    { seq, repo: DID, ops, blocks: buildCar(root, [...blocks, { cid: root, bytes: rootBytes }]) },
  )
}

/** A valid record block plus the op that references it. */
function goodOp(rkey: string) {
  const bytes = cborEncode({ $type: PUBLIC_COLLECTION, text: rkey })
  const cid = cidFor(bytes)
  return {
    op: { action: 'create', path: `${PUBLIC_COLLECTION}/${rkey}`, cid },
    block: { cid, bytes },
  }
}

async function rkeys(): Promise<string[]> {
  const rows = (await querySQL(`SELECT uri FROM "${PUBLIC_COLLECTION}" ORDER BY uri`)) as any[]
  return rows.map((r) => r.uri.split('/').pop())
}

/** better-sqlite3 resolves in microtasks, so draining them settles fire-and-forget work. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  await setRepoStatus(DID, 'active', undefined, { handle: 'old.example' })
  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: COLLECTIONS,
    signalCollections: new Set<string>(),
    fetchTimeout: 1,
    maxRetries: 0,
    ftsRebuildInterval: 1_000_000,
  })
})

beforeEach(async () => {
  setPrivateCollections([])
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  _resetCursorStateForTests()
})

afterEach(async () => {
  await _flushForTests()
})

// --- frames that are not commits ------------------------------------------

test('an #identity frame is routed to the handle updater, not the commit path', async () => {
  processMessage(buildIdentityFrame(DID, 'renamed.example'), COLLECTIONS)
  await settle()

  const rows = (await querySQL(`SELECT handle FROM _repos WHERE did = $1`, [DID])) as any[]
  expect(rows[0].handle).toBe('renamed.example')
  // An identity frame carries no commit, so nothing may reach the cursor either.
  expect(getLastSeq()).toBeNull()
})

test('an #identity frame with no did is dropped rather than resolved', async () => {
  expect(() => processMessage(frame({ op: 1, t: '#identity' }, { seq: 1 }), COLLECTIONS)).not.toThrow()
})

test('an event kind hatk does not consume is ignored', async () => {
  // #account, #sync and friends share the frame shape; only #commit is indexed.
  processMessage(frame({ op: 1, t: '#account' }, { seq: 5, did: DID, active: false }), COLLECTIONS)
  await _flushForTests()
  expect(await rkeys()).toEqual([])
  expect(getLastSeq()).toBeNull()
})

test('an error frame (op 0) is ignored', async () => {
  // The relay signals a refused cursor with op -1/0 and an error body, not a commit.
  processMessage(frame({ op: 0, t: '#commit' }, { seq: 5, repo: DID, ops: [], blocks: new Uint8Array() }), COLLECTIONS)
  await _flushForTests()
  expect(getLastSeq()).toBeNull()
})

// --- commits that are missing something -----------------------------------

test('a commit with no blocks and a commit with no ops are both dropped', async () => {
  processMessage(frame({ op: 1, t: '#commit' }, { seq: 6, repo: DID, ops: [] }), COLLECTIONS)
  processMessage(frame({ op: 1, t: '#commit' }, { seq: 7, repo: DID, blocks: new Uint8Array([1, 2]) }), COLLECTIONS)
  await _flushForTests()
  // Neither reached the seq tracker, so a cursor cannot advance past a frame
  // that was never understood.
  expect(getLastSeq()).toBeNull()
})

test('a commit with no repo is dropped', async () => {
  const { op, block } = goodOp('norepo')
  const rootBytes = cborEncode({ rev: 'revfixture', version: 3 })
  const root = cidFor(rootBytes)
  processMessage(
    frame(
      { op: 1, t: '#commit' },
      { seq: 8, ops: [op], blocks: buildCar(root, [block, { cid: root, bytes: rootBytes }]) },
    ),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(await rkeys()).toEqual([])
})

test('a commit for collections we do not index still advances the seq', async () => {
  // The cursor has to move past traffic we filter out, or a reconnect rewinds
  // to before it and re-reads the whole span at line rate.
  processMessage(
    buildCommitFrame(DID, 31337, [
      { action: 'create', collection: 'app.bsky.feed.like', rkey: 'x', record: { $type: 'app.bsky.feed.like' } },
    ]),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(getLastSeq()).toBe(31337)
  expect(await rkeys()).toEqual([])
})

// --- ops that point at nothing --------------------------------------------

test('an op with no cid is skipped while the rest of the commit indexes', async () => {
  const { op, block } = goodOp('survivor')
  processMessage(
    commitFrame([{ action: 'create', path: `${PUBLIC_COLLECTION}/nocid`, cid: null }, op], [block]),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(await rkeys()).toEqual(['survivor'])
})

test('an op whose block is absent from the CAR is skipped', async () => {
  // A commit only carries the blocks the relay chose to include; an op naming
  // one that is not there must not become a row with no record.
  const orphan = cidFor(cborEncode({ $type: PUBLIC_COLLECTION, text: 'never shipped' }))
  const { op, block } = goodOp('present')
  processMessage(
    commitFrame([{ action: 'create', path: `${PUBLIC_COLLECTION}/orphan`, cid: orphan }, op], [block]),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(await rkeys()).toEqual(['present'])
})

test('a block that does not decode is skipped while the rest of the commit indexes', async () => {
  const corruptBytes = new Uint8Array([0xbf, 0xff, 0xff])
  const corruptCid = cidFor(corruptBytes)
  const { op, block } = goodOp('intact')
  processMessage(
    commitFrame(
      [{ action: 'create', path: `${PUBLIC_COLLECTION}/corrupt`, cid: corruptCid }, op],
      [{ cid: corruptCid, bytes: corruptBytes }, block],
    ),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(await rkeys()).toEqual(['intact'])
})

test('an op whose cid arrived as a plain string still finds its block', async () => {
  // The relay sends CID links as CBOR tag 42, but the same op shape reaches
  // here from sources that send the CID as a string.
  const bytes = cborEncode({ $type: PUBLIC_COLLECTION, text: 'string cid' })
  const cid = cidFor(bytes)
  processMessage(
    commitFrame([{ action: 'create', path: `${PUBLIC_COLLECTION}/strcid`, cid: cid.toString() }], [{ cid, bytes }]),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(await rkeys()).toEqual(['strcid'])
})

test('a commit with no seq indexes its records without advancing the cursor', async () => {
  // A cursor is only worth as much as the seq it came from; writing one from a
  // frame that carried no seq would resume the stream from a made-up offset.
  const { op, block } = goodOp('noseq')
  const rootBytes = cborEncode({ did: DID, rev: 'revfixture', version: 3 })
  const root = cidFor(rootBytes)
  processMessage(
    frame(
      { op: 1, t: '#commit' },
      { repo: DID, ops: [op], blocks: buildCar(root, [block, { cid: root, bytes: rootBytes }]) },
    ),
    COLLECTIONS,
  )
  await _flushForTests()

  expect(await rkeys()).toEqual(['noseq'])
  expect(getLastSeq()).toBeNull()
})

test('a delete needs no block and is applied from the op path alone', async () => {
  const { op, block } = goodOp('doomed')
  processMessage(commitFrame([op], [block]), COLLECTIONS)
  await _flushForTests()
  expect(await rkeys()).toEqual(['doomed'])

  processMessage(
    commitFrame([{ action: 'delete', path: `${PUBLIC_COLLECTION}/doomed`, cid: null }], [], 2),
    COLLECTIONS,
  )
  // No extra settling: the delete rides the write buffer, so the flush covers it.
  await _flushForTests()
  expect(await rkeys()).toEqual([])
})

test('an unparseable frame throws to the socket handler rather than indexing garbage', () => {
  // startIndexer wraps this call and reports a decode_error; what matters here
  // is that nothing is written from bytes that never decoded.
  expect(() => processMessage(new Uint8Array([0xff, 0xff, 0xff, 0xff]), COLLECTIONS)).toThrow()
})
