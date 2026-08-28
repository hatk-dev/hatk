/**
 * An auxiliary firehose must index like the primary one but keep its own
 * cursor: a PDS tailed directly and the relay are different seq spaces, and
 * one must never resume from — or advance — the other's row.
 */
import { beforeAll, beforeEach, expect, test } from 'vitest'
import { PRIVATE_COLLECTION, PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { getCursor, querySQL, runSQL, setRepoStatus } from '../src/database/db.ts'
import {
  _flushForTests,
  _resetCursorStateForTests,
  auxCursorKey,
  checkpointCursor,
  configureIndexer,
  getLastSeq,
  processMessage,
  setCursorKey,
} from '../src/indexer.ts'
import { buildCommitFrame } from './firehose-frame.ts'

const DID = 'did:plc:auxsource'
const COLLECTIONS = new Set([PUBLIC_COLLECTION, PRIVATE_COLLECTION])
const AUX_URL = 'ws://pds.example:4000'

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  await setRepoStatus(DID, 'active')
  await configureIndexer({
    plcUrl: 'http://plc.invalid',
    collections: COLLECTIONS,
    signalCollections: new Set<string>(),
    fetchTimeout: 1,
    maxRetries: 0,
  })
})

beforeEach(async () => {
  setPrivateCollections([])
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  await runSQL(`DELETE FROM _cursor`)
  _resetCursorStateForTests()
  setCursorKey('relay')
})

test('aux cursor key is namespaced by source URL', () => {
  expect(auxCursorKey(AUX_URL)).toBe(`relay:${AUX_URL}`)
  expect(auxCursorKey(AUX_URL)).not.toBe('relay')
})

test('a frame from an aux source indexes without touching the primary seq', async () => {
  const record = { $type: PUBLIC_COLLECTION, text: 'from the aux stream' }
  let auxSeq: number | null = null
  processMessage(
    buildCommitFrame(DID, 4242, [{ action: 'create', collection: PUBLIC_COLLECTION, rkey: 'aux1', record }]),
    COLLECTIONS,
    (seq) => {
      auxSeq = seq
    },
  )
  await _flushForTests()

  const rows = (await querySQL(`SELECT uri, text FROM "${PUBLIC_COLLECTION}"`)) as any[]
  expect(rows).toHaveLength(1)
  expect(rows[0].uri).toBe(`at://${DID}/${PUBLIC_COLLECTION}/aux1`)
  expect(rows[0].text).toBe('from the aux stream')

  // The aux seq went to its own sink; the primary never saw it.
  expect(auxSeq).toBe(4242)
  expect(getLastSeq()).toBeNull()
  await checkpointCursor()
  expect(await getCursor('relay')).toBeNull()
})

test('the primary seq sink is still the default', async () => {
  const record = { $type: PUBLIC_COLLECTION, text: 'from the relay' }
  processMessage(
    buildCommitFrame(DID, 7, [{ action: 'create', collection: PUBLIC_COLLECTION, rkey: 'primary1', record }]),
    COLLECTIONS,
  )
  await _flushForTests()
  expect(getLastSeq()).toBe(7)
  expect(await getCursor('relay')).toBe('7')
})
