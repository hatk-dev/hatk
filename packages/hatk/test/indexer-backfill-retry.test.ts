/**
 * Auto-backfill is what turns "a DID we just saw on the firehose" into "a repo
 * we have all of". It is also the indexer's only unbounded cost — a repo export
 * per new DID — so the interesting behaviour is all in the edges: the cap, the
 * events that arrive mid-export, and what happens when the export fails.
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
  triggerAutoBackfill,
  type CommitOp,
  type IndexerCoreOpts,
} from '../src/indexer.ts'

vi.mock('../src/backfill.ts', { spy: true })
vi.mock('../src/database/db.ts', { spy: true })
vi.mock('../src/logger.ts', { spy: true })

const COLLECTIONS = new Set([PUBLIC_COLLECTION])

/** A backfill whose completion the test controls, standing in for a slow repo export. */
function deferredBackfill(): { settle: (count: number) => void; fail: (message: string) => void } {
  let settle!: (count: number) => void
  let fail!: (message: string) => void
  const promise = new Promise<number>((resolve, reject) => {
    settle = resolve
    fail = (m) => reject(new Error(m))
  })
  vi.mocked(backfillRepo).mockReturnValue(promise)
  return { settle, fail }
}

function create(rkey: string): CommitOp {
  return {
    action: 'create',
    collection: PUBLIC_COLLECTION,
    rkey,
    cid: `cid-${rkey}`,
    record: { $type: PUBLIC_COLLECTION, text: rkey },
  }
}

/**
 * Let the awaits inside a fire-and-forget backfill settle. better-sqlite3 is
 * synchronous, so every DB promise in that path resolves on the microtask
 * queue — draining it is deterministic, not a sleep.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function backfilledDids(): string[] {
  return vi.mocked(backfillRepo).mock.calls.map(([did]) => did)
}

/** Fields of the most recent `indexer/auto_backfill` wide event for a DID. */
function autoBackfillEvent(did: string): Record<string, any> {
  const calls = vi
    .mocked(emit)
    .mock.calls.filter(
      ([mod, op, fields]) => mod === 'indexer' && op === 'auto_backfill' && (fields as any).did === did,
    )
  return calls.at(-1)![2] as Record<string, any>
}

async function configure(overrides: Partial<IndexerCoreOpts> = {}): Promise<void> {
  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: COLLECTIONS,
    signalCollections: COLLECTIONS,
    fetchTimeout: 1,
    maxRetries: 0,
    ftsRebuildInterval: 1_000_000,
    ...overrides,
  })
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
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
  vi.useRealTimers()
  await _flushForTests()
})

test('a repo already being backfilled is not exported a second time', async () => {
  // Two firehose events for a new DID arrive back to back; one repo export is
  // the whole point of tracking in-flight work.
  const did = 'did:plc:dedupe'
  const gate = deferredBackfill()

  const first = triggerAutoBackfill(did)
  await triggerAutoBackfill(did)
  await settle()
  expect(backfilledDids()).toEqual([did])

  gate.settle(0)
  await first
})

test('awaitBackfill blocks until the in-flight export finishes', async () => {
  // On-login hooks wait on this before reading the repo they just triggered.
  const did = 'did:plc:awaited'
  const gate = deferredBackfill()

  const running = triggerAutoBackfill(did)
  let resolved = false
  const waiter = awaitBackfill(did).then(() => {
    resolved = true
  })
  expect(resolved).toBe(false)

  gate.settle(5)
  await running
  await waiter
  expect(resolved).toBe(true)
})

test('awaitBackfill resolves immediately for a DID with nothing in flight', async () => {
  await expect(awaitBackfill('did:plc:neverseen')).resolves.toBeUndefined()
})

test('a DID that finds every backfill slot busy is retried later, not dropped', async () => {
  vi.useFakeTimers()
  const busy = 'did:plc:holdingtheslot'
  const waiting = 'did:plc:waitingforaslot'
  await configure({ parallelism: 1 })

  const gate = deferredBackfill()
  const running = triggerAutoBackfill(busy)

  // No slot: this must schedule a retry rather than backfill now or give up.
  await triggerAutoBackfill(waiting)
  // A second event for the same DID must not stack a second retry timer.
  await triggerAutoBackfill(waiting)
  await settle()
  expect(backfilledDids()).toEqual([busy])

  vi.mocked(backfillRepo).mockResolvedValue(0)
  gate.settle(0)
  await running

  await vi.advanceTimersByTimeAsync(10_000)
  expect(backfilledDids().filter((d) => d === waiting)).toEqual([waiting])
})

test('events buffered during an export are replayed, and a replay failure is counted not thrown', async () => {
  // The replayed writes are the gap between the repo snapshot and the live
  // tail; one that fails must be reported, not swallow the rest.
  const did = 'did:plc:replayfail'
  const gate = deferredBackfill()
  const running = triggerAutoBackfill(did)

  applyCommit(did, [create('buffered1')])
  applyCommit(did, [create('buffered2')])

  vi.mocked(insertRecord).mockRejectedValueOnce(new Error('constraint failed'))
  gate.settle(3)
  await running

  const event = autoBackfillEvent(did)
  expect(event.record_count).toBe(3)
  expect(event.buffered_events).toBe(2)
  expect(event.replay_errors).toBe(1)
  expect(event.status).toBe('success')

  // The replay that did succeed is a row, not just a count.
  const rows = (await querySQL(`SELECT uri FROM "${PUBLIC_COLLECTION}" WHERE did = $1`, [did])) as any[]
  expect(rows).toHaveLength(1)
})

test('a failed export is reported with its error and leaves the DID resolvable', async () => {
  const did = 'did:plc:exportfailed'
  const gate = deferredBackfill()
  const running = triggerAutoBackfill(did)
  gate.fail('PDS returned 502')
  await running

  const event = autoBackfillEvent(did)
  expect(event.status).toBe('error')
  expect(event.error).toBe('PDS returned 502')
  // A waiter must not hang forever just because the export failed.
  await expect(awaitBackfill(did)).resolves.toBeUndefined()
})

test('a failed export is retried once the backoff elapses, when retries remain', async () => {
  vi.useFakeTimers()
  const did = 'did:plc:retried'
  await configure({ maxRetries: 3 })

  vi.mocked(backfillRepo).mockRejectedValueOnce(new Error('timeout'))
  await triggerAutoBackfill(did)
  expect(backfilledDids()).toEqual([did])

  // First retry waits the 60s floor rather than firing straight back at a PDS
  // that just failed.
  await vi.advanceTimersByTimeAsync(59_000)
  expect(backfilledDids()).toEqual([did])
  await vi.advanceTimersByTimeAsync(1_000)
  expect(backfilledDids()).toEqual([did, did])
})

test('the retry backoff grows with the stored retry count', async () => {
  vi.useFakeTimers()
  const did = 'did:plc:backoff'
  await configure({ maxRetries: 5 })
  // A repo that has already failed twice waits 2 minutes, not 1.
  await setRepoStatus(did, 'failed', undefined, { retryCount: 2, retryAfter: 0 })

  vi.mocked(backfillRepo).mockRejectedValueOnce(new Error('timeout'))
  await triggerAutoBackfill(did)

  await vi.advanceTimersByTimeAsync(119_000)
  expect(backfilledDids()).toEqual([did])
  await vi.advanceTimersByTimeAsync(1_000)
  expect(backfilledDids()).toEqual([did, did])
})

test('a repo that has exhausted its retries is not scheduled again', async () => {
  vi.useFakeTimers()
  const did = 'did:plc:givenup'
  await configure({ maxRetries: 0 })

  vi.mocked(backfillRepo).mockRejectedValue(new Error('gone'))
  await triggerAutoBackfill(did)

  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(backfilledDids()).toEqual([did])
})
