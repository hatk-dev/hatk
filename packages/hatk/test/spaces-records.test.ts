import { beforeAll, expect, test } from 'vitest'
import { insertRecord } from '../src/database/db.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { buildBaseContext } from '../src/hydrate.ts'
import { InvalidRequestError } from '../src/xrpc.ts'
import { blobCid, spaceBlobUrl } from '../src/spaces/blob.ts'
import { records, requireSpace, spaceRecords } from '../src/spaces/records.ts'
import { rkeyOf, spaceUri } from '../src/spaces/uri.ts'
import { withReadableSpaces } from '../src/spaces/visibility.ts'
import {
  PUBLIC_COLLECTION,
  SPACE_AUTHORITY,
  SPACE_TYPE,
  SPACE_URI,
  fixtureLexicons,
  setupFixtureDatabase,
} from './fixture.ts'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const OTHER_SPACE = spaceUri('did:plc:other', SPACE_TYPE)
const inSpace = (space: string, did: string, rkey: string) => `${space}/${did}/${PUBLIC_COLLECTION}/${rkey}`
const publicUri = (did: string, rkey: string) => `at://${did}/${PUBLIC_COLLECTION}/${rkey}`

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  await insertRecord(PUBLIC_COLLECTION, publicUri(ALICE, 'p1'), 'c1', ALICE, { text: 'alice public' })
  await insertRecord(PUBLIC_COLLECTION, publicUri(BOB, 'p2'), 'c2', BOB, { text: 'bob public' })
  await insertRecord(PUBLIC_COLLECTION, inSpace(SPACE_URI, ALICE, 's1'), 'c3', ALICE, { text: 'alice in space' })
  await insertRecord(PUBLIC_COLLECTION, inSpace(SPACE_URI, BOB, 's2'), 'c4', BOB, { text: 'bob in space' })
  await insertRecord(PUBLIC_COLLECTION, inSpace(OTHER_SPACE, ALICE, 's3'), 'c5', ALICE, { text: 'elsewhere' })
})

// --- spaceRecords ---

test('a space outside the scope yields nothing rather than a refusal', async () => {
  expect(await spaceRecords(PUBLIC_COLLECTION, SPACE_URI)).toEqual([])
})

test('inside the scope every writer record in the space comes back, shaped', async () => {
  const rows = await withReadableSpaces([SPACE_URI], () => spaceRecords<{ text: string }>(PUBLIC_COLLECTION, SPACE_URI))
  expect(rows.map((r) => [r.did, r.value.text, r.space])).toEqual([
    [ALICE, 'alice in space', SPACE_URI],
    [BOB, 'bob in space', SPACE_URI],
  ])
})

test('a scope for one space does not open another', async () => {
  const rows = await withReadableSpaces([SPACE_URI], () => spaceRecords(PUBLIC_COLLECTION, OTHER_SPACE))
  expect(rows).toEqual([])
})

test('an unknown collection is empty, not an error', async () => {
  expect(await spaceRecords('not.a.collection', SPACE_URI)).toEqual([])
})

// --- records ---

test('records returns every row for a field value, gated', async () => {
  const unscoped = await records<{ text: string }>(PUBLIC_COLLECTION, 'did', [ALICE])
  expect(unscoped.map((r) => r.value.text)).toEqual(['alice public'])
  const scoped = await withReadableSpaces([SPACE_URI], () =>
    records<{ text: string }>(PUBLIC_COLLECTION, 'did', [ALICE]),
  )
  expect(scoped.map((r) => r.value.text)).toEqual(['alice public', 'alice in space'])
})

test('records accepts several values at once', async () => {
  const rows = await records(PUBLIC_COLLECTION, 'did', [ALICE, BOB])
  expect(rows.map((r) => r.uri).sort()).toEqual([publicUri(ALICE, 'p1'), publicUri(BOB, 'p2')].sort())
})

test('records refuses a field the schema does not know', async () => {
  // The field goes into SQL by name; a name the schema does not know is either
  // a typo or an attempt, and both are refused the same way.
  await expect(records(PUBLIC_COLLECTION, 'did; DROP TABLE x', [ALICE])).rejects.toThrow(InvalidRequestError)
  await expect(records(PUBLIC_COLLECTION, 'nope', [ALICE])).rejects.toThrow(/Unknown field/)
})

test('records with no values asks nothing', async () => {
  expect(await records(PUBLIC_COLLECTION, 'did', [])).toEqual([])
})

// --- requireSpace ---

test('requireSpace refuses outside the scope and passes inside it', () => {
  expect(() => requireSpace(SPACE_URI)).toThrow(/Not a member/)
  try {
    requireSpace(SPACE_URI)
  } catch (err) {
    expect((err as InvalidRequestError).errorName).toBe('NotAuthorized')
  }
  withReadableSpaces([SPACE_URI], () => expect(() => requireSpace(SPACE_URI)).not.toThrow())
})

// --- The context carries them ---

test('every helper is on the base context', async () => {
  const ctx = buildBaseContext({ did: ALICE })
  expect(typeof ctx.spaceRecords).toBe('function')
  expect(typeof ctx.records).toBe('function')
  expect(typeof ctx.requireSpace).toBe('function')
  expect(ctx.spaceBlobUrl(SPACE_URI, ALICE, 'bafy')).toBe(spaceBlobUrl(SPACE_URI, ALICE, 'bafy'))
  const rows = await withReadableSpaces([SPACE_URI], () => ctx.spaceRecords(PUBLIC_COLLECTION, SPACE_URI))
  expect(rows).toHaveLength(2)
})

// --- URLs and blobs ---

test('a space blob URL is the route hatk serves, with every part encoded', () => {
  const url = spaceBlobUrl(SPACE_URI, ALICE, 'bafyabc')
  expect(url.startsWith('/space-blob?')).toBe(true)
  const params = new URLSearchParams(url.slice('/space-blob?'.length))
  expect(params.get('space')).toBe(SPACE_URI)
  expect(params.get('repo')).toBe(ALICE)
  expect(params.get('cid')).toBe('bafyabc')
})

test('blobCid reads either spelling and nothing else', () => {
  expect(blobCid({ ref: { $link: 'bafy1' }, mimeType: 'image/png', size: 1 })).toBe('bafy1')
  expect(blobCid({ ref: { '/': 'bafy2' } })).toBe('bafy2')
  expect(blobCid({ ref: { '/': new Uint8Array(3) } })).toBeUndefined()
  expect(blobCid({ mimeType: 'image/png' })).toBeUndefined()
  expect(blobCid(undefined)).toBeUndefined()
  expect(blobCid('bafy')).toBeUndefined()
})

test('spaceUri and rkeyOf cover both URI shapes', () => {
  expect(spaceUri(SPACE_AUTHORITY, SPACE_TYPE)).toBe(SPACE_URI)
  expect(spaceUri(SPACE_AUTHORITY, SPACE_TYPE, 'gear-swap')).toBe(
    `at://${SPACE_AUTHORITY}/space/${SPACE_TYPE}/gear-swap`,
  )
  expect(rkeyOf(publicUri(ALICE, 'p1'))).toBe('p1')
  expect(rkeyOf(inSpace(SPACE_URI, ALICE, 's1'))).toBe('s1')
  expect(rkeyOf(SPACE_URI)).toBe('self')
})
