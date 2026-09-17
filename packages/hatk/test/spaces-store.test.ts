import { beforeAll, beforeEach, expect, test } from 'vitest'
import { insertRecord, listSpaceRecordDids, purgeSpaceRecords, querySQL, runSQL } from '../src/database/db.ts'
import { storeLexicons } from '../src/database/schema.ts'
import {
  deleteSpaceRepo,
  deleteSpaceWatch,
  getSpaceRepo,
  getSpaceWatch,
  listSpaceRepos,
  listSpaceWatches,
  putSpaceRepo,
  putSpaceWatch,
  updateSpaceWatch,
} from '../src/spaces/store.ts'
import {
  PUBLIC_COLLECTION,
  SPACE_AUTHORITY,
  SPACE_TYPE,
  SPACE_URI,
  fixtureLexicons,
  setupFixtureDatabase,
} from './fixture.ts'

const WRITER = 'did:plc:writer'
const OTHER = 'did:plc:other'

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
})

beforeEach(async () => {
  await runSQL('DELETE FROM _space_watch')
  await runSQL('DELETE FROM _space_repos')
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
})

test('a watch records the space, its authority and its type', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  expect(await getSpaceWatch(SPACE_URI)).toEqual({
    space: SPACE_URI,
    authority: SPACE_AUTHORITY,
    spaceType: SPACE_TYPE,
    readerDid: null,
    registeredUntil: null,
    lastError: null,
  })
})

test('watching a space already followed keeps its progress', async () => {
  // A second watch is a re-assertion of interest, not a reset: losing the
  // reader would make the next sweep walk every session again for nothing.
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await updateSpaceWatch(SPACE_URI, { readerDid: WRITER, registeredUntil: '2026-01-01T00:00:00.000Z' })
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  const watch = await getSpaceWatch(SPACE_URI)
  expect(watch?.readerDid).toBe(WRITER)
  expect(watch?.registeredUntil).toBe('2026-01-01T00:00:00.000Z')
})

test('an update touches only the fields it names', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await updateSpaceWatch(SPACE_URI, { readerDid: WRITER })
  await updateSpaceWatch(SPACE_URI, { lastError: 'host unreachable' })
  const watch = await getSpaceWatch(SPACE_URI)
  expect(watch?.readerDid).toBe(WRITER)
  expect(watch?.lastError).toBe('host unreachable')
})

test('an update with nothing to set is a no-op', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await updateSpaceWatch(SPACE_URI, {})
  expect((await getSpaceWatch(SPACE_URI))?.readerDid).toBeNull()
})

test('an error can be cleared once a sweep succeeds', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await updateSpaceWatch(SPACE_URI, { lastError: 'boom' })
  await updateSpaceWatch(SPACE_URI, { lastError: null })
  expect((await getSpaceWatch(SPACE_URI))?.lastError).toBeNull()
})

test('an unknown space has no watch', async () => {
  expect(await getSpaceWatch(SPACE_URI)).toBeNull()
  expect(await listSpaceWatches()).toEqual([])
})

test('writer progress is keyed by space as well as DID', async () => {
  // The same account can hold a repo in several spaces at different revisions,
  // so a DID alone is not a position.
  const other = 'at://did:plc:elsewhere/space/test.hatk.board/self'
  await putSpaceRepo({ space: SPACE_URI, did: WRITER, pds: 'https://a.test', rev: '3a' })
  await putSpaceRepo({ space: other, did: WRITER, pds: 'https://a.test', rev: '3z' })
  expect((await getSpaceRepo(SPACE_URI, WRITER))?.rev).toBe('3a')
  expect((await getSpaceRepo(other, WRITER))?.rev).toBe('3z')
})

test('storing a writer again advances its revision', async () => {
  await putSpaceRepo({ space: SPACE_URI, did: WRITER, pds: 'https://a.test', rev: '3a' })
  await putSpaceRepo({ space: SPACE_URI, did: WRITER, pds: 'https://a.test', rev: '3b' })
  expect(await listSpaceRepos(SPACE_URI)).toHaveLength(1)
  expect((await getSpaceRepo(SPACE_URI, WRITER))?.rev).toBe('3b')
})

test('a writer can be dropped from a space on its own', async () => {
  await putSpaceRepo({ space: SPACE_URI, did: WRITER, pds: null, rev: '3a' })
  await putSpaceRepo({ space: SPACE_URI, did: OTHER, pds: null, rev: '3a' })
  await deleteSpaceRepo(SPACE_URI, WRITER)
  expect((await listSpaceRepos(SPACE_URI)).map((r) => r.did)).toEqual([OTHER])
})

test('deleting a watch takes its writer set with it', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await putSpaceRepo({ space: SPACE_URI, did: WRITER, pds: null, rev: '3a' })
  await deleteSpaceWatch(SPACE_URI)
  expect(await getSpaceWatch(SPACE_URI)).toBeNull()
  expect(await listSpaceRepos(SPACE_URI)).toEqual([])
})

test('purging a writer leaves their public repo records alone', async () => {
  // The whole reason the purge is keyed by (space, did): the same person's
  // public records live in the same table.
  const publicUri = `at://${WRITER}/${PUBLIC_COLLECTION}/mine`
  const spaceUri = `${SPACE_URI}/${WRITER}/${PUBLIC_COLLECTION}/inspace`
  await insertRecord(PUBLIC_COLLECTION, publicUri, 'c1', WRITER, { text: 'public' })
  await insertRecord(PUBLIC_COLLECTION, spaceUri, 'c2', WRITER, { text: 'private' })

  await purgeSpaceRecords(SPACE_URI, WRITER, [PUBLIC_COLLECTION])

  const rows = (await querySQL(`SELECT uri FROM "${PUBLIC_COLLECTION}"`)) as { uri: string }[]
  expect(rows.map((r) => r.uri)).toEqual([publicUri])
})

test('purging one writer leaves the rest of the space intact', async () => {
  await insertRecord(PUBLIC_COLLECTION, `${SPACE_URI}/${WRITER}/${PUBLIC_COLLECTION}/a`, 'c1', WRITER, { text: 'a' })
  await insertRecord(PUBLIC_COLLECTION, `${SPACE_URI}/${OTHER}/${PUBLIC_COLLECTION}/b`, 'c2', OTHER, { text: 'b' })

  await purgeSpaceRecords(SPACE_URI, WRITER, [PUBLIC_COLLECTION])

  expect(await listSpaceRecordDids(SPACE_URI, [PUBLIC_COLLECTION])).toEqual([OTHER])
})

test('purging a writer with nothing indexed is harmless', async () => {
  await purgeSpaceRecords(SPACE_URI, WRITER, [PUBLIC_COLLECTION, 'not.a.collection'])
  expect(await listSpaceRecordDids(SPACE_URI, [PUBLIC_COLLECTION])).toEqual([])
})
