/**
 * End-to-end coverage for both stream wires, against a real database.
 *
 * The two sources share everything below the wire (`applyCommit`), so the
 * contract worth pinning is that a relay frame and a Jetstream frame carrying
 * the same record produce the same rows. That also guards the relay path
 * itself, which had no end-to-end test before Jetstream was added.
 */
import { beforeAll, beforeEach, expect, test } from 'vitest'
import { PRIVATE_COLLECTION, PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { getCursor, querySQL, runSQL, setRepoStatus } from '../src/database/db.ts'
import { _flushForTests, checkpointCursor, configureIndexer, processMessage, setCursorKey } from '../src/indexer.ts'
import { processEvent } from '../src/jetstream.ts'
import { buildCommitFrame, jetstreamCommitFrame } from './firehose-frame.ts'

const DID = 'did:plc:wireparity'
const COLLECTIONS = new Set([PUBLIC_COLLECTION, PRIVATE_COLLECTION])

/** Feed a Jetstream frame the way startJetstreamIndexer's message handler does. */
function feedJetstream(json: string): void {
  const frame = JSON.parse(json)
  processEvent(frame.payload, COLLECTIONS)
}

async function rowsFor(collection: string): Promise<any[]> {
  return (await querySQL(`SELECT uri, cid, did, text FROM "${collection}" ORDER BY uri`)) as any[]
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())

  // A DID with a known status takes the "already tracked" path, so these tests
  // exercise indexing without tripping auto-backfill's network calls.
  await setRepoStatus(DID, 'active')

  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: COLLECTIONS,
    // Nothing signals, so no DID is ever a backfill candidate here.
    signalCollections: new Set<string>(),
    fetchTimeout: 1,
    maxRetries: 0,
  })
})

beforeEach(async () => {
  setPrivateCollections([])
  setCursorKey('relay')
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  await runSQL(`DELETE FROM "${PRIVATE_COLLECTION}"`)
})

// --- the parity contract ---------------------------------------------------

test('a relay frame and a Jetstream frame produce identical rows', async () => {
  const record = { $type: PUBLIC_COLLECTION, text: 'same record, two wires' }

  processMessage(
    buildCommitFrame(DID, 100, [{ action: 'create', collection: PUBLIC_COLLECTION, rkey: 'viarelay', record }]),
    COLLECTIONS,
  )
  feedJetstream(
    jetstreamCommitFrame(DID, 101, { action: 'create', collection: PUBLIC_COLLECTION, rkey: 'viajetstream', record }),
  )
  await _flushForTests()

  const rows = await rowsFor(PUBLIC_COLLECTION)
  expect(rows).toHaveLength(2)

  const [jetstreamRow, relayRow] = [
    rows.find((r) => r.uri.endsWith('viajetstream')),
    rows.find((r) => r.uri.endsWith('viarelay')),
  ]

  // Same did, same decoded field, and — the real check — the same CID, which
  // means both wires agreed on the record's content address.
  expect(relayRow.did).toBe(DID)
  expect(relayRow.text).toBe('same record, two wires')
  expect(jetstreamRow.did).toBe(relayRow.did)
  expect(jetstreamRow.text).toBe(relayRow.text)
  expect(jetstreamRow.cid).toBe(relayRow.cid)
})

// --- relay path (previously untested end-to-end) ---------------------------

test('relay: a create lands a row with the record decoded out of the CAR', async () => {
  processMessage(
    buildCommitFrame(DID, 1, [
      {
        action: 'create',
        collection: PUBLIC_COLLECTION,
        rkey: 'r1',
        record: { $type: PUBLIC_COLLECTION, text: 'hello' },
      },
    ]),
    COLLECTIONS,
  )
  await _flushForTests()

  const rows = await rowsFor(PUBLIC_COLLECTION)
  expect(rows).toHaveLength(1)
  expect(rows[0].uri).toBe(`at://${DID}/${PUBLIC_COLLECTION}/r1`)
  expect(rows[0].text).toBe('hello')
})

test('relay: an update replaces the existing row rather than duplicating it', async () => {
  const mk = (text: string, action: 'create' | 'update') =>
    buildCommitFrame(DID, 1, [
      { action, collection: PUBLIC_COLLECTION, rkey: 'r1', record: { $type: PUBLIC_COLLECTION, text } },
    ])

  processMessage(mk('before', 'create'), COLLECTIONS)
  await _flushForTests()
  processMessage(mk('after', 'update'), COLLECTIONS)
  await _flushForTests()

  const rows = await rowsFor(PUBLIC_COLLECTION)
  expect(rows).toHaveLength(1)
  expect(rows[0].text).toBe('after')
})

test('relay: a delete removes the row', async () => {
  processMessage(
    buildCommitFrame(DID, 1, [
      {
        action: 'create',
        collection: PUBLIC_COLLECTION,
        rkey: 'r1',
        record: { $type: PUBLIC_COLLECTION, text: 'doomed' },
      },
    ]),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(await rowsFor(PUBLIC_COLLECTION)).toHaveLength(1)

  processMessage(
    buildCommitFrame(DID, 2, [{ action: 'delete', collection: PUBLIC_COLLECTION, rkey: 'r1' }]),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(await rowsFor(PUBLIC_COLLECTION)).toHaveLength(0)
})

test('relay: records failing lexicon validation are skipped, not written', async () => {
  // `text` is required by the fixture lexicon.
  processMessage(
    buildCommitFrame(DID, 1, [
      { action: 'create', collection: PUBLIC_COLLECTION, rkey: 'bad', record: { $type: PUBLIC_COLLECTION } },
    ]),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(await rowsFor(PUBLIC_COLLECTION)).toHaveLength(0)
})

// --- jetstream path --------------------------------------------------------

test('jetstream: a create lands a row', async () => {
  feedJetstream(
    jetstreamCommitFrame(DID, 1, {
      action: 'create',
      collection: PUBLIC_COLLECTION,
      rkey: 'j1',
      record: { $type: PUBLIC_COLLECTION, text: 'from jetstream' },
    }),
  )
  await _flushForTests()

  const rows = await rowsFor(PUBLIC_COLLECTION)
  expect(rows).toHaveLength(1)
  expect(rows[0].uri).toBe(`at://${DID}/${PUBLIC_COLLECTION}/j1`)
  expect(rows[0].text).toBe('from jetstream')
})

test('jetstream: a delete removes the row', async () => {
  feedJetstream(
    jetstreamCommitFrame(DID, 1, {
      action: 'create',
      collection: PUBLIC_COLLECTION,
      rkey: 'j1',
      record: { $type: PUBLIC_COLLECTION, text: 'doomed' },
    }),
  )
  await _flushForTests()
  expect(await rowsFor(PUBLIC_COLLECTION)).toHaveLength(1)

  feedJetstream(jetstreamCommitFrame(DID, 2, { action: 'delete', collection: PUBLIC_COLLECTION, rkey: 'j1' }))
  await _flushForTests()
  expect(await rowsFor(PUBLIC_COLLECTION)).toHaveLength(0)
})

test('jetstream: records failing lexicon validation are skipped, not written', async () => {
  feedJetstream(
    jetstreamCommitFrame(DID, 1, {
      action: 'create',
      collection: PUBLIC_COLLECTION,
      rkey: 'bad',
      record: { $type: PUBLIC_COLLECTION },
    }),
  )
  await _flushForTests()
  expect(await rowsFor(PUBLIC_COLLECTION)).toHaveLength(0)
})

// --- private collections, on both wires ------------------------------------

test('neither wire may write a private collection from network data', async () => {
  setPrivateCollections([PRIVATE_COLLECTION])
  const record = { $type: PRIVATE_COLLECTION, text: 'spoofed' }

  processMessage(
    buildCommitFrame(DID, 1, [{ action: 'create', collection: PRIVATE_COLLECTION, rkey: 'p1', record }]),
    COLLECTIONS,
  )
  feedJetstream(jetstreamCommitFrame(DID, 2, { action: 'create', collection: PRIVATE_COLLECTION, rkey: 'p2', record }))
  await _flushForTests()

  expect(await rowsFor(PRIVATE_COLLECTION)).toHaveLength(0)
})

test('neither wire may delete a private collection row it did not create', async () => {
  // Seed a row the way the AppView itself would, then let the network try to
  // delete it — the exact shape of the bug that wiped a deployment's rows.
  setPrivateCollections([PRIVATE_COLLECTION])
  await runSQL(`INSERT INTO "${PRIVATE_COLLECTION}" (uri, cid, did, indexed_at, text) VALUES ($1,$2,$3,$4,$5)`, [
    `at://${DID}/${PRIVATE_COLLECTION}/keepme`,
    'cid-local',
    DID,
    new Date().toISOString(),
    'appview-authoritative',
  ])

  processMessage(
    buildCommitFrame(DID, 1, [{ action: 'delete', collection: PRIVATE_COLLECTION, rkey: 'keepme' }]),
    COLLECTIONS,
  )
  feedJetstream(jetstreamCommitFrame(DID, 2, { action: 'delete', collection: PRIVATE_COLLECTION, rkey: 'keepme' }))
  await _flushForTests()

  expect(await rowsFor(PRIVATE_COLLECTION)).toHaveLength(1)
})

// --- cursor separation -----------------------------------------------------

test('each wire checkpoints to its own cursor row', async () => {
  setCursorKey('relay')
  processMessage(
    buildCommitFrame(DID, 555, [
      { action: 'create', collection: PUBLIC_COLLECTION, rkey: 'c1', record: { $type: PUBLIC_COLLECTION, text: 'x' } },
    ]),
    COLLECTIONS,
  )
  await checkpointCursor()

  setCursorKey('jetstream')
  feedJetstream(
    jetstreamCommitFrame(DID, 999, {
      action: 'create',
      collection: PUBLIC_COLLECTION,
      rkey: 'c2',
      record: { $type: PUBLIC_COLLECTION, text: 'y' },
    }),
  )
  await checkpointCursor()
  await _flushForTests()

  // A Jetstream seq must never be readable as a relay cursor: resuming
  // subscribeRepos from it would replay the relay's whole retention window.
  expect(await getCursor('relay')).toBe('555')
  expect(await getCursor('jetstream')).toBe('999')
})
