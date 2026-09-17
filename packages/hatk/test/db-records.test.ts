/**
 * Record storage round trips: a lexicon record goes in through insertRecord
 * (or bulkInsertRecords), is split across the main table, child tables and
 * union branch tables, and must come back out of queryRecords/getRecordByUri
 * reshaped into the { uri, cid, did, value } envelope feeds consume.
 *
 * The shared fixture's two collections are flat, so this file boots its own
 * database with a lexicon that has every storage shape: scalars, JSON,
 * strongRef, a decomposed array, and a union with array/wrapper/plain branches.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import {
  createAdapter,
  generateCreateTableSQL,
  generateTableSchema,
  initDatabase,
  SQLITE_DIALECT,
} from '../src/database/index.ts'
import { setSearchPort } from '../src/database/fts.ts'
import { storeLexicons } from '../src/database/schema.ts'
import {
  buildInsertOp,
  bulkInsertRecords,
  countByField,
  countByFieldBatch,
  createBulkInserterSQL,
  deleteRecord,
  findByField,
  findByFieldBatch,
  findUriByFields,
  getAccountRecordCount,
  getAllRecordUrisForDid,
  getChildRows,
  getCollectionCounts,
  getDatabasePort,
  getRecentRecords,
  getRecordByUri,
  getRecordsByUris,
  getRecordsMap,
  getSchema,
  getSqlDialect,
  insertRecord,
  lookupByFieldBatch,
  normalizeValue,
  packCursor,
  queryRecords,
  querySQL,
  reshapeRow,
  runBatch,
  runSQL,
  setRepoStatus,
  unpackCursor,
} from '../src/database/db.ts'

const POST = 'test.hatk.post'
const LIKE = 'test.hatk.like'
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

const postLexicon = {
  lexicon: 1,
  id: POST,
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['text', 'createdAt'],
        properties: {
          text: { type: 'string' },
          createdAt: { type: 'string', format: 'datetime' },
          likeCount: { type: 'integer' },
          pinned: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          artists: { type: 'array', items: { type: 'ref', ref: '#artist' } },
          subject: { type: 'ref', ref: 'com.atproto.repo.strongRef' },
          replyTo: { type: 'string', format: 'at-uri' },
          meta: { type: 'object', properties: { mood: { type: 'string' } } },
          embed: { type: 'union', refs: ['#images', '#external', '#quote'] },
        },
      },
    },
    artist: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
        links: { type: 'array', items: { type: 'string' } },
      },
    },
    images: { type: 'object', properties: { images: { type: 'array', items: { type: 'ref', ref: '#image' } } } },
    image: { type: 'object', properties: { alt: { type: 'string' } } },
    external: { type: 'object', properties: { external: { type: 'ref', ref: '#externalInfo' } } },
    externalInfo: { type: 'object', properties: { uri: { type: 'string' }, title: { type: 'string' } } },
    quote: { type: 'object', properties: { note: { type: 'string' } } },
  },
}

const likeLexicon = {
  lexicon: 1,
  id: LIKE,
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['subject'],
        properties: { subject: { type: 'ref', ref: 'com.atproto.repo.strongRef' } },
      },
    },
  },
}

function postUri(did: string, rkey: string) {
  return `at://${did}/${POST}/${rkey}`
}

beforeAll(async () => {
  const lexicons = new Map<string, any>([
    [POST, postLexicon],
    [LIKE, likeLexicon],
  ])
  storeLexicons(lexicons)
  const schemas = [POST, LIKE].map((nsid) => generateTableSchema(nsid, lexicons.get(nsid), lexicons, SQLITE_DIALECT))
  const ddl = schemas.map((s) => generateCreateTableSQL(s, SQLITE_DIALECT))
  const { adapter, searchPort } = await createAdapter('sqlite')
  setSearchPort(searchPort)
  await initDatabase(adapter, ':memory:', schemas, ddl)

  await setRepoStatus(ALICE, 'active', undefined, { handle: 'alice.test' })
  await setRepoStatus(BOB, 'active', undefined, { handle: 'bob.test' })
})

describe('module accessors', () => {
  test('expose the port, dialect and registered schemas initDatabase was given', () => {
    expect(getDatabasePort().dialect).toBe('sqlite')
    expect(getSqlDialect()).toBe(SQLITE_DIALECT)
    expect(getSchema(POST)?.collection).toBe(POST)
    expect(getSchema('nope')).toBeUndefined()
  })
})

describe('buildInsertOp', () => {
  test('builds an upsert with every schema column, in schema order, after the envelope', () => {
    const { sql, params } = buildInsertOp(POST, postUri(ALICE, 'op'), 'cid-op', ALICE, {
      text: 'hi',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(sql).toMatch(
      /^INSERT OR REPLACE INTO "test\.hatk\.post" \(uri, cid, did, space, indexed_at, "text", "created_at"/,
    )
    // space is null: a repo URI names no space, and it is read off the URI
    // rather than passed, so no caller can leave it unset by accident.
    expect(params.slice(0, 4)).toEqual([postUri(ALICE, 'op'), 'cid-op', ALICE, null])
    expect(params[4]).toMatch(/^\d{4}-/) // indexed_at stamped now
    expect(params[5]).toBe('hi')
  })

  test('expands a strongRef into its uri and cid, and JSON-encodes structured values', () => {
    const { sql, params } = buildInsertOp(POST, postUri(ALICE, 'op'), 'c', ALICE, {
      text: 'hi',
      createdAt: '2026-01-01T00:00:00.000Z',
      subject: { uri: 'at://x/y/z', cid: 'bafy' },
      tags: ['a', 'b'],
      meta: { mood: 'calm' },
    })
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(', ')
    const value = (name: string) => params[cols.indexOf(name)]
    expect(value('"subject_uri"')).toBe('at://x/y/z')
    expect(value('"subject_cid"')).toBe('bafy')
    expect(value('"tags"')).toBe('["a","b"]')
    expect(value('"meta"')).toBe('{"mood":"calm"}')
    expect(value('"like_count"')).toBeNull() // absent optional field
  })

  test('rejects a collection with no registered schema', () => {
    expect(() => buildInsertOp('no.such.collection', 'at://x', 'c', ALICE, {})).toThrow(/Unknown collection/)
  })
})

describe('insertRecord and getRecordByUri round trip', () => {
  const uri = postUri(ALICE, 'full')

  beforeAll(async () => {
    await insertRecord(POST, uri, 'cid-full', ALICE, {
      text: 'a full post',
      createdAt: '2026-03-01T12:00:00.000Z',
      likeCount: 4,
      pinned: true,
      tags: ['vinyl', 'jazz'],
      artists: [
        { name: 'Miles', role: 'trumpet' },
        { name: 'Coltrane', role: 'sax' },
      ],
      subject: { uri: 'at://did:plc:bob/test.hatk.post/root', cid: 'bafy-root' },
      replyTo: 'at://did:plc:bob/test.hatk.post/parent',
      meta: { mood: 'calm' },
      embed: { $type: `${POST}#images`, images: [{ alt: 'first' }, { alt: 'second' }] },
    })
  })

  test('the envelope carries uri, cid, did, indexed_at and the author handle from _repos', async () => {
    const row = await getRecordByUri(uri)
    const shaped = reshapeRow(row, row.__childData, row.__unionData)!
    expect(shaped).toMatchObject({ uri, cid: 'cid-full', did: ALICE, handle: 'alice.test' })
    expect(shaped.indexed_at).toMatch(/^\d{4}-/)
  })

  test('scalar and JSON fields come back under their camelCase names with JSON parsed', async () => {
    const row = await getRecordByUri(uri)
    const { value } = reshapeRow(row, row.__childData, row.__unionData)! as any
    expect(value.text).toBe('a full post')
    expect(value.createdAt).toBe('2026-03-01T12:00:00.000Z')
    expect(value.likeCount).toBe(4)
    expect(value.tags).toEqual(['vinyl', 'jazz'])
    expect(value.meta).toEqual({ mood: 'calm' })
    expect(value.replyTo).toBe('at://did:plc:bob/test.hatk.post/parent')
    // SQLite has no boolean; the stored 1 is what consumers see
    expect(value.pinned).toBeTruthy()
  })

  test('a strongRef reads back as the { uri, cid } the lexicon declares', async () => {
    // Stored as two columns so the uri can be joined on; read as one object,
    // the shape the generated type for the field promises.
    const row = await getRecordByUri(uri)
    const { value } = reshapeRow(row)! as any
    expect(value.subject).toEqual({ uri: 'at://did:plc:bob/test.hatk.post/root', cid: 'bafy-root' })
    expect(value.subject__cid).toBeUndefined()
  })

  test('a decomposed array is rebuilt from its child table, in insertion order', async () => {
    const row = await getRecordByUri(uri)
    const { value } = reshapeRow(row, row.__childData)! as any
    expect(value.artists).toEqual([
      { name: 'Miles', role: 'trumpet', links: null },
      { name: 'Coltrane', role: 'sax', links: null },
    ])
  })

  test('a JSON column inside a child table item is parsed back on reshape', async () => {
    // `links` is an array inside each artist, so it is stored as JSON text in
    // the child table and has to be parsed back, exactly as on the main table.
    const nested = postUri(ALICE, 'nested')
    await insertRecord(POST, nested, 'cid-nested', ALICE, {
      text: 'nested arrays',
      createdAt: '2026-03-02T12:00:00.000Z',
      artists: [{ name: 'Miles', role: 'trumpet', links: ['https://a.example', 'https://b.example'] }],
    })

    try {
      const row = await getRecordByUri(nested)
      const { value } = reshapeRow(row, row.__childData)! as any
      expect(value.artists).toEqual([
        { name: 'Miles', role: 'trumpet', links: ['https://a.example', 'https://b.example'] },
      ])
    } finally {
      // Later cases count this collection's rows; leave the fixture as found.
      await deleteRecord(POST, nested)
    }
  })

  test('an array union branch is rebuilt as { $type, <arrayField>: [...] }', async () => {
    const row = await getRecordByUri(uri)
    const { value } = reshapeRow(row, row.__childData, row.__unionData)! as any
    expect(value.embed).toEqual({ $type: `${POST}#images`, images: [{ alt: 'first' }, { alt: 'second' }] })
  })

  test('the raw union JSON column is also preserved on the reshaped value', async () => {
    // reshapeRow overwrites `embed` with the branch reconstruction, so this
    // checks the stored column directly: it must still hold the full value.
    const [row] = (await querySQL(`SELECT embed FROM "${POST}" WHERE uri = $1`, [uri])) as any[]
    expect(JSON.parse(row.embed)).toEqual({ $type: `${POST}#images`, images: [{ alt: 'first' }, { alt: 'second' }] })
  })

  test('internal __childData/__unionData keys never leak into the reshaped value', async () => {
    const row = await getRecordByUri(uri)
    const shaped = reshapeRow(row, row.__childData, row.__unionData)! as any
    expect(shaped).not.toHaveProperty('__childData')
    expect(shaped.value).not.toHaveProperty('__childData')
    expect(shaped.value).not.toHaveProperty('__unionData')
  })

  test('getRecordByUri searches every collection and returns null when nothing matches', async () => {
    expect(await getRecordByUri('at://did:plc:alice/test.hatk.post/nothing')).toBeNull()
    await insertRecord(LIKE, `at://${BOB}/${LIKE}/1`, 'cid-like', BOB, { subject: { uri, cid: 'cid-full' } })
    const like = await getRecordByUri(`at://${BOB}/${LIKE}/1`)
    expect(like.subject_uri).toBe(uri)
  })
})

describe('union branch variants', () => {
  test('a wrapper branch nests its properties under the wrapper key', async () => {
    const uri = postUri(ALICE, 'ext')
    await insertRecord(POST, uri, 'cid-ext', ALICE, {
      text: 'link',
      createdAt: '2026-03-02T00:00:00.000Z',
      embed: { $type: `${POST}#external`, external: { uri: 'https://example.com', title: 'Example' } },
    })
    const row = await getRecordByUri(uri)
    const { value } = reshapeRow(row, row.__childData, row.__unionData)! as any
    expect(value.embed).toEqual({
      $type: `${POST}#external`,
      external: { uri: 'https://example.com', title: 'Example' },
    })
  })

  test('a plain branch spreads its properties next to $type', async () => {
    const uri = postUri(ALICE, 'quote')
    await insertRecord(POST, uri, 'cid-quote', ALICE, {
      text: 'quoting',
      createdAt: '2026-03-03T00:00:00.000Z',
      embed: { $type: `${POST}#quote`, note: 'well said' },
    })
    const row = await getRecordByUri(uri)
    const { value } = reshapeRow(row, row.__childData, row.__unionData)! as any
    expect(value.embed).toEqual({ $type: `${POST}#quote`, note: 'well said' })
  })

  test('a union value with a $type no branch knows is stored as JSON but yields no branch rows', async () => {
    const uri = postUri(ALICE, 'unknown-branch')
    await insertRecord(POST, uri, 'cid-ub', ALICE, {
      text: 'odd',
      createdAt: '2026-03-04T00:00:00.000Z',
      embed: { $type: 'some.other#thing', x: 1 },
    })
    const row = await getRecordByUri(uri)
    const { value } = reshapeRow(row, row.__childData, row.__unionData)! as any
    expect(value.embed).toEqual({ $type: 'some.other#thing', x: 1 })
  })
})

describe('re-inserting the same URI', () => {
  const uri = postUri(BOB, 'edit')

  test('replaces the main row, its child rows and switches union branch without leaving orphans', async () => {
    await insertRecord(POST, uri, 'cid-v1', BOB, {
      text: 'v1',
      createdAt: '2026-04-01T00:00:00.000Z',
      artists: [{ name: 'One' }, { name: 'Two' }],
      embed: { $type: `${POST}#quote`, note: 'first' },
    })
    await insertRecord(POST, uri, 'cid-v2', BOB, {
      text: 'v2',
      createdAt: '2026-04-01T00:00:00.000Z',
      artists: [{ name: 'Three' }],
      embed: { $type: `${POST}#images`, images: [{ alt: 'pic' }] },
    })
    const row = await getRecordByUri(uri)
    const shaped = reshapeRow(row, row.__childData, row.__unionData)! as any
    expect(shaped.cid).toBe('cid-v2')
    expect(shaped.value.text).toBe('v2')
    expect(shaped.value.artists).toEqual([{ name: 'Three', role: null, links: null }])
    expect(shaped.value.embed).toEqual({ $type: `${POST}#images`, images: [{ alt: 'pic' }] })
    const quotes = await querySQL(`SELECT 1 FROM "${POST}__embed_quote" WHERE parent_uri = $1`, [uri])
    expect(quotes).toEqual([])
  })

  test('omitting the array field on re-insert leaves the earlier child rows in place', async () => {
    // insertRecord only touches a child table when the field is present; a
    // record that drops the field entirely keeps whatever was there.
    await insertRecord(POST, uri, 'cid-v3', BOB, { text: 'v3', createdAt: '2026-04-01T00:00:00.000Z' })
    const children = await getChildRows(`"${POST}__artists"`, [uri])
    expect(children.get(uri)?.map((r) => r.name)).toEqual(['Three'])
  })
})

describe('deleteRecord', () => {
  test('removes the main row and every child and branch row for the URI', async () => {
    const uri = postUri(BOB, 'doomed')
    await insertRecord(POST, uri, 'cid-d', BOB, {
      text: 'bye',
      createdAt: '2026-05-01T00:00:00.000Z',
      artists: [{ name: 'X' }],
      embed: { $type: `${POST}#external`, external: { uri: 'u', title: 't' } },
    })
    await deleteRecord(POST, uri)
    expect(await getRecordByUri(uri)).toBeNull()
    expect(await querySQL(`SELECT 1 FROM "${POST}__artists" WHERE parent_uri = $1`, [uri])).toEqual([])
    expect(await querySQL(`SELECT 1 FROM "${POST}__embed_external" WHERE parent_uri = $1`, [uri])).toEqual([])
  })

  test('is a no-op for a collection with no schema or a URI that does not exist', async () => {
    await expect(deleteRecord('no.such', 'at://x')).resolves.toBeUndefined()
    await expect(deleteRecord(POST, postUri(BOB, 'never'))).resolves.toBeUndefined()
  })
})

describe('queryRecords', () => {
  // A dedicated author with a known set of records, distinct createdAt and cid
  const CAROL = 'did:plc:carol'
  const N = 5

  beforeAll(async () => {
    await setRepoStatus(CAROL, 'active', undefined, { handle: 'carol.test' })
    for (let i = 1; i <= N; i++) {
      await insertRecord(POST, postUri(CAROL, `p${i}`), `cid-c${i}`, CAROL, {
        text: `carol ${i}`,
        createdAt: `2026-06-0${i}T00:00:00.000Z`,
        likeCount: i % 2, // 1,0,1,0,1
        artists: [{ name: `artist ${i}` }],
      })
    }
  })

  test('rejects an unknown collection and an unknown sort field', async () => {
    await expect(queryRecords('no.such')).rejects.toThrow(/Unknown collection/)
    await expect(queryRecords(POST, { sort: 'nope' })).rejects.toThrow(/Invalid sort field: nope/)
  })

  test('rejects an order value that is not asc or desc before it reaches the SQL', async () => {
    // `order` is interpolated into ORDER BY, so a crafted value is SQL text.
    // `?order=desc) --` used to reach the engine and come back as a syntax
    // error, which is a parser round trip an attacker can steer.
    await expect(queryRecords(POST, { order: 'desc) --' as any })).rejects.toThrow(/Invalid sort order/)
    await expect(queryRecords(POST, { order: 'sideways' as any })).rejects.toThrow(/Invalid sort order/)
    // Case is not part of the check: uppercase still works.
    const { records } = await queryRecords(POST, { sort: 'createdAt', order: 'ASC' as any, filters: { did: CAROL } })
    expect(records[0].cid).toBe('cid-c1')
  })

  test('rejects a limit that is not a positive integer', async () => {
    // SQLite reads a negative LIMIT as unbounded, so -1 used to return every
    // row in the table rather than none.
    await expect(queryRecords(POST, { limit: -1 })).rejects.toThrow(/Invalid limit/)
    await expect(queryRecords(POST, { limit: 0 })).rejects.toThrow(/Invalid limit/)
    await expect(queryRecords(POST, { limit: 1.5 })).rejects.toThrow(/Invalid limit/)
    await expect(queryRecords(POST, { limit: NaN })).rejects.toThrow(/Invalid limit/)
  })

  test('sorts by a camelCase lexicon field, descending by default', async () => {
    const { records } = await queryRecords(POST, { sort: 'createdAt', filters: { did: CAROL } })
    expect(records.map((r: any) => r.cid)).toEqual(['cid-c5', 'cid-c4', 'cid-c3', 'cid-c2', 'cid-c1'])
  })

  test('accepts the snake_case column name as a sort field too', async () => {
    const { records } = await queryRecords(POST, { sort: 'created_at', order: 'asc', filters: { did: CAROL } })
    expect(records[0].cid).toBe('cid-c1')
  })

  test('filters on a camelCase field are mapped to the column; unknown filters are ignored', async () => {
    const { records } = await queryRecords(POST, { filters: { did: CAROL, likeCount: '1', bogus: 'x' } })
    expect(records.map((r: any) => r.cid).sort()).toEqual(['cid-c1', 'cid-c3', 'cid-c5'])
  })

  test('walks every record exactly once through cursor pages and ends without a cursor', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await queryRecords(POST, {
        sort: 'createdAt',
        order: 'asc',
        limit: 2,
        cursor,
        filters: { did: CAROL },
      })
      seen.push(...page.records.map((r: any) => r.cid))
      cursor = page.cursor
      pages++
    } while (cursor)
    expect(seen).toEqual(['cid-c1', 'cid-c2', 'cid-c3', 'cid-c4', 'cid-c5'])
    expect(pages).toBe(3)
  })

  test('a page that exactly fills the limit with nothing after it carries no cursor', async () => {
    const page = await queryRecords(POST, { sort: 'createdAt', limit: N, filters: { did: CAROL } })
    expect(page.records).toHaveLength(N)
    expect(page.cursor).toBeUndefined()
  })

  test('the cursor encodes the last row sort value and cid', async () => {
    const page = await queryRecords(POST, { sort: 'createdAt', limit: 1, filters: { did: CAROL } })
    expect(unpackCursor(page.cursor!)).toEqual({ primary: '2026-06-05T00:00:00.000Z', cid: 'cid-c5' })
  })

  test('a garbage cursor is ignored rather than failing the query', async () => {
    const page = await queryRecords(POST, { cursor: 'not-a-cursor', filters: { did: CAROL } })
    expect(page.records).toHaveLength(N)
  })

  test('rows arrive with the author handle and child data ready for reshaping', async () => {
    const { records } = await queryRecords(POST, { limit: 1, sort: 'createdAt', filters: { did: CAROL } })
    expect(records[0].handle).toBe('carol.test')
    const shaped = reshapeRow(records[0], records[0].__childData)! as any
    expect(shaped.value.artists).toEqual([{ name: 'artist 5', role: null, links: null }])
  })

  test('records from a taken-down repo disappear from listings and direct lookups', async () => {
    const DAVE = 'did:plc:dave'
    await setRepoStatus(DAVE, 'active', undefined, { handle: 'dave.test' })
    await insertRecord(POST, postUri(DAVE, 'gone'), 'cid-dave', DAVE, {
      text: 'x',
      createdAt: '2026-07-01T00:00:00.000Z',
    })
    expect((await queryRecords(POST, { filters: { did: DAVE } })).records).toHaveLength(1)
    await setRepoStatus(DAVE, 'takendown')
    expect((await queryRecords(POST, { filters: { did: DAVE } })).records).toHaveLength(0)
    expect(await getRecordByUri(postUri(DAVE, 'gone'))).toBeNull()
    expect(await getRecordsByUris(POST, [postUri(DAVE, 'gone')])).toEqual([])
  })
})

describe('batch lookups', () => {
  const uris = ['p1', 'p2', 'p3'].map((k) => postUri('did:plc:carol', k))

  test('getRecordsByUris returns rows in the requested order and skips unknown URIs', async () => {
    const rows = await getRecordsByUris(POST, [uris[2], 'at://did:plc:carol/test.hatk.post/nope', uris[0]])
    expect(rows.map((r: any) => r.uri)).toEqual([uris[2], uris[0]])
    expect(rows[0].handle).toBe('carol.test')
    expect(await getRecordsByUris(POST, [])).toEqual([])
    expect(await getRecordsByUris('no.such', uris)).toEqual([])
  })

  test('getRecordsMap keys reshaped rows by URI', async () => {
    const map = await getRecordsMap<{ text: string }>(POST, uris)
    expect([...map.keys()].sort()).toEqual([...uris].sort())
    expect(map.get(uris[1])!.value.text).toBe('carol 2')
    expect((map.get(uris[1])!.value as any).artists).toEqual([{ name: 'artist 2', role: null, links: null }])
    expect(await getRecordsMap(POST, [])).toEqual(new Map())
  })

  test('findByField returns the first matching raw row or null', async () => {
    const row = await findByField(POST, 'cid', 'cid-c2')
    expect(row.uri).toBe(uris[1])
    expect(await findByField(POST, 'cid', 'no-such-cid')).toBeNull()
    expect(await findByField('no.such', 'cid', 'x')).toBeNull()
  })

  test('findByFieldBatch groups every match under its field value with child data attached', async () => {
    const map = await findByFieldBatch(POST, 'did', ['did:plc:carol', 'did:plc:nobody'])
    expect(map.get('did:plc:carol')).toHaveLength(5)
    expect(map.has('did:plc:nobody')).toBe(false)
    expect(map.get('did:plc:carol')![0].__childData).toBeInstanceOf(Map)
    expect(await findByFieldBatch(POST, 'did', [])).toEqual(new Map())
  })

  test('lookupByFieldBatch keeps one reshaped row per value', async () => {
    const map = await lookupByFieldBatch(POST, 'cid', ['cid-c1', 'cid-c3'])
    expect((map.get('cid-c1')!.value as any).text).toBe('carol 1')
    expect((map.get('cid-c3')!.value as any).artists).toEqual([{ name: 'artist 3', role: null, links: null }])
    expect(await lookupByFieldBatch(POST, 'cid', [])).toEqual(new Map())
  })

  test('findUriByFields ANDs its conditions', async () => {
    expect(
      await findUriByFields(POST, [
        { field: 'did', value: 'did:plc:carol' },
        { field: 'like_count', value: '0' },
      ]),
    ).toBe(uris[1])
    expect(
      await findUriByFields(POST, [
        { field: 'did', value: 'did:plc:carol' },
        { field: 'cid', value: 'zzz' },
      ]),
    ).toBeNull()
    expect(await findUriByFields('no.such', [{ field: 'did', value: 'x' }])).toBeNull()
  })

  test('countByField and countByFieldBatch count matching rows as numbers', async () => {
    expect(await countByField(POST, 'did', 'did:plc:carol')).toBe(5)
    expect(await countByField(POST, 'did', 'did:plc:nobody')).toBe(0)
    expect(await countByField('no.such', 'did', 'x')).toBe(0)
    const counts = await countByFieldBatch(POST, 'did', ['did:plc:carol', ALICE, 'did:plc:nobody'])
    expect(counts.get('did:plc:carol')).toBe(5)
    expect(counts.get(ALICE)).toBe(4)
    expect(counts.has('did:plc:nobody')).toBe(false)
    expect(await countByFieldBatch(POST, 'did', [])).toEqual(new Map())
  })
})

describe('bulkInsertRecords', () => {
  const ERIN = 'did:plc:erin'

  beforeAll(async () => {
    await setRepoStatus(ERIN, 'active', undefined, { handle: 'erin.test' })
  })

  test('returns 0 and touches nothing for an empty batch or an unknown collection', async () => {
    expect(await bulkInsertRecords([])).toBe(0)
    expect(await bulkInsertRecords([{ collection: 'no.such', uri: 'at://x', cid: 'c', did: ERIN, record: {} }])).toBe(0)
  })

  test('stages and merges records with their child and union rows', async () => {
    const n = await bulkInsertRecords([
      {
        collection: POST,
        uri: postUri(ERIN, 'b1'),
        cid: 'cid-b1',
        did: ERIN,
        record: {
          text: 'bulk one',
          createdAt: '2026-08-01T00:00:00.000Z',
          likeCount: '7', // strings are coerced for integer columns
          pinned: true,
          tags: ['x'],
          subject: { uri: 'at://s/u/b', cid: 'bafy-s' },
          artists: [{ name: 'A' }, { name: 'B', role: 'bass' }],
          embed: { $type: `${POST}#images`, images: [{ alt: 'one' }, { alt: 'two' }] },
        },
      },
      {
        collection: POST,
        uri: postUri(ERIN, 'b2'),
        cid: 'cid-b2',
        did: ERIN,
        record: {
          text: 'bulk two',
          createdAt: '2026-08-02T00:00:00.000Z',
          embed: { $type: `${POST}#external`, external: { uri: 'https://e', title: 'E' } },
        },
      },
      {
        collection: LIKE,
        uri: `at://${ERIN}/${LIKE}/b`,
        cid: 'cid-bl',
        did: ERIN,
        record: { subject: { uri: postUri(ERIN, 'b1'), cid: 'cid-b1' } },
      },
    ])
    expect(n).toBe(3)

    const one = await getRecordByUri(postUri(ERIN, 'b1'))
    const shaped = reshapeRow(one, one.__childData, one.__unionData)! as any
    expect(shaped.value.text).toBe('bulk one')
    expect(shaped.value.likeCount).toBe(7)
    expect(shaped.value.tags).toEqual(['x'])
    expect(shaped.value.subject).toEqual({ uri: 'at://s/u/b', cid: 'bafy-s' })
    expect(shaped.value.artists).toEqual([
      { name: 'A', role: null, links: null },
      { name: 'B', role: 'bass', links: null },
    ])
    expect(shaped.value.embed).toEqual({ $type: `${POST}#images`, images: [{ alt: 'one' }, { alt: 'two' }] })

    const two = await getRecordByUri(postUri(ERIN, 'b2'))
    expect((reshapeRow(two, two.__childData, two.__unionData) as any).value.embed).toEqual({
      $type: `${POST}#external`,
      external: { uri: 'https://e', title: 'E' },
    })

    const like = await getRecordByUri(`at://${ERIN}/${LIKE}/b`)
    expect(like.subject_uri).toBe(postUri(ERIN, 'b1'))
  })

  test('a record missing a required field is dropped at merge instead of failing the batch', async () => {
    await bulkInsertRecords([
      {
        collection: POST,
        uri: postUri(ERIN, 'b3'),
        cid: 'cid-b3',
        did: ERIN,
        record: { createdAt: '2026-08-03T00:00:00.000Z' },
      },
      {
        collection: POST,
        uri: postUri(ERIN, 'b4'),
        cid: 'cid-b4',
        did: ERIN,
        record: { text: 'ok', createdAt: '2026-08-04T00:00:00.000Z' },
      },
    ])
    expect(await getRecordByUri(postUri(ERIN, 'b3'))).toBeNull()
    expect(await getRecordByUri(postUri(ERIN, 'b4'))).not.toBeNull()
  })

  test('re-bulk-inserting a URI replaces the row and its child rows', async () => {
    await bulkInsertRecords([
      {
        collection: POST,
        uri: postUri(ERIN, 'b1'),
        cid: 'cid-b1-v2',
        did: ERIN,
        record: { text: 'bulk one v2', createdAt: '2026-08-01T00:00:00.000Z', artists: [{ name: 'Only' }] },
      },
    ])
    const row = await getRecordByUri(postUri(ERIN, 'b1'))
    const shaped = reshapeRow(row, row.__childData, row.__unionData)! as any
    expect(shaped.cid).toBe('cid-b1-v2')
    expect(shaped.value.artists).toEqual([{ name: 'Only', role: null, links: null }])
    // No staging tables are left behind
    const staging = await querySQL(`SELECT name FROM sqlite_master WHERE name LIKE '_staging_%'`)
    expect(staging).toEqual([])
  })
})

describe('cursors', () => {
  test('packCursor/unpackCursor round-trip a sort value and cid', () => {
    const c = packCursor('2026-01-01T00:00:00.000Z', 'bafy123')
    expect(unpackCursor(c)).toEqual({ primary: '2026-01-01T00:00:00.000Z', cid: 'bafy123' })
  })

  test('a Date sort value is serialized as ISO 8601', () => {
    const c = packCursor(new Date('2026-01-01T00:00:00Z'), 'cid')
    expect(unpackCursor(c)!.primary).toBe('2026-01-01T00:00:00.000Z')
  })

  test('numeric sort values survive as their string form', () => {
    expect(unpackCursor(packCursor(42, 'cid'))).toEqual({ primary: '42', cid: 'cid' })
  })

  test('a sort value containing the separator is split on the last occurrence', () => {
    expect(unpackCursor(packCursor('a::b', 'cid'))).toEqual({ primary: 'a::b', cid: 'cid' })
  })

  test('a cursor without a separator or with junk yields null instead of throwing', () => {
    expect(unpackCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull()
    expect(unpackCursor('!!!')).toBeNull()
  })
})

describe('normalizeValue and reshapeRow edge cases', () => {
  test('DuckDB timestamp objects and bigints are normalized to ISO strings and numbers', () => {
    expect(normalizeValue({ micros: 1_700_000_000_000_000n })).toBe('2023-11-14T22:13:20.000Z')
    expect(normalizeValue(5n)).toBe(5)
    expect(normalizeValue('plain')).toBe('plain')
    expect(normalizeValue(null)).toBeNull()
  })

  test('reshapeRow returns null for a missing row', () => {
    expect(reshapeRow(null)).toBeNull()
    expect(reshapeRow(undefined)).toBeNull()
  })

  test('a row whose collection has no schema keeps its raw column names', () => {
    const shaped = reshapeRow({ uri: 'at://d/unknown.coll/1', cid: 'c', did: 'd', some_col: 'v' })! as any
    expect(shaped.value).toEqual({ some_col: 'v' })
    expect(shaped).toMatchObject({ uri: 'at://d/unknown.coll/1', cid: 'c', did: 'd' })
  })

  test('a JSON column holding text that is not valid JSON is passed through as-is', () => {
    const shaped = reshapeRow({ uri: postUri(ALICE, 'x'), meta: 'not json' })! as any
    expect(shaped.value.meta).toBe('not json')
  })
})

describe('per-account and per-collection rollups', () => {
  test('getCollectionCounts counts every registered collection in one query', async () => {
    const counts = await getCollectionCounts()
    expect(Object.keys(counts).sort()).toEqual([LIKE, POST])
    expect(counts[POST]).toBeGreaterThan(5)
    expect(counts[LIKE]).toBe(2)
  })

  test('getAccountRecordCount and getAllRecordUrisForDid span every collection', async () => {
    expect(await getAccountRecordCount(BOB)).toBe(2) // one post (edit) + one like
    const uris = await getAllRecordUrisForDid(BOB)
    expect(uris.sort()).toEqual([`at://${BOB}/${LIKE}/1`, postUri(BOB, 'edit')])
    expect(await getAccountRecordCount('did:plc:nobody')).toBe(0)
  })

  test('getRecentRecords returns records indexed after the author backfill, newest first', async () => {
    const FRAN = 'did:plc:fran'
    await setRepoStatus(FRAN, 'active')
    await runSQL(`UPDATE _repos SET backfilled_at = '2000-01-01T00:00:00.000Z' WHERE did = $1`, [FRAN])
    await insertRecord(POST, postUri(FRAN, 'r1'), 'cid-r1', FRAN, { text: 'r', createdAt: '2026-09-01T00:00:00.000Z' })
    const recent = await getRecentRecords(POST, 100)
    expect(recent.map((r: any) => r.uri)).toContain(postUri(FRAN, 'r1'))
    // Records indexed before (or at) the backfill are the backfill itself, not "recent"
    await runSQL(`UPDATE _repos SET backfilled_at = '2999-01-01T00:00:00.000Z' WHERE did = $1`, [FRAN])
    expect((await getRecentRecords(POST, 100)).map((r: any) => r.uri)).not.toContain(postUri(FRAN, 'r1'))
    expect(await getRecentRecords('no.such', 10)).toEqual([])
  })
})

describe('raw SQL helpers', () => {
  test('runBatch commits the good statements and skips the bad one', async () => {
    await runSQL(`CREATE TABLE batch_t (k TEXT PRIMARY KEY)`)
    await runBatch([
      { sql: `INSERT INTO batch_t (k) VALUES ($1)`, params: ['a'] },
      { sql: `INSERT INTO no_such_table (k) VALUES ($1)`, params: ['b'] },
      { sql: `INSERT INTO batch_t (k) VALUES ($1)`, params: ['c'] },
    ])
    const rows = (await querySQL(`SELECT k FROM batch_t ORDER BY k`)) as any[]
    expect(rows.map((r) => r.k)).toEqual(['a', 'c'])
  })

  test('createBulkInserterSQL hands out an inserter bound to the live connection', async () => {
    const ins = await createBulkInserterSQL('batch_t', ['k'], { onConflict: 'ignore' })
    ins.append(['a']) // duplicate, ignored
    ins.append(['d'])
    await ins.close()
    const rows = (await querySQL(`SELECT k FROM batch_t ORDER BY k`)) as any[]
    expect(rows.map((r) => r.k)).toEqual(['a', 'c', 'd'])
  })

  test('getChildRows groups rows by parent and returns an empty map for no parents', async () => {
    expect(await getChildRows(`"${POST}__artists"`, [])).toEqual(new Map())
    const map = await getChildRows(`"${POST}__artists"`, [
      postUri('did:plc:carol', 'p1'),
      postUri('did:plc:carol', 'p2'),
    ])
    expect(map.get(postUri('did:plc:carol', 'p1'))![0].name).toBe('artist 1')
    expect(map.get(postUri('did:plc:carol', 'p2'))![0].parent_did).toBe('did:plc:carol')
  })
})
