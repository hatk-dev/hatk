/**
 * The cursor checkpoint runs on a timer, deliberately independent of the write
 * path. An AppView whose collections are rare on the firehose never flushes a
 * batch, so the flush-path cursor write alone leaves the stored cursor frozen —
 * and a frozen cursor makes the relay replay its entire retention window at
 * line rate on every boot and reconnect.
 *
 * This file owns fake timers from the first line so the interval
 * `configureIndexer` installs is one the test can advance.
 */
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { getCursor, runSQL, setCursor } from '../src/database/db.ts'
import { _resetCursorStateForTests, configureIndexer, noteSeq } from '../src/indexer.ts'

vi.mock('../src/database/db.ts', { spy: true })

const COLLECTIONS = new Set([PUBLIC_COLLECTION])

const opts = {
  plcUrl: 'http://plc.invalid',
  collections: COLLECTIONS,
  signalCollections: new Set<string>(),
  fetchTimeout: 1,
  maxRetries: 0,
  ftsRebuildInterval: 1_000_000,
}

/** better-sqlite3 resolves in microtasks, so draining them settles the timer's write. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeAll(async () => {
  // Installed before configureIndexer so its interval is a fake one.
  vi.useFakeTimers()
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  await configureIndexer(opts)
})

beforeEach(async () => {
  await runSQL(`DELETE FROM _cursor`)
  _resetCursorStateForTests()
  vi.mocked(setCursor).mockClear()
})

test('the cursor is persisted on the timer even when no batch ever flushes', async () => {
  noteSeq(24943722777)
  expect(await getCursor('relay')).toBeNull()

  await vi.advanceTimersByTimeAsync(5000)
  await settle()

  expect(await getCursor('relay')).toBe('24943722777')
})

test('the timer writes nothing while the seq has not moved', async () => {
  // A stream that is connected but quiet must not write the same value every
  // five seconds forever.
  noteSeq(100)
  await vi.advanceTimersByTimeAsync(5000)
  await settle()
  vi.mocked(setCursor).mockClear()

  await vi.advanceTimersByTimeAsync(15_000)
  await settle()
  expect(setCursor).not.toHaveBeenCalled()
})

test('reconfiguring on reconnect does not stack a second checkpoint timer', async () => {
  // startIndexer calls configureIndexer again on every reconnect; a stacked
  // interval would multiply cursor writes by the number of reconnects.
  await configureIndexer(opts)
  await configureIndexer(opts)

  noteSeq(777)
  await vi.advanceTimersByTimeAsync(5000)
  await settle()

  expect(setCursor).toHaveBeenCalledTimes(1)
  expect(await getCursor('relay')).toBe('777')
})
