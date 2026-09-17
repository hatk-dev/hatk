/**
 * A record written through `insertRecord` has to be findable through
 * `searchRecords`. That sounds automatic, and it nearly is — `insertRecord`
 * calls `updateFtsRecord` on every write — but both the incremental update and
 * the BM25 query depend on the `_fts_*` shadow tables existing and on the
 * search-column cache being warm, and only `rebuildAllIndexes` does either.
 *
 * `main.ts` calls it after backfill. Nothing in the test path had a backfill to
 * hang it off, so `createTestContext` skipped it, and the result was not an
 * error: `updateFtsRecord` returns early when the column cache is empty, and
 * the BM25 phase's "no such table" is caught and recorded as a phase error. On
 * SQLite there is no second phase to recover — `SQLITE_DIALECT` sets
 * `jaroWinklerSimilarity` to null — so `ctx.search()` simply answered `[]`
 * forever, in every project built on hatk.
 *
 * This file builds the index itself rather than leaning on `./fixture.ts`,
 * which deliberately leaves FTS off, so the indexer tests that share it stay
 * cheap.
 */
import { beforeAll, expect, test } from 'vitest'
import { setupFixtureDatabase, fixtureLexicons, PUBLIC_COLLECTION } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { insertRecord, runSQL, searchRecords } from '../src/database/db.ts'
import { getSearchColumns, rebuildAllIndexes } from '../src/database/fts.ts'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

beforeAll(async () => {
  storeLexicons(fixtureLexicons())
  await setupFixtureDatabase()
  // What src/test.ts now does for every project built on hatk. The shared
  // fixture leaves it out on purpose, so do it here.
  await rebuildAllIndexes([PUBLIC_COLLECTION])

  for (const [did, handle] of [
    [ALICE, 'alice.test'],
    [BOB, 'bob.test'],
  ]) {
    await runSQL(`INSERT INTO _repos (did, status, handle) VALUES ($1, 'active', $2)`, [did, handle])
  }

  await insertRecord(PUBLIC_COLLECTION, `at://${ALICE}/${PUBLIC_COLLECTION}/self`, 'cid-a', ALICE, {
    text: 'photographer in Portland',
  })
  await insertRecord(PUBLIC_COLLECTION, `at://${BOB}/${PUBLIC_COLLECTION}/self`, 'cid-b', BOB, {
    text: 'cyclist in Seattle',
  })
})

test('the harness builds the FTS index, so search columns are known', () => {
  // The empty case is the failure mode: an empty column cache makes
  // updateFtsRecord a no-op and leaves searchRecords with nothing to query.
  expect(getSearchColumns(PUBLIC_COLLECTION).length).toBeGreaterThan(0)
})

test('a record written through insertRecord is findable', async () => {
  const { records } = await searchRecords(PUBLIC_COLLECTION, 'Portland', { limit: 10 })
  expect(records.map((r: any) => r.did)).toEqual([ALICE])
})

test('search discriminates rather than returning everything', async () => {
  const { records } = await searchRecords(PUBLIC_COLLECTION, 'cyclist', { limit: 10 })
  expect(records.map((r: any) => r.did)).toEqual([BOB])
})

test('a term nobody used finds nothing', async () => {
  const { records } = await searchRecords(PUBLIC_COLLECTION, 'kayaking', { limit: 10 })
  expect(records).toEqual([])
})
