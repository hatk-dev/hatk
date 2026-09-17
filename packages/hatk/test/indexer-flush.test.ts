/**
 * The write buffer is the indexer's only backpressure valve: records land in
 * it, and a batch either drains on the interval or the moment it fills. What
 * matters here is that a failure inside a batch — a bad insert, a cursor write
 * the DB refused — costs exactly that one thing and never the whole batch.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import {
  getCursor,
  getDatabasePort,
  insertRecord,
  querySQL,
  runSQL,
  setCursor,
  setRepoStatus,
} from '../src/database/db.ts'
import { rebuildAllIndexes } from '../src/database/fts.ts'
import { emit } from '../src/logger.ts'
import {
  _flushForTests,
  _resetCursorStateForTests,
  applyCommit,
  checkpointCursor,
  configureIndexer,
  noteSeq,
  type CommitOp,
} from '../src/indexer.ts'

vi.mock('../src/database/db.ts', { spy: true })
vi.mock('../src/database/fts.ts', { spy: true })
vi.mock('../src/logger.ts', { spy: true })

const DID = 'did:plc:flusher'
const COLLECTIONS = new Set([PUBLIC_COLLECTION])

/** N valid create ops, each one row once the batch drains. */
function creates(n: number, prefix: string): CommitOp[] {
  return Array.from({ length: n }, (_, i) => ({
    action: 'create' as const,
    collection: PUBLIC_COLLECTION,
    rkey: `${prefix}${i}`,
    cid: `cid-${prefix}${i}`,
    record: { $type: PUBLIC_COLLECTION, text: `row ${prefix}${i}` },
  }))
}

async function rowCount(): Promise<number> {
  const rows = (await querySQL(`SELECT uri FROM "${PUBLIC_COLLECTION}"`)) as any[]
  return rows.length
}

/** The fields of the last `indexer/flush` wide event. */
function lastFlushEvent(): Record<string, any> {
  const calls = vi.mocked(emit).mock.calls.filter(([mod, op]) => mod === 'indexer' && op === 'flush')
  return calls.at(-1)![2] as Record<string, any>
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  // A known status keeps these DIDs off the auto-backfill path, so the only
  // thing under test is the buffer.
  await setRepoStatus(DID, 'active')
  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: COLLECTIONS,
    signalCollections: new Set<string>(),
    fetchTimeout: 1,
    maxRetries: 0,
    // High enough that no test here trips the FTS rebuild by accident.
    ftsRebuildInterval: 1_000_000,
  })
})

beforeEach(async () => {
  setPrivateCollections([])
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  await runSQL(`DELETE FROM _cursor`)
  _resetCursorStateForTests()
  vi.mocked(emit).mockClear()
})

afterEach(async () => {
  // Drain anything a test left buffered so it cannot land in the next one.
  await _flushForTests()
})

test('a record whose insert fails costs only that record, not the batch', async () => {
  // One poisoned row (a schema mismatch, a constraint, a transient DB error)
  // used to be enough to lose everything queued behind it.
  vi.mocked(insertRecord).mockRejectedValueOnce(new Error('disk is on fire'))

  applyCommit(DID, creates(3, 'a'))
  await _flushForTests()

  const rows = (await querySQL(`SELECT uri FROM "${PUBLIC_COLLECTION}" ORDER BY uri`)) as any[]
  expect(rows.map((r) => r.uri.split('/').pop())).toEqual(['a1', 'a2'])

  const event = lastFlushEvent()
  expect(event.batch_size).toBe(3)
  expect(event.inserted_count).toBe(2)
  expect(event.error_count).toBe(1)
  expect(event.sample_errors).toEqual(['disk is on fire'])
})

test('a flush with no failures reports no error sample at all', async () => {
  applyCommit(DID, creates(2, 'ok'))
  await _flushForTests()

  const event = lastFlushEvent()
  expect(event.error_count).toBe(0)
  expect(event.sample_errors).toBeUndefined()
  expect(event.cursor_error).toBeUndefined()
})

test('a flush event names the collections and DIDs the batch touched', async () => {
  applyCommit(DID, creates(2, 'agg'))
  await _flushForTests()

  const event = lastFlushEvent()
  expect(event.collections).toEqual({ [PUBLIC_COLLECTION]: 2 })
  expect(event.unique_dids).toBe(1)
  expect(event.sample_dids).toEqual([DID])
})

test('a cursor write that fails keeps the batch and leaves the seq for the next checkpoint', async () => {
  // Losing the cursor write must not cost the rows: the records are already
  // upserted by URI, so a replay from the older cursor is harmless, while
  // dropping the batch would not be.
  noteSeq(4242)
  vi.mocked(setCursor).mockRejectedValueOnce(new Error('db busy'))

  applyCommit(DID, creates(1, 'c'))
  await _flushForTests()

  expect(await rowCount()).toBe(1)
  expect(lastFlushEvent().cursor_error).toBe('db busy')
  expect(await getCursor('relay')).toBeNull()

  // The seq was never marked persisted, so the timer-driven checkpoint retries it.
  await checkpointCursor()
  expect(await getCursor('relay')).toBe('4242')
})

test('a successful flush persists the latest seq as the relay cursor', async () => {
  noteSeq(77)
  applyCommit(DID, creates(1, 'seq'))
  await _flushForTests()

  expect(await getCursor('relay')).toBe('77')
  expect(lastFlushEvent().cursor_seq).toBe(77)
})

test('flushing an empty buffer does nothing and emits nothing', async () => {
  await _flushForTests()
  expect(vi.mocked(emit).mock.calls.filter(([, op]) => op === 'flush')).toHaveLength(0)
})

test('a full batch drains immediately instead of waiting out the flush interval', async () => {
  // BATCH_SIZE is 100 and the interval is 500ms. Feeding 99 must leave them
  // buffered; the 100th must drain the batch well inside the interval, which is
  // the whole point of the size trigger under firehose load.
  applyCommit(DID, creates(99, 'b'))
  expect(await rowCount()).toBe(0)

  applyCommit(DID, creates(1, 'last'))
  await vi.waitFor(async () => expect(await rowCount()).toBe(100), { timeout: 250, interval: 5 })
})

test('a batch that never fills still drains on the flush interval', async () => {
  applyCommit(DID, creates(1, 'slow'))
  expect(await rowCount()).toBe(0)
  // No further writes arrive; only the scheduled timer can land this row.
  await vi.waitFor(async () => expect(await rowCount()).toBe(1), { timeout: 2000, interval: 25 })
})

// --- periodic FTS rebuilds -------------------------------------------------

test('a non-SQLite backend rebuilds its search indexes once the write threshold is passed', async () => {
  const realPort = getDatabasePort()
  vi.mocked(getDatabasePort).mockReturnValue({ ...realPort, dialect: 'postgres' })
  vi.mocked(rebuildAllIndexes).mockResolvedValue(undefined)
  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: COLLECTIONS,
    signalCollections: new Set<string>(),
    fetchTimeout: 1,
    maxRetries: 0,
    ftsRebuildInterval: 1,
  })

  try {
    applyCommit(DID, creates(1, 'fts'))
    await _flushForTests()
    expect(rebuildAllIndexes).toHaveBeenCalledWith([PUBLIC_COLLECTION])
  } finally {
    vi.mocked(getDatabasePort).mockReturnValue(realPort)
    vi.mocked(rebuildAllIndexes).mockReset()
  }
})

test('SQLite skips the periodic rebuild because its FTS index updates incrementally', async () => {
  vi.mocked(rebuildAllIndexes).mockResolvedValue(undefined)
  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: COLLECTIONS,
    signalCollections: new Set<string>(),
    fetchTimeout: 1,
    maxRetries: 0,
    ftsRebuildInterval: 1,
  })

  try {
    applyCommit(DID, creates(1, 'nofts'))
    await _flushForTests()
    expect(rebuildAllIndexes).not.toHaveBeenCalled()
  } finally {
    vi.mocked(rebuildAllIndexes).mockReset()
  }
})
