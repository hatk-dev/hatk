/**
 * `applyCommit` is where both wires converge, and it is the last gate before a
 * stranger's bytes become rows. Every branch here answers one question: does
 * this commit belong to us at all — pinned repo, tracked DID, signal
 * collection, a record whose shape matches the lexicon it claims.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { insertRecord, querySQL, runSQL, setRepoStatus } from '../src/database/db.ts'
import { backfillRepo } from '../src/backfill.ts'
import { emit } from '../src/logger.ts'
import {
  _flushForTests,
  applyCommit,
  awaitBackfill,
  configureIndexer,
  isIndexableCollection,
  type CommitOp,
  type IndexerCoreOpts,
} from '../src/indexer.ts'

vi.mock('../src/backfill.ts', { spy: true })
vi.mock('../src/database/db.ts', { spy: true })
vi.mock('../src/logger.ts', { spy: true })

const TRACKED = 'did:plc:tracked'
const COLLECTIONS = new Set([PUBLIC_COLLECTION])

function create(rkey: string, record: Record<string, any> = { $type: PUBLIC_COLLECTION, text: rkey }): CommitOp {
  return { action: 'create', collection: PUBLIC_COLLECTION, rkey, cid: `cid-${rkey}`, record }
}

async function uris(): Promise<string[]> {
  const rows = (await querySQL(`SELECT uri FROM "${PUBLIC_COLLECTION}" ORDER BY uri`)) as any[]
  return rows.map((r) => r.uri)
}

/** Reconfigure the shared indexer state for one test's question. */
async function configure(overrides: Partial<IndexerCoreOpts> = {}): Promise<void> {
  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: COLLECTIONS,
    signalCollections: new Set<string>(),
    fetchTimeout: 1,
    maxRetries: 0,
    ftsRebuildInterval: 1_000_000,
    ...overrides,
  })
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  // Seeded before the first configureIndexer so the repo status cache warms
  // with it — that is what makes this DID "already tracked".
  await setRepoStatus(TRACKED, 'active')
  await configure()
})

beforeEach(async () => {
  setPrivateCollections([])
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  vi.mocked(emit).mockClear()
  vi.mocked(insertRecord).mockClear()
  vi.mocked(backfillRepo).mockReset()
  vi.mocked(backfillRepo).mockResolvedValue(0)
  await configure()
})

afterEach(async () => {
  await _flushForTests()
})

// --- what never reaches the index -----------------------------------------

test('a commit with no ops does nothing', async () => {
  applyCommit(TRACKED, [])
  await _flushForTests()
  expect(insertRecord).not.toHaveBeenCalled()
})

test('ops from a DID outside the pinned repo set never reach the index', async () => {
  // Pinning is how a dev or single-tenant instance indexes one account off a
  // firehose carrying the whole network.
  await configure({ pinnedRepos: new Set(['did:plc:somebodyelse']) })
  applyCommit(TRACKED, [create('pinned-out')])
  await _flushForTests()
  expect(await uris()).toEqual([])
})

test('the same op lands once the pinned set includes its DID', async () => {
  await configure({ pinnedRepos: new Set([TRACKED]) })
  applyCommit(TRACKED, [create('pinned-in')])
  await _flushForTests()
  expect(await uris()).toEqual([`at://${TRACKED}/${PUBLIC_COLLECTION}/pinned-in`])
})

test('a non-signal op from a DID we have never seen is ignored', async () => {
  // Otherwise a profile edit from any of the network's millions of accounts
  // would seed a row for an account this AppView has no reason to track.
  applyCommit('did:plc:astranger', [create('stranger')])
  await _flushForTests()
  expect(await uris()).toEqual([])
  expect(backfillRepo).not.toHaveBeenCalled()
})

test('a record whose $type disagrees with the collection it arrived under is dropped', async () => {
  // The collection comes from the op path and the $type from the record; a
  // mismatch means one of them is lying, and the row would be unqueryable.
  applyCommit(TRACKED, [create('liar', { $type: 'app.bsky.feed.post', text: 'wrong type' })])
  await _flushForTests()
  expect(await uris()).toEqual([])
})

test('a put with no cid and a put with no record are both dropped', async () => {
  applyCommit(TRACKED, [
    { action: 'create', collection: PUBLIC_COLLECTION, rkey: 'nocid', record: { $type: PUBLIC_COLLECTION, text: 'x' } },
    { action: 'update', collection: PUBLIC_COLLECTION, rkey: 'norecord', cid: 'cid-norecord' },
  ])
  await _flushForTests()
  expect(await uris()).toEqual([])
})

test('a record failing lexicon validation is reported with the field that failed', async () => {
  // `text` is required by the fixture lexicon. The event has to name the path,
  // or a lexicon mismatch in production is invisible.
  applyCommit(TRACKED, [create('invalid', { $type: PUBLIC_COLLECTION })])
  await _flushForTests()

  expect(await uris()).toEqual([])
  const skip = vi.mocked(emit).mock.calls.find(([mod, op]) => mod === 'indexer' && op === 'validation_skip')
  expect(skip).toBeDefined()
  const fields = skip![2] as Record<string, any>
  expect(fields.uri).toBe(`at://${TRACKED}/${PUBLIC_COLLECTION}/invalid`)
  expect(fields.collection).toBe(PUBLIC_COLLECTION)
  expect(fields.error).toBeTruthy()
})

test('one invalid record in a commit does not block the valid ones beside it', async () => {
  applyCommit(TRACKED, [create('good1'), create('bad', { $type: PUBLIC_COLLECTION }), create('good2')])
  await _flushForTests()
  expect((await uris()).map((u) => u.split('/').pop())).toEqual(['good1', 'good2'])
})

// --- auto-backfill signalling ---------------------------------------------

test('activity in a signal collection backfills an unseen repo', async () => {
  const did = 'did:plc:signalfresh'
  await configure({ signalCollections: COLLECTIONS })

  applyCommit(did, [create('sig1')])
  await awaitBackfill(did)
  await _flushForTests()

  expect(backfillRepo).toHaveBeenCalledWith(did, COLLECTIONS, 1)
})

test('events arriving during a backfill are replayed rather than dropped', async () => {
  // The repo export is a snapshot; anything the firehose delivers while it is
  // downloading would otherwise fall in the gap between snapshot and live tail.
  const did = 'did:plc:signalreplay'
  await configure({ signalCollections: COLLECTIONS })

  applyCommit(did, [create('replayed')])
  await awaitBackfill(did)
  await _flushForTests()

  expect(await uris()).toEqual([`at://${did}/${PUBLIC_COLLECTION}/replayed`])
  const event = vi
    .mocked(emit)
    .mock.calls.find(([mod, op]) => mod === 'indexer' && op === 'auto_backfill')![2] as Record<string, any>
  expect(event.did).toBe(did)
  expect(event.buffered_events).toBe(1)
  expect(event.replay_errors).toBe(0)
  expect(event.status).toBe('success')
})

test('with no signal collections configured, every indexed collection signals', async () => {
  // The default exists so a single-collection app does not have to name the
  // same collection twice to get auto-backfill at all.
  const did = 'did:plc:defaultsignal'
  await configure({ signalCollections: undefined })

  applyCommit(did, [create('defaulted')])
  await awaitBackfill(did)
  await _flushForTests()

  expect(backfillRepo).toHaveBeenCalledWith(did, COLLECTIONS, 1)
})

test('an unseen repo is only marked pending when every backfill slot is busy', async () => {
  // Backfills are capped so a burst of new DIDs cannot fan out into hundreds of
  // concurrent repo exports; the DID still has to be remembered for later.
  const did = 'did:plc:nocapacity'
  await configure({ signalCollections: COLLECTIONS, parallelism: 0 })

  applyCommit(did, [create('capped')])
  await _flushForTests()

  expect(backfillRepo).not.toHaveBeenCalled()
  const rows = (await querySQL(`SELECT status FROM _repos WHERE did = $1`, [did])) as any[]
  expect(rows[0].status).toBe('pending')
})

test('a DID already known to the index is not backfilled again by a signal op', async () => {
  await configure({ signalCollections: COLLECTIONS })
  applyCommit(TRACKED, [create('known')])
  await _flushForTests()

  expect(backfillRepo).not.toHaveBeenCalled()
  expect(await uris()).toEqual([`at://${TRACKED}/${PUBLIC_COLLECTION}/known`])
})

// --- collection gating -----------------------------------------------------

test('isIndexableCollection accepts a configured collection and rejects everything else', () => {
  expect(isIndexableCollection(PUBLIC_COLLECTION, COLLECTIONS)).toBe(true)
  expect(isIndexableCollection('app.bsky.feed.like', COLLECTIONS)).toBe(false)
})

test('isIndexableCollection rejects a private collection even when it is configured', () => {
  setPrivateCollections([PUBLIC_COLLECTION])
  expect(isIndexableCollection(PUBLIC_COLLECTION, COLLECTIONS)).toBe(false)
})

// --- deletes against puts, same URI ----------------------------------------
//
// Puts are buffered and drained on a flush; deletes used to be applied the
// moment the op was read. Two write paths with no shared queue means the
// firehose's ordering is not the database's: a delete would overtake every put
// queued ahead of it and lose to every put queued behind it. Both directions
// are asserted here because each one loses a different record.

const del = (rkey: string): CommitOp => ({ action: 'delete', collection: PUBLIC_COLLECTION, rkey })

async function texts(): Promise<string[]> {
  const rows = (await querySQL(`SELECT text FROM "${PUBLIC_COLLECTION}" ORDER BY uri`)) as any[]
  return rows.map((r) => r.text)
}

test('a delete and a later create of the same URI leave the create standing', async () => {
  // The record is deleted and immediately rewritten — an edit that round-trips
  // through a delete, which is how several lexicons express an update. The
  // unqueued delete reached the database after the create it preceded, so the
  // row vanished instead of holding the new value.
  applyCommit(TRACKED, [create('churn', { $type: PUBLIC_COLLECTION, text: 'v1' })])
  await _flushForTests()
  expect(await texts()).toEqual(['v1'])

  applyCommit(TRACKED, [del('churn')])
  applyCommit(TRACKED, [create('churn', { $type: PUBLIC_COLLECTION, text: 'v2' })])
  await _flushForTests()

  expect(await texts()).toEqual(['v2'])
})

test('a create and a later delete of the same URI leave nothing behind', async () => {
  // The mirror image: the delete used to run while the create was still
  // buffered, so the flush behind it put the record back.
  applyCommit(TRACKED, [create('doomed')])
  applyCommit(TRACKED, [del('doomed')])
  await _flushForTests()

  expect(await uris()).toEqual([])
})

test('the flush waits for deletes, so the row is gone the moment it resolves', async () => {
  // Deletes bypassed the buffer, so a flush had nothing of theirs to await and
  // callers raced the write.
  applyCommit(TRACKED, [create('gone')])
  await _flushForTests()
  expect(await uris()).toEqual([`at://${TRACKED}/${PUBLIC_COLLECTION}/gone`])

  applyCommit(TRACKED, [del('gone')])
  await _flushForTests()
  expect(await uris()).toEqual([])
})

test('a delete is reported in the flush event alongside the inserts', async () => {
  applyCommit(TRACKED, [create('counted'), del('counted')])
  await _flushForTests()

  const event = vi.mocked(emit).mock.calls.findLast(([mod, op]) => mod === 'indexer' && op === 'flush')![2] as Record<
    string,
    any
  >
  expect(event.batch_size).toBe(2)
  expect(event.inserted_count).toBe(1)
  expect(event.deleted_count).toBe(1)
})
