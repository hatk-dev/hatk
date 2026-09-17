import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPaginate,
  defineFeed,
  executeFeed,
  feedHasHydrate,
  initFeeds,
  listFeeds,
  registerFeed,
} from '../src/feeds.ts'
import { getSchema, insertRecord, packCursor, runSQL, setRepoStatus, unpackCursor } from '../src/database/db.ts'
import { setupFixtureDatabase, PUBLIC_COLLECTION } from './fixture.ts'

// A feed is a SQL query plus a cursor. createPaginate is the part every feed
// shares: it turns "the next page after this cursor" into a keyset condition
// and reads one row past the limit to know whether a cursor is needed. Get
// that wrong and feeds either repeat items or stop a page early.

const ALICE = 'did:plc:alice'
const uri = (n: number) => `at://${ALICE}/${PUBLIC_COLLECTION}/${n}`

/** A db stub that records the SQL and params and answers with canned rows. */
function fakeDb(rows: any[]) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        return rows
      },
    },
  }
}

function paginate(rows: any[], cursor?: string, limit = 2) {
  const { db, calls } = fakeDb(rows)
  return { calls, run: createPaginate({ db, cursor, limit, packCursor, unpackCursor }) }
}

test('the first page orders by indexed_at desc with cid as tiebreaker and reads one extra row', async () => {
  const { calls, run } = paginate([])
  await run('SELECT * FROM t')
  // The space gate rides along on every page. Outside a viewer's scope it is
  // `space IS NULL`, which binds nothing and selects exactly the public repo
  // rows a feed has always returned.
  expect(calls[0].sql).toBe('SELECT * FROM t WHERE space IS NULL ORDER BY indexed_at DESC, cid DESC LIMIT $1')
  expect(calls[0].params).toEqual([3])
})

test('a full page yields a cursor built from the last row and the extra row is dropped', async () => {
  const rows = [
    { uri: 'a', cid: 'c1', indexed_at: '3' },
    { uri: 'b', cid: 'c2', indexed_at: '2' },
    { uri: 'c', cid: 'c3', indexed_at: '1' },
  ]
  const { run } = paginate(rows)
  const page = await run<{ uri: string }>('SELECT * FROM t')
  expect(page.rows.map((r) => r.uri)).toEqual(['a', 'b'])
  expect(unpackCursor(page.cursor!)).toEqual({ primary: '2', cid: 'c2' })
})

test('a short page has no cursor', async () => {
  const { run } = paginate([{ uri: 'a', cid: 'c1', indexed_at: '3' }])
  const page = await run('SELECT * FROM t')
  expect(page.rows).toHaveLength(1)
  expect(page.cursor).toBeUndefined()
})

test('a cursor becomes a keyset condition appended to an existing WHERE', async () => {
  const { calls, run } = paginate([], packCursor('2', 'c2'))
  await run('SELECT * FROM t WHERE did = $1', { params: [ALICE] })
  expect(calls[0].sql).toBe(
    'SELECT * FROM t WHERE did = $1 AND space IS NULL AND (indexed_at < $2 OR (indexed_at = $3 AND cid < $4)) ORDER BY indexed_at DESC, cid DESC LIMIT $5',
  )
  // User params come first so their placeholders stay valid.
  expect(calls[0].params).toEqual([ALICE, '2', '2', 'c2', 3])
})

test('a cursor on a query without WHERE introduces one', async () => {
  const { calls, run } = paginate([], packCursor('2', 'c2'))
  await run('SELECT * FROM t')
  expect(calls[0].sql).toContain('SELECT * FROM t WHERE space IS NULL AND (indexed_at < $1')
})

test('a WHERE inside an identifier does not count as a WHERE clause', async () => {
  // `nowhere_col` contains the letters but not the keyword.
  const { calls, run } = paginate([], packCursor('2', 'c2'))
  await run('SELECT nowhere_col FROM t')
  expect(calls[0].sql).toContain('FROM t WHERE space IS NULL AND (')
})

test('a cursor that cannot be decoded is ignored rather than failing the page', async () => {
  const { calls, run } = paginate([], 'not-a-cursor')
  await run('SELECT * FROM t')
  // The cursor contributes nothing, so the only condition left is the gate.
  expect(calls[0].sql).not.toContain('indexed_at <')
  expect(calls[0].sql).toContain('WHERE space IS NULL')
  expect(calls[0].params).toEqual([3])
})

test('a qualified sort column flips the comparison for ascending order and keeps the table alias', async () => {
  const rows = [
    { uri: 'a', cid: 'c1', played_time: '1' },
    { uri: 'b', cid: 'c2', played_time: '2' },
    { uri: 'c', cid: 'c3', played_time: '3' },
  ]
  const { calls, run } = paginate(rows, packCursor('0', 'c0'))
  const page = await run('SELECT * FROM plays p', { orderBy: 'p.played_time', order: 'ASC' })
  expect(calls[0].sql).toContain('(p.played_time > $1 OR (p.played_time = $2 AND p.cid > $3))')
  expect(calls[0].sql).toContain('ORDER BY p.played_time ASC, p.cid ASC')
  // The cursor is read from the bare column name on the row.
  expect(unpackCursor(page.cursor!)).toEqual({ primary: '2', cid: 'c2' })
})

// --- Registered feeds against the real database ---

let table: string

beforeAll(async () => {
  await setupFixtureDatabase()
  table = getSchema(PUBLIC_COLLECTION)!.tableName
  await setRepoStatus(ALICE, 'active', undefined, { handle: 'alice.test' })
  await setRepoStatus('did:plc:bob', 'takendown')
  for (let i = 1; i <= 3; i++) {
    await insertRecord(PUBLIC_COLLECTION, uri(i), `cid-${i}`, ALICE, { text: `post ${i}` })
    // Distinct, ordered timestamps so paging is deterministic.
    await runSQL(`UPDATE ${table} SET indexed_at = $1 WHERE uri = $2`, [`2024-01-0${i}T00:00:00.000Z`, uri(i)])
  }
  await insertRecord(PUBLIC_COLLECTION, `at://did:plc:bob/${PUBLIC_COLLECTION}/1`, 'cid-bob', 'did:plc:bob', {
    text: 'bob',
  })
})

test('defineFeed tags the module and gives generate an ok() passthrough', async () => {
  const feed = defineFeed({
    collection: PUBLIC_COLLECTION,
    label: 'X',
    generate: async (ctx) => ctx.ok({ uris: [ctx.params.p] }),
  })
  expect(feed.__type).toBe('feed')
  expect(await feed.generate({ params: { p: 'u' } })).toEqual({ uris: ['u'] })
})

test('an unknown feed resolves to null so the server can 404', async () => {
  expect(await executeFeed('nope', {}, undefined, 10)).toBeNull()
  expect(feedHasHydrate('nope')).toBe(false)
})

test('a registered feed pages through the table newest first using ctx.paginate', async () => {
  registerFeed(
    'recent',
    defineFeed({
      collection: PUBLIC_COLLECTION,
      label: 'Recent',
      generate: async (ctx) => {
        const { rows, cursor } = await ctx.paginate<{ uri: string }>(`SELECT uri, cid, indexed_at FROM ${table}`)
        return ctx.ok({ uris: rows.map((r) => r.uri), cursor })
      },
    }),
  )

  const first = await executeFeed('recent', {}, undefined, 2)
  expect(first?.uris).toEqual([`at://did:plc:bob/${PUBLIC_COLLECTION}/1`, uri(3)])
  expect(first?.cursor).toBeDefined()

  // The second page holds exactly the last two rows: nothing beyond the limit,
  // so no cursor — the client knows it has reached the end without a third call.
  const second = await executeFeed('recent', {}, first!.cursor, 2)
  expect(second?.uris).toEqual([uri(2), uri(1)])
  expect(second?.cursor).toBeUndefined()
})

test('a generator may return a bare array of rows or URIs', async () => {
  registerFeed('rows', {
    __type: 'feed',
    label: 'Rows',
    collection: PUBLIC_COLLECTION,
    generate: async () => [{ uri: uri(1) }, uri(2)] as any,
  } as any)
  expect(await executeFeed('rows', {}, undefined, 10)).toEqual({ uris: [uri(1), uri(2)], cursor: undefined })
})

test('the feed context exposes the viewer, the takedown helpers and the database', async () => {
  let seen: any
  registerFeed(
    'ctx',
    defineFeed({
      collection: PUBLIC_COLLECTION,
      label: 'Ctx',
      generate: async (ctx) => {
        seen = {
          viewer: ctx.viewer,
          limit: ctx.limit,
          cursor: ctx.cursor,
          bobTakendown: await ctx.isTakendown('did:plc:bob'),
          filtered: await ctx.filterTakendownDids([ALICE, 'did:plc:bob']),
          roundtrip: ctx.unpackCursor(ctx.packCursor('k', 'c')),
          count: Number(((await ctx.db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0] as any).n),
        }
        return ctx.ok({ uris: [] })
      },
    }),
  )
  await executeFeed('ctx', {}, 'cur', 7, { did: ALICE })
  expect(seen).toEqual({
    viewer: { did: ALICE },
    limit: 7,
    cursor: 'cur',
    bobTakendown: true,
    filtered: new Set(['did:plc:bob']),
    roundtrip: { primary: 'k', cid: 'c' },
    count: 4,
  })
})

test('an actor handle is resolved to a DID before the generator runs', async () => {
  let actor: string | undefined
  registerFeed(
    'author',
    defineFeed({
      collection: PUBLIC_COLLECTION,
      label: 'Author',
      generate: async (ctx) => {
        actor = ctx.params.actor
        return ctx.ok({ uris: [] })
      },
    }),
  )
  await executeFeed('author', { actor: 'alice.test' }, undefined, 10)
  expect(actor).toBe(ALICE)

  // A DID passes through, and an unknown handle is left for the generator to reject.
  await executeFeed('author', { actor: ALICE }, undefined, 10)
  expect(actor).toBe(ALICE)
  await executeFeed('author', { actor: 'nobody.test' }, undefined, 10)
  expect(actor).toBe('nobody.test')
})

test('a feed with hydrate gets resolved rows and returns items instead of uris', async () => {
  let hydrateCtx: any
  registerFeed(
    'hydrated',
    defineFeed({
      label: 'Hydrated',
      generate: async (ctx) => ctx.ok({ uris: [uri(1), `at://did:plc:bob/${PUBLIC_COLLECTION}/1`], cursor: 'next' }),
      hydrate: async (ctx, items) => {
        hydrateCtx = ctx
        return items.map((i: any) => ({ uri: i.uri, text: i.value.text }))
      },
    }),
  )
  expect(feedHasHydrate('hydrated')).toBe(true)

  const result = await executeFeed('hydrated', {}, undefined, 10, { did: ALICE })
  // Bob is taken down, so resolveRecords dropped him before hydrate ran.
  expect(result).toEqual({ items: [{ uri: uri(1), text: 'post 1' }], cursor: 'next' })
  expect(result?.uris).toBeUndefined()
  expect(hydrateCtx.viewer).toEqual({ did: ALICE })
})

test('listFeeds reports each feed by name and label, defaulting the label to the name', () => {
  registerFeed('unlabeled', { __type: 'feed', generate: async () => ({ uris: [] }) } as any)
  const feeds = listFeeds()
  expect(feeds).toContainEqual({ name: 'recent', label: 'Recent' })
  expect(feeds).toContainEqual({ name: 'unlabeled', label: 'unlabeled' })
})

// --- Discovery from a feeds/ directory ---

let dir: string
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('initFeeds loads every module in the directory, skipping underscore-prefixed helpers', async () => {
  dir = await mkdtemp(join(tmpdir(), 'hatk-feeds-'))
  await writeFile(
    join(dir, 'fromdisk.ts'),
    `export default { label: 'From disk', generate: async (ctx) => ({ uris: [ctx.params.x] }) }\n`,
  )
  await writeFile(
    join(dir, 'withhydrate.js'),
    `export default { generate: async () => [], hydrate: async () => ['h'] }\n`,
  )
  await writeFile(
    join(dir, '_shared.ts'),
    `export default { generate: async () => { throw new Error('loaded helper') } }\n`,
  )
  await writeFile(join(dir, 'notes.md'), '# not a feed\n')
  await mkdir(join(dir, 'sub'))

  await initFeeds(dir)

  expect(listFeeds()).toContainEqual({ name: 'fromdisk', label: 'From disk' })
  expect(listFeeds()).toContainEqual({ name: 'withhydrate', label: 'withhydrate' })
  expect(listFeeds().map((f) => f.name)).not.toContain('_shared')
  expect(await executeFeed('fromdisk', { x: 'u1' }, undefined, 10)).toEqual({ uris: ['u1'], cursor: undefined })
  expect(feedHasHydrate('withhydrate')).toBe(true)
  expect(await executeFeed('withhydrate', {}, undefined, 10)).toEqual({ items: ['h'], cursor: undefined })
})

test('a missing feeds directory is not an error', async () => {
  await expect(initFeeds(join(tmpdir(), 'hatk-feeds-does-not-exist'))).resolves.toBeUndefined()
})
