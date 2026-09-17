import { afterEach, beforeAll, expect, test } from 'vitest'
import {
  UngatedSpaceQueryError,
  assertGatedSql,
  guardedQuerySQL,
  setSpaceBackedCollections,
  spaceBackedCollections,
  unfilteredQuerySQL,
} from '../src/spaces/guard.ts'
import { createPaginate } from '../src/feeds.ts'
import { insertRecord, packCursor, unpackCursor } from '../src/database/db.ts'
import { spaceFilterSql, withReadableSpaces } from '../src/spaces/visibility.ts'
import { PRIVATE_COLLECTION, PUBLIC_COLLECTION, SPACE_URI, setupFixtureDatabase } from './fixture.ts'

const WRITER = 'did:plc:writer'
const publicUri = `at://${WRITER}/${PUBLIC_COLLECTION}/pub`
const spaceUri = `${SPACE_URI}/${WRITER}/${PUBLIC_COLLECTION}/priv`

beforeAll(async () => {
  await setupFixtureDatabase()
  await insertRecord(PUBLIC_COLLECTION, publicUri, 'c1', WRITER, { text: 'public' })
  await insertRecord(PUBLIC_COLLECTION, spaceUri, 'c2', WRITER, { text: 'private' })
})

afterEach(() => {
  setSpaceBackedCollections([])
})

// --- When nothing is space-backed, the guard does not exist ---

test('with no space configured, any SQL is allowed', () => {
  // Every deployment that predates spaces: the set is empty, the check is a
  // Set lookup that never matches, and no feed anybody wrote can trip it.
  expect(spaceBackedCollections().size).toBe(0)
  expect(() => assertGatedSql(`SELECT * FROM "${PUBLIC_COLLECTION}"`)).not.toThrow()
})

// --- Once a collection is space-backed ---

test('a raw query over a space-backed table without the gate is refused by name', () => {
  setSpaceBackedCollections([PUBLIC_COLLECTION])
  expect(() => assertGatedSql(`SELECT * FROM "${PUBLIC_COLLECTION}" ORDER BY indexed_at`)).toThrow(
    UngatedSpaceQueryError,
  )
  try {
    assertGatedSql(`SELECT * FROM "${PUBLIC_COLLECTION}"`)
  } catch (err) {
    expect((err as UngatedSpaceQueryError).table).toBe(PUBLIC_COLLECTION)
    expect((err as Error).message).toContain('ctx.spaceFilter')
    expect((err as Error).message).toContain('ctx.db.unfiltered')
  }
})

test('a query over a table no space writes into is left alone', () => {
  setSpaceBackedCollections([PUBLIC_COLLECTION])
  expect(() => assertGatedSql(`SELECT * FROM "${PRIVATE_COLLECTION}"`)).not.toThrow()
  expect(() => assertGatedSql(`SELECT did FROM _repos`)).not.toThrow()
})

test('the gate in either of its shapes satisfies the guard', () => {
  setSpaceBackedCollections([PUBLIC_COLLECTION])
  const unscoped = spaceFilterSql('t', 1)
  expect(() => assertGatedSql(`SELECT * FROM "${PUBLIC_COLLECTION}" t WHERE ${unscoped.sql}`)).not.toThrow()
  withReadableSpaces([SPACE_URI], () => {
    const scoped = spaceFilterSql('t', 1)
    expect(scoped.sql).toContain('IN (')
    expect(() => assertGatedSql(`SELECT * FROM "${PUBLIC_COLLECTION}" t WHERE ${scoped.sql}`)).not.toThrow()
  })
})

test('selecting one space by name is not the same as being allowed to read it', () => {
  // The documented mistake: `t.space = $1` mentions the column and passes a
  // naive "does it say space" check while serving any space the caller names.
  setSpaceBackedCollections([PUBLIC_COLLECTION])
  expect(() => assertGatedSql(`SELECT * FROM "${PUBLIC_COLLECTION}" t WHERE t.space = $1`)).toThrow(
    UngatedSpaceQueryError,
  )
})

test('the gate token is matched regardless of case and spacing', () => {
  setSpaceBackedCollections([PUBLIC_COLLECTION])
  expect(() => assertGatedSql(`select * from "${PUBLIC_COLLECTION}" where space   IS  null`)).not.toThrow()
})

// --- The two doors ---

test('the guarded query refuses and the unfiltered one answers', async () => {
  setSpaceBackedCollections([PUBLIC_COLLECTION])
  const sql = `SELECT uri FROM "${PUBLIC_COLLECTION}" ORDER BY uri`
  await expect(guardedQuerySQL(sql)).rejects.toThrow(UngatedSpaceQueryError)
  const rows = (await unfilteredQuerySQL(sql)) as { uri: string }[]
  expect(rows.map((r) => r.uri).sort()).toEqual([publicUri, spaceUri].sort())
})

test('a gated raw query goes through and serves only what the scope allows', async () => {
  setSpaceBackedCollections([PUBLIC_COLLECTION])
  const gate = spaceFilterSql('t', 1)
  const rows = (await guardedQuerySQL(`SELECT t.uri FROM "${PUBLIC_COLLECTION}" t WHERE ${gate.sql}`, gate.params)) as {
    uri: string
  }[]
  expect(rows.map((r) => r.uri)).toEqual([publicUri])
})

test('a feed through paginate never trips the guard', async () => {
  // paginate builds the gate in, so the SQL it runs always carries the token —
  // which is the whole reason ordinary feeds need no author attention.
  setSpaceBackedCollections([PUBLIC_COLLECTION])
  const paginate = createPaginate({ db: { query: guardedQuerySQL }, limit: 10, packCursor, unpackCursor })
  const page = await paginate<{ uri: string }>(`SELECT uri, cid, indexed_at FROM "${PUBLIC_COLLECTION}"`)
  expect(page.rows.map((r) => r.uri)).toEqual([publicUri])
})
