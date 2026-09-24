/**
 * `#account` is how the network says an account went away or came back. A
 * deleted account's records have to leave the index, a deactivated one's have
 * to stop being served without being thrown away, and none of it may undo an
 * admin's own takedown here.
 */
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { getRecordByUri, getRepoStatus, insertRecord, querySQL, setRepoStatus } from '../src/database/db.ts'
import { emit } from '../src/logger.ts'
import { backfillEligible } from '../src/backfill.ts'
import { configureIndexer, handleAccountEvent, processMessage } from '../src/indexer.ts'
import { processEvent } from '../src/jetstream.ts'
import { cborEncode } from './firehose-frame.ts'

vi.mock('../src/logger.ts', { spy: true })
// Reactivation re-reads the repo; the network is not part of what is under test.
vi.mock('../src/backfill.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/backfill.ts')>()),
  backfillRepo: vi.fn(async () => 0),
}))

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const uriOf = (did: string, rkey = 'self') => `at://${did}/${PUBLIC_COLLECTION}/${rkey}`

async function rowsFor(did: string): Promise<number> {
  const rows = (await querySQL(`SELECT COUNT(*) AS n FROM "${PUBLIC_COLLECTION}" WHERE did = $1`, [did])) as any[]
  return Number(rows[0].n)
}

async function seed(did: string) {
  await setRepoStatus(did, 'active')
  await insertRecord(PUBLIC_COLLECTION, uriOf(did), 'cid1', did, { text: did })
  await insertRecord(PUBLIC_COLLECTION, uriOf(did, 'two'), 'cid2', did, { text: `${did} 2` })
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  await seed(ALICE)
  await seed(BOB)
  // Warms the repo status cache: only tracked DIDs are touched.
  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: new Set([PUBLIC_COLLECTION]),
    signalCollections: new Set<string>(),
    fetchTimeout: 2,
    maxRetries: 0,
    ftsRebuildInterval: 1_000_000,
  })
})

beforeEach(async () => {
  vi.mocked(emit).mockClear()
  for (const did of [ALICE, BOB]) {
    await setRepoStatus(did, 'active')
    if ((await rowsFor(did)) === 0) await seed(did)
  }
})

test('a deleted account loses every record it held, and is marked deleted', async () => {
  await handleAccountEvent(ALICE, false, 'deleted')
  expect(await rowsFor(ALICE)).toBe(0)
  expect(await getRepoStatus(ALICE)).toBe('deleted')
  // Nobody else's records go with it.
  expect(await rowsFor(BOB)).toBe(2)
})

test('a deactivated account keeps its records, and no read serves them', async () => {
  await handleAccountEvent(ALICE, false, 'deactivated')
  expect(await getRepoStatus(ALICE)).toBe('deactivated')
  expect(await rowsFor(ALICE)).toBe(2)
  expect(await getRecordByUri(uriOf(ALICE))).toBeNull()
  expect(await getRecordByUri(uriOf(BOB))).not.toBeNull()
})

test('suspended, or taken down by its host, reads the same as deactivated', async () => {
  await handleAccountEvent(ALICE, false, 'suspended')
  expect(await getRepoStatus(ALICE)).toBe('deactivated')
  await setRepoStatus(ALICE, 'active')
  await handleAccountEvent(ALICE, false, 'takendown')
  expect(await getRepoStatus(ALICE)).toBe('deactivated')
})

test('coming back makes it pending and re-reads it', async () => {
  await handleAccountEvent(ALICE, false, 'deactivated')
  await handleAccountEvent(ALICE, true, undefined)
  expect(await getRepoStatus(ALICE)).not.toBe('deactivated')
  const reactivated = vi.mocked(emit).mock.calls.find(([, op]) => op === 'account_reactivated')
  expect(reactivated?.[2]).toMatchObject({ did: ALICE, was: 'deactivated' })
})

test("an admin's takedown here is never overridden by the network", async () => {
  await setRepoStatus(ALICE, 'takendown')
  await handleAccountEvent(ALICE, true, undefined)
  expect(await getRepoStatus(ALICE)).toBe('takendown')
  await handleAccountEvent(ALICE, false, 'deleted')
  expect(await getRepoStatus(ALICE)).toBe('takendown')
  expect(await rowsFor(ALICE)).toBe(2)
})

test("a relay's own statuses change nothing", async () => {
  await handleAccountEvent(ALICE, false, 'desynchronized')
  await handleAccountEvent(ALICE, false, 'throttled')
  expect(await getRepoStatus(ALICE)).toBe('active')
})

test('an account the index does not track is ignored', async () => {
  await handleAccountEvent('did:plc:stranger', false, 'deleted')
  expect(await getRepoStatus('did:plc:stranger')).toBeNull()
})

test('an active account that is already active is left alone', async () => {
  await handleAccountEvent(ALICE, true, undefined)
  expect(await getRepoStatus(ALICE)).toBe('active')
  expect(vi.mocked(emit).mock.calls.some(([, op]) => op === 'account_reactivated')).toBe(false)
})

test('deactivated and deleted repos are not backfilled', () => {
  expect(backfillEligible('deactivated')).toBe(false)
  expect(backfillEligible('deleted')).toBe(false)
  expect(backfillEligible('pending')).toBe(true)
  expect(backfillEligible(null)).toBe(true)
})

test('Jetstream delivers account events to the same handler', async () => {
  processEvent(
    { $type: 'network.bsky.jetstream.subscribeEvents#account', did: ALICE, active: false, status: 'deleted' },
    new Set([PUBLIC_COLLECTION]),
  )
  await vi.waitFor(async () => expect(await getRepoStatus(ALICE)).toBe('deleted'))
  expect(await rowsFor(ALICE)).toBe(0)
})

test('the relay firehose delivers account events to the same handler', async () => {
  const header = cborEncode({ op: 1, t: '#account' })
  const body = cborEncode({ seq: 7, did: ALICE, time: '2026-09-24T00:00:00Z', active: false, status: 'deactivated' })
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header)
  frame.set(body, header.length)
  processMessage(frame, new Set([PUBLIC_COLLECTION]))
  await vi.waitFor(async () => expect(await getRepoStatus(ALICE)).toBe('deactivated'))
})
