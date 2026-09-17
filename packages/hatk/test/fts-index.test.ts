/**
 * search-harness.test.ts proves a flat TEXT column is searchable. This file
 * covers where the search text actually comes from in a real lexicon: JSON
 * object fields, JSON fallbacks, child tables, union branches and the author
 * handle — plus the incremental update/delete path and the search API's edge
 * cases. It boots its own database because the shared fixture has none of
 * those shapes.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { createAdapter } from '../src/database/adapter-factory.ts'
import { SQLITE_DIALECT } from '../src/database/dialect.ts'
import { generateCreateTableSQL, generateTableSchema, storeLexicons } from '../src/database/schema.ts'
import { deleteRecord, initDatabase, insertRecord, searchRecords, setRepoStatus } from '../src/database/db.ts'
import {
  buildFtsIndex,
  buildFtsRow,
  deleteFtsRecord,
  ftsTableName,
  getLastRebuiltAt,
  getSearchColumns,
  getSearchPort,
  hasSearchPort,
  rebuildAllIndexes,
  setSearchPort,
  stripStopWords,
  updateFtsRecord,
} from '../src/database/fts.ts'

const ITEM = 'test.fts.item'
const TAGGED = 'test.fts.tagged'
const NUMERIC = 'test.fts.numeric'

const itemLexicon = {
  lexicon: 1,
  id: ITEM,
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          meta: { type: 'object', properties: { mood: { type: 'string' }, n: { type: 'integer' } } },
          avatar: { type: 'blob' },
          extra: { type: 'unknown' },
          credits: { type: 'array', items: { type: 'ref', ref: 'other.lex#credit' } },
          artists: { type: 'array', items: { type: 'ref', ref: '#artist' } },
          embed: { type: 'union', refs: ['#external'] },
        },
      },
    },
    artist: { type: 'object', properties: { name: { type: 'string' }, born: { type: 'integer' } } },
    external: { type: 'object', properties: { external: { type: 'ref', ref: '#externalInfo' } } },
    externalInfo: { type: 'object', properties: { uri: { type: 'string' }, title: { type: 'string' } } },
  },
}

const taggedLexicon = {
  lexicon: 1,
  id: TAGGED,
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } },
    },
  },
}

const numericLexicon = {
  lexicon: 1,
  id: NUMERIC,
  defs: {
    main: { type: 'record', key: 'tid', record: { type: 'object', properties: { n: { type: 'integer' } } } },
  },
}

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const uri = (did: string, rkey: string) => `at://${did}/${ITEM}/${rkey}`

async function findDids(query: string, opts: { limit?: number } = {}) {
  const { records } = await searchRecords(ITEM, query, { limit: 10, ...opts })
  return records.map((r: any) => r.did)
}

beforeAll(async () => {
  const lexicons = new Map<string, any>([
    [ITEM, itemLexicon],
    [TAGGED, taggedLexicon],
    [NUMERIC, numericLexicon],
  ])
  storeLexicons(lexicons)
  const schemas = [...lexicons.keys()].map((n) => generateTableSchema(n, lexicons.get(n), lexicons, SQLITE_DIALECT))
  const { adapter, searchPort } = await createAdapter('sqlite')
  setSearchPort(searchPort)
  await initDatabase(
    adapter,
    ':memory:',
    schemas,
    schemas.map((s) => generateCreateTableSQL(s, SQLITE_DIALECT)),
  )
  await setRepoStatus(ALICE, 'active', undefined, { handle: 'alice.photography.test' })
  await setRepoStatus(BOB, 'active', undefined, { handle: 'bob.test' })
})

describe('before any index is built', () => {
  test('a collection with no TEXT column and no index has nothing to search', async () => {
    await expect(searchRecords(NUMERIC, 'x')).rejects.toThrow(/No searchable columns/)
  })

  test('the incremental hooks are no-ops for a collection whose index was never built', async () => {
    await expect(updateFtsRecord(ITEM, uri(ALICE, 'none'))).resolves.toBeUndefined()
    await expect(deleteFtsRecord(ITEM, uri(ALICE, 'none'))).resolves.toBeUndefined()
    expect(getSearchColumns(ITEM)).toEqual([])
    expect(getLastRebuiltAt(ITEM)).toBeNull()
  })

  test('searchRecords rejects a collection with no schema', async () => {
    await expect(searchRecords('no.such', 'x')).rejects.toThrow(/Unknown collection/)
  })
})

describe('building the index', () => {
  beforeAll(async () => {
    await rebuildAllIndexes([ITEM, NUMERIC, 'no.such.collection'])
  })

  test('ftsTableName replaces dots so the shadow table is a plain identifier', () => {
    expect(ftsTableName(ITEM)).toBe('_fts_test_fts_item')
  })

  test('rebuildAllIndexes records errors for unknown collections instead of throwing', () => {
    // The beforeAll above resolved despite 'no.such.collection'; the good
    // collections were still built.
    expect(getLastRebuiltAt(ITEM)).toMatch(/^\d{4}-/)
    expect(getLastRebuiltAt('no.such.collection')).toBeNull()
  })

  test('derives one search column per text source: TEXT columns, JSON columns, children, branches, handle', () => {
    const cols = getSearchColumns(ITEM)
    expect(cols).toContain('title')
    // On SQLite JSON columns are TEXT, so they are indexed whole as raw JSON
    // text rather than being split per string property as on DuckDB.
    expect(cols).toContain('meta')
    expect(cols).toContain('extra')
    expect(cols).toContain('credits')
    expect(cols).toContain('artists_name') // child table TEXT aggregated
    expect(cols).toContain('embed_external_title') // union branch TEXT aggregated
    expect(cols).toContain('handle')
    expect(cols).not.toContain('born') // child integer column is not text
  })

  test('blob columns are excluded from the index on SQLite as they are on DuckDB', () => {
    // A blob column stores {ref, mimeType, size} — a CID and a MIME type, no
    // prose. The skip is decided on isJson because SQLite types JSON columns
    // TEXT, which would otherwise route blobs into the plain-TEXT branch.
    expect(getSearchColumns(ITEM)).not.toContain('avatar')
  })

  test('even a collection with no text of its own indexes the author handle', () => {
    expect(getSearchColumns(NUMERIC)).toEqual(['handle'])
  })

  test('rebuilding again reuses the existing index and refreshes the timestamp', async () => {
    const before = getLastRebuiltAt(ITEM)!
    await new Promise((r) => setTimeout(r, 2))
    await buildFtsIndex(ITEM)
    expect(getLastRebuiltAt(ITEM)! >= before).toBe(true)
    expect(getSearchColumns(ITEM)).toContain('title')
  })

  test('an array of strings is searchable through its stored JSON text', async () => {
    await buildFtsIndex(TAGGED)
    expect(getSearchColumns(TAGGED)).toEqual(['tags', 'handle'])
    await insertRecord(TAGGED, `at://${ALICE}/${TAGGED}/1`, 'cid-t1', ALICE, { tags: ['analog', 'film'] })
    const { records } = await searchRecords(TAGGED, 'analog', { limit: 10 })
    expect(records.map((r: any) => r.did)).toEqual([ALICE])
  })
})

describe('what is searchable', () => {
  beforeAll(async () => {
    await insertRecord(ITEM, uri(ALICE, 'a1'), 'cid-a1', ALICE, {
      title: 'Darkroom prints',
      meta: { mood: 'nostalgic', n: 3 },
      extra: { note: 'silver gelatin' },
      credits: [{ who: 'Ansel' }],
      artists: [{ name: 'Cartier-Bresson' }],
      embed: { $type: `${ITEM}#external`, external: { uri: 'https://x', title: 'Magnum archive' } },
    })
    await insertRecord(ITEM, uri(BOB, 'b1'), 'cid-b1', BOB, { title: 'Gravel bike build' })
  })

  test('a TEXT column', async () => {
    expect(await findDids('darkroom')).toEqual([ALICE])
  })

  test('a string value inside a JSON object column', async () => {
    expect(await findDids('nostalgic')).toEqual([ALICE])
  })

  test('the text of an unknown-typed JSON column', async () => {
    expect(await findDids('gelatin')).toEqual([ALICE])
  })

  test('the text of a JSON array of objects', async () => {
    expect(await findDids('ansel')).toEqual([ALICE])
  })

  test('a TEXT column in a decomposed child table', async () => {
    expect(await findDids('bresson')).toEqual([ALICE])
  })

  test('a TEXT column in a union branch table', async () => {
    expect(await findDids('magnum')).toEqual([ALICE])
  })

  test('the author handle from _repos, for people search', async () => {
    expect(await findDids('photography')).toEqual([ALICE])
  })

  test('stems, so a query for the plural finds the singular', async () => {
    expect(await findDids('print')).toEqual([ALICE])
    expect(await findDids('bikes')).toEqual([BOB])
  })

  test('multi-word queries require every term', async () => {
    expect(await findDids('gravel build')).toEqual([BOB])
    expect(await findDids('gravel darkroom')).toEqual([])
  })

  test('stop words in the query are dropped rather than required', async () => {
    expect(await findDids('the darkroom')).toEqual([ALICE])
  })
})

describe('keeping the index current', () => {
  test('re-inserting a record replaces its indexed text', async () => {
    await insertRecord(ITEM, uri(BOB, 'b1'), 'cid-b1v2', BOB, { title: 'Road bike build' })
    expect(await findDids('gravel')).toEqual([])
    expect(await findDids('road')).toEqual([BOB])
  })

  test('buildFtsRow assembles the same row the index holds, and null for a missing URI', async () => {
    const row = await buildFtsRow(ITEM, uri(ALICE, 'a1'))
    expect(row).toMatchObject({ title: 'Darkroom prints', handle: 'alice.photography.test' })
    expect(JSON.parse(row!.meta!)).toEqual({ mood: 'nostalgic', n: 3 })
    expect(row!.artists_name).toBe('Cartier-Bresson')
    expect(row!.embed_external_title).toBe('Magnum archive')
    expect(await buildFtsRow(ITEM, uri(ALICE, 'nope'))).toBeNull()
  })

  test('deleting a record removes it from search', async () => {
    await insertRecord(ITEM, uri(BOB, 'b2'), 'cid-b2', BOB, { title: 'temporary listing' })
    expect(await findDids('temporary')).toEqual([BOB])
    await deleteRecord(ITEM, uri(BOB, 'b2'))
    expect(await findDids('temporary')).toEqual([])
  })

  test('a failed incremental update is logged, not thrown', async () => {
    // A search port that blows up stands in for an index that vanished
    // underneath us; the record write must still succeed.
    const sp = getSearchPort()!
    setSearchPort({
      ...sp,
      updateIndex: async () => {
        throw new Error('boom')
      },
      deleteFromIndex: async () => {
        throw new Error('boom')
      },
    })
    try {
      await expect(updateFtsRecord(ITEM, uri(ALICE, 'a1'))).resolves.toBeUndefined()
      await expect(deleteFtsRecord(ITEM, uri(ALICE, 'a1'))).resolves.toBeUndefined()
    } finally {
      setSearchPort(sp)
    }
  })
})

describe('searchRecords API', () => {
  test('returns reshaped rows without score columns', async () => {
    const { records } = await searchRecords(ITEM, 'darkroom', { limit: 10 })
    expect(records[0]).toMatchObject({ uri: uri(ALICE, 'a1'), did: ALICE })
    expect(records[0]).not.toHaveProperty('score')
    expect((records[0] as any).value.title).toBe('Darkroom prints')
    expect((records[0] as any).value.meta).toEqual({ mood: 'nostalgic', n: 3 })
  })

  test('hands back a cursor only when more matches exist beyond the limit', async () => {
    await insertRecord(ITEM, uri(ALICE, 'a2'), 'cid-a2', ALICE, { title: 'Another darkroom session' })
    const first = await searchRecords(ITEM, 'darkroom', { limit: 1 })
    expect(first.records).toHaveLength(1)
    expect(first.cursor).toBeDefined()
    const all = await searchRecords(ITEM, 'darkroom', { limit: 10 })
    expect(all.records).toHaveLength(2)
    expect(all.cursor).toBeUndefined()
  })

  test('a query that is only punctuation matches nothing rather than erroring', async () => {
    expect(await findDids('...')).toEqual([])
  })

  test('a term nobody used finds nothing', async () => {
    expect(await findDids('zeppelin')).toEqual([])
  })

  test('with the search port removed there is no BM25 phase and the result is empty, not an error', async () => {
    const sp = getSearchPort()
    setSearchPort(null)
    try {
      expect(hasSearchPort()).toBe(false)
      expect(await findDids('darkroom')).toEqual([])
      await expect(buildFtsIndex(ITEM)).resolves.toBeUndefined()
    } finally {
      setSearchPort(sp)
      expect(hasSearchPort()).toBe(true)
    }
  })

  test('records from a taken-down author are excluded even when the index still has them', async () => {
    await setRepoStatus(BOB, 'takendown')
    expect(await findDids('road')).toEqual([])
    await setRepoStatus(BOB, 'active')
    expect(await findDids('road')).toEqual([BOB])
  })
})

describe('stripStopWords', () => {
  test('drops English stop words, case-insensitively, keeping the rest in order', () => {
    expect(stripStopWords('The quick fox')).toBe('quick fox')
    expect(stripStopWords('  photos   of   Portland ')).toBe('photos Portland')
  })

  test('returns the original query when every word is a stop word', () => {
    // Searching "the" should still search "the" rather than an empty string
    expect(stripStopWords('the and of')).toBe('the and of')
  })
})
