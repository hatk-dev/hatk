import { beforeAll, expect, test } from 'vitest'
import { isSpaceReadable, readableSpaces, spaceFilterSql, withReadableSpaces } from '../src/spaces/visibility.ts'
import { getRecordByUri, getRecordsByUris, insertRecord, queryRecords, reshapeRow } from '../src/database/db.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { PUBLIC_COLLECTION, SPACE_URI, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'

const OTHER_SPACE = 'at://did:plc:other/space/test.hatk.board/self'
const WRITER = 'did:plc:writer'
const repoUri = 'at://did:plc:writer/app.bsky.actor.profile/public'
const spaceUri = `${SPACE_URI}/${WRITER}/${PUBLIC_COLLECTION}/inspace`
const otherUri = `${OTHER_SPACE}/${WRITER}/${PUBLIC_COLLECTION}/elsewhere`

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  await insertRecord(PUBLIC_COLLECTION, repoUri, 'cid-public', WRITER, { text: 'public' })
  await insertRecord(PUBLIC_COLLECTION, spaceUri, 'cid-space', WRITER, { text: 'members only' })
  await insertRecord(PUBLIC_COLLECTION, otherUri, 'cid-other', WRITER, { text: 'another space' })
})

test('nothing is readable outside a scope', () => {
  expect([...readableSpaces()]).toEqual([])
})

test('a scope names exactly the spaces it was given', () => {
  withReadableSpaces([SPACE_URI], () => {
    expect([...readableSpaces()]).toEqual([SPACE_URI])
  })
})

test('a nested scope replaces rather than widens', () => {
  // Widening from inside is never what a caller means: a scope that only ever
  // narrows can be reasoned about where it is written.
  withReadableSpaces([SPACE_URI], () => {
    withReadableSpaces([OTHER_SPACE], () => {
      expect([...readableSpaces()]).toEqual([OTHER_SPACE])
    })
    expect([...readableSpaces()]).toEqual([SPACE_URI])
  })
})

test('public rows are readable everywhere, space rows only in scope', () => {
  expect(isSpaceReadable(null)).toBe(true)
  expect(isSpaceReadable(undefined)).toBe(true)
  expect(isSpaceReadable(SPACE_URI)).toBe(false)
  withReadableSpaces([SPACE_URI], () => {
    expect(isSpaceReadable(SPACE_URI)).toBe(true)
    expect(isSpaceReadable(OTHER_SPACE)).toBe(false)
  })
})

test('the unscoped predicate binds no parameters at all', () => {
  const gate = spaceFilterSql('t', 5)
  expect(gate.sql).toBe('t.space IS NULL')
  expect(gate.params).toEqual([])
  expect(gate.nextIdx).toBe(5)
})

test('a scoped predicate binds one parameter per space and advances the index', () => {
  withReadableSpaces([SPACE_URI, OTHER_SPACE], () => {
    const gate = spaceFilterSql('t', 3)
    expect(gate.sql).toBe('(t.space IS NULL OR t.space IN ($3, $4))')
    expect(gate.params).toEqual([SPACE_URI, OTHER_SPACE])
    expect(gate.nextIdx).toBe(5)
  })
})

test('an empty alias addresses an unaliased table', () => {
  expect(spaceFilterSql('', 1).sql).toBe('space IS NULL')
})

test('queryRecords hides space rows from an unscoped read', async () => {
  const { records } = await queryRecords(PUBLIC_COLLECTION, {})
  expect(records.map((r: any) => r.uri)).toEqual([repoUri])
})

test('queryRecords serves a space row to a read scoped to that space', async () => {
  const uris = await withReadableSpaces([SPACE_URI], async () => {
    const { records } = await queryRecords(PUBLIC_COLLECTION, {})
    return records.map((r: any) => r.uri)
  })
  expect(uris.sort()).toEqual([repoUri, spaceUri].sort())
})

test('a scope for one space does not open another', async () => {
  const uris = await withReadableSpaces([SPACE_URI], async () => {
    const { records } = await queryRecords(PUBLIC_COLLECTION, {})
    return records.map((r: any) => r.uri)
  })
  expect(uris).not.toContain(otherUri)
})

test('getRecordByUri refuses a space row outside a scope and serves it inside one', async () => {
  expect(await getRecordByUri(spaceUri)).toBeNull()
  const row = await withReadableSpaces([SPACE_URI], () => getRecordByUri(spaceUri))
  expect(row?.uri).toBe(spaceUri)
  expect(row?.space).toBe(SPACE_URI)
})

test('getRecordsByUris drops the space rows a read may not see', async () => {
  const unscoped = await getRecordsByUris(PUBLIC_COLLECTION, [repoUri, spaceUri, otherUri])
  expect(unscoped.map((r: any) => r.uri)).toEqual([repoUri])

  const scoped = await withReadableSpaces([SPACE_URI, OTHER_SPACE], () =>
    getRecordsByUris(PUBLIC_COLLECTION, [repoUri, spaceUri, otherUri]),
  )
  expect(scoped.map((r: any) => r.uri).sort()).toEqual([otherUri, repoUri, spaceUri].sort())
})

test('the space a row came from is stored without the caller passing it', async () => {
  // Derived from the URI inside the insert, so no write path can land a space
  // row with the column left NULL and publish it to everyone.
  const row = await withReadableSpaces([SPACE_URI], () => getRecordByUri(spaceUri))
  expect(row?.space).toBe(SPACE_URI)
  const publicRow = await getRecordByUri(repoUri)
  expect(publicRow?.space).toBeNull()
})

test('reshaping keeps a space out of the envelope for public rows', () => {
  // The column is always there; the field only goes on the wire when it means
  // something, so an ordinary record is shaped exactly as it was before.
  expect(reshapeRow({ uri: repoUri, cid: 'c', did: WRITER, space: null, text: 'hi' })).not.toHaveProperty('space')
  expect(reshapeRow({ uri: spaceUri, cid: 'c', did: WRITER, space: SPACE_URI, text: 'hi' })).toMatchObject({
    space: SPACE_URI,
  })
})

test('reshaping a space row finds its schema despite the longer uri', () => {
  // Read positionally, the collection segment of a space uri is the literal
  // 'space', which matches no schema — so the columns stayed snake_cased and
  // JSON columns were handed back as strings.
  const shaped = reshapeRow({
    uri: `${SPACE_URI}/${WRITER}/${PUBLIC_COLLECTION}/shape`,
    cid: 'c',
    did: WRITER,
    space: SPACE_URI,
    text: 'hello',
  })
  expect(shaped?.value).toEqual({ text: 'hello' })
})

// --- The gate reaches hand-written SQL through the helpers that build it ---

test('feed pagination applies the gate without the feed asking', async () => {
  // Feed SQL is hand-written and nothing can inject a predicate into a string
  // somebody else wrote, so paginate builds it in — otherwise every feed author
  // would have to remember, and one who forgot would serve a private space.
  const { createPaginate } = await import('../src/feeds.ts')
  const { packCursor, unpackCursor, querySQL } = await import('../src/database/db.ts')
  const paginate = createPaginate({ db: { query: querySQL }, limit: 10, packCursor, unpackCursor })

  const unscoped = await paginate<{ uri: string }>(`SELECT uri, cid, indexed_at FROM "${PUBLIC_COLLECTION}"`)
  expect(unscoped.rows.map((r) => r.uri)).toEqual([repoUri])

  const scoped = await withReadableSpaces([SPACE_URI], () =>
    paginate<{ uri: string }>(`SELECT uri, cid, indexed_at FROM "${PUBLIC_COLLECTION}"`),
  )
  expect(scoped.rows.map((r) => r.uri).sort()).toEqual([repoUri, spaceUri].sort())
})

test('feed pagination gates the table its ordering names', async () => {
  // An aliased query orders by `p.indexed_at`, and the gate has to land on the
  // same table `cid` is read from or the SQL does not compile.
  const { createPaginate } = await import('../src/feeds.ts')
  const { packCursor, unpackCursor, querySQL } = await import('../src/database/db.ts')
  const paginate = createPaginate({ db: { query: querySQL }, limit: 10, packCursor, unpackCursor })

  const page = await withReadableSpaces([SPACE_URI], () =>
    paginate<{ uri: string }>(`SELECT p.uri, p.cid, p.indexed_at FROM "${PUBLIC_COLLECTION}" p`, {
      orderBy: 'p.indexed_at',
    }),
  )
  expect(page.rows.map((r) => r.uri).sort()).toEqual([repoUri, spaceUri].sort())
})
