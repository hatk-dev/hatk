import { beforeAll, expect, test } from 'vitest'
import { buildBaseContext, resolveRecords } from '../src/hydrate.ts'
import { insertLabels, insertRecord, setRepoStatus } from '../src/database/db.ts'
import { blobUrl } from '../src/xrpc.ts'
import { setupFixtureDatabase, PRIVATE_COLLECTION, PUBLIC_COLLECTION } from './fixture.ts'

// resolveRecords is what turns a feed's list of URIs into rows. Feeds rely on
// it to keep their ordering, to silently drop what no longer exists, and —
// most importantly — to never leak a taken-down account's records, since a
// feed generator's SQL cannot be trusted to remember that join.

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const aliceUri = (n: number) => `at://${ALICE}/${PUBLIC_COLLECTION}/${n}`
const bobUri = `at://${BOB}/${PUBLIC_COLLECTION}/1`
const privateUri = `at://${ALICE}/${PRIVATE_COLLECTION}/1`

beforeAll(async () => {
  await setupFixtureDatabase()
  await setRepoStatus(ALICE, 'active')
  await setRepoStatus(BOB, 'takendown')
  await insertRecord(PUBLIC_COLLECTION, aliceUri(1), 'cid-a1', ALICE, { text: 'first' })
  await insertRecord(PUBLIC_COLLECTION, aliceUri(2), 'cid-a2', ALICE, { text: 'second' })
  await insertRecord(PUBLIC_COLLECTION, bobUri, 'cid-b1', BOB, { text: 'bob' })
  await insertRecord(PRIVATE_COLLECTION, privateUri, 'cid-p1', ALICE, { text: 'activity' })
})

test('no URIs resolves to no rows without touching the database', async () => {
  expect(await resolveRecords([])).toEqual([])
})

test('rows come back in the order the URIs were given, reshaped into envelope + value', async () => {
  const rows = await resolveRecords([aliceUri(2), aliceUri(1)])
  expect(rows.map((r) => r.uri)).toEqual([aliceUri(2), aliceUri(1)])
  expect(rows[0]).toMatchObject({ uri: aliceUri(2), cid: 'cid-a2', did: ALICE, value: { text: 'second' } })
})

test('URIs across collections are fetched together and still returned in order', async () => {
  const rows = await resolveRecords([privateUri, aliceUri(1)])
  expect(rows.map((r) => r.uri)).toEqual([privateUri, aliceUri(1)])
  expect(rows[0].value).toEqual({ text: 'activity' })
})

test('a URI that no longer exists is dropped rather than returned as a hole', async () => {
  const rows = await resolveRecords([aliceUri(1), `at://${ALICE}/${PUBLIC_COLLECTION}/gone`, aliceUri(2)])
  expect(rows.map((r) => r.uri)).toEqual([aliceUri(1), aliceUri(2)])
})

test('records from a taken-down account are filtered out', async () => {
  const rows = await resolveRecords([aliceUri(1), bobUri])
  expect(rows.map((r) => r.uri)).toEqual([aliceUri(1)])
})

test('a URI in a collection with no schema is dropped rather than throwing', async () => {
  // getRecordsByUris on an unknown collection answers with nothing.
  const rows = await resolveRecords([`at://${ALICE}/xyz.unknown.thing/1`, aliceUri(1)])
  expect(rows.map((r) => r.uri)).toEqual([aliceUri(1)])
})

test('the base context carries the viewer and the shared helpers', async () => {
  const ctx = buildBaseContext({ did: ALICE, handle: 'alice.test' })
  expect(ctx.viewer).toEqual({ did: ALICE, handle: 'alice.test' })
  expect(ctx.blobUrl).toBe(blobUrl)
  expect(buildBaseContext(null).viewer).toBeNull()

  const rows = await ctx.db.query(`SELECT COUNT(*) AS n FROM _repos`)
  expect(Number((rows[0] as any).n)).toBe(2)
})

test('lookup keys rows by the field value and ignores empty or repeated keys', async () => {
  const ctx = buildBaseContext(null)
  expect(await ctx.lookup(PUBLIC_COLLECTION, 'did', [])).toEqual(new Map())

  const byDid = await ctx.lookup<{ text: string }>(PUBLIC_COLLECTION, 'did', [ALICE, '', ALICE, 'did:plc:nobody'])
  expect([...byDid.keys()]).toEqual([ALICE])
  expect(byDid.get(ALICE)?.did).toBe(ALICE)
})

test('count groups by the field value and ignores empty or repeated keys', async () => {
  const ctx = buildBaseContext(null)
  expect(await ctx.count(PUBLIC_COLLECTION, 'did', [])).toEqual(new Map())

  const counts = await ctx.count(PUBLIC_COLLECTION, 'did', [ALICE, ALICE, '', BOB])
  expect(counts.get(ALICE)).toBe(2)
  expect(counts.get(BOB)).toBe(1)
})

test('getRecords and labels are wired to the database helpers', async () => {
  const ctx = buildBaseContext(null)
  await insertLabels([{ src: 'self', uri: aliceUri(1), val: 'spam' }])

  const records = await ctx.getRecords<{ text: string }>(PUBLIC_COLLECTION, [aliceUri(1)])
  expect(records.get(aliceUri(1))?.value.text).toBe('first')

  const labels = await ctx.labels([aliceUri(1), aliceUri(2)])
  expect(labels.get(aliceUri(1))?.map((l: any) => l.val)).toEqual(['spam'])
  expect(labels.has(aliceUri(2))).toBe(false)
})
