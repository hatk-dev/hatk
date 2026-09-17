/**
 * migrateSchema runs at every boot and reconciles the tables on disk with
 * the lexicons on disk. Getting it wrong either drops a column full of data
 * or leaves the indexer writing to a column that does not exist, so each
 * kind of drift is exercised on its own fresh in-memory database.
 *
 * Each case boots via initDatabase with the *new* schema registered but the
 * *old* DDL applied — that is exactly the state a deploy with a changed
 * lexicon finds itself in.
 */
import { describe, expect, test } from 'vitest'
import { createAdapter } from '../src/database/adapter-factory.ts'
import { SQLITE_DIALECT } from '../src/database/dialect.ts'
import { setSearchPort } from '../src/database/fts.ts'
import { generateCreateTableSQL, generateTableSchema, type TableSchema } from '../src/database/schema.ts'
import { getRepoStatus, initDatabase, migrateSchema, querySQL, runSQL, setRepoStatus } from '../src/database/db.ts'

const NSID = 'test.mig.item'

function lexicon(properties: Record<string, any>, extraDefs: Record<string, any> = {}) {
  return {
    lexicon: 1,
    id: NSID,
    defs: {
      main: { type: 'record', key: 'tid', record: { type: 'object', required: ['text'], properties } },
      ...extraDefs,
    },
  }
}

const V1 = lexicon({ text: { type: 'string' }, count: { type: 'integer' } })

function schemaFor(lex: any): TableSchema {
  return generateTableSchema(NSID, lex, new Map([[NSID, lex]]), SQLITE_DIALECT)
}

/** Fresh database with `registered` in the schema map but `applied` as DDL. */
async function boot(registered: TableSchema[], applied: TableSchema[] = registered): Promise<void> {
  const { adapter, searchPort } = await createAdapter('sqlite')
  setSearchPort(searchPort)
  await initDatabase(
    adapter,
    ':memory:',
    registered,
    applied.map((s) => generateCreateTableSQL(s, SQLITE_DIALECT)),
  )
}

async function columns(table: string): Promise<Record<string, string>> {
  const rows = (await querySQL(`PRAGMA table_info("${table}")`)) as Array<{ name: string; type: string }>
  return Object.fromEntries(rows.map((r) => [r.name, r.type]))
}

async function indexNames(table: string): Promise<string[]> {
  const rows = (await querySQL(`PRAGMA index_list("${table}")`)) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

describe('migrateSchema', () => {
  test('reports nothing to do when the table already matches the lexicon', async () => {
    const s = schemaFor(V1)
    await boot([s])
    expect(await migrateSchema([s])).toEqual([])
  })

  test('adds columns the lexicon gained and indexes any that are refs', async () => {
    const v2 = schemaFor(
      lexicon({
        text: { type: 'string' },
        count: { type: 'integer' },
        title: { type: 'string' },
        parent: { type: 'string', format: 'at-uri' },
      }),
    )
    await boot([v2], [schemaFor(V1)])

    const changes = await migrateSchema([v2])
    expect(changes).toEqual(
      expect.arrayContaining([
        { table: NSID, action: 'add', column: 'title', type: 'TEXT' },
        { table: NSID, action: 'add', column: 'parent', type: 'TEXT' },
      ]),
    )
    const cols = await columns(NSID)
    expect(cols.title).toBe('TEXT')
    expect(cols.parent).toBe('TEXT')
    expect(await indexNames(NSID)).toContain('idx_test_mig_item_parent')
    expect(await indexNames(NSID)).not.toContain('idx_test_mig_item_title')
  })

  test('drops columns the lexicon no longer has', async () => {
    const s = schemaFor(V1)
    await boot([s])
    await runSQL(`ALTER TABLE "${NSID}" ADD COLUMN legacy TEXT`)
    await runSQL(
      `INSERT INTO "${NSID}" (uri, did, indexed_at, text, legacy) VALUES ('at://a', 'did:a', 'now', 't', 'old')`,
    )

    const changes = await migrateSchema([s])
    expect(changes).toEqual([{ table: NSID, action: 'drop', column: 'legacy' }])
    expect(await columns(NSID)).not.toHaveProperty('legacy')
    // Rows survive a column drop
    expect(await querySQL(`SELECT text FROM "${NSID}"`)).toEqual([{ text: 't' }])
  })

  test('drops a ref column that was removed from the lexicon, along with its index', async () => {
    // Ref columns carry an idx_<table>_<col> index, and SQLite refuses to drop
    // a column an index still references, so the index has to go first.
    const withRef = schemaFor(lexicon({ text: { type: 'string' }, parent: { type: 'string', format: 'at-uri' } }))
    await boot([schemaFor(V1)], [withRef])
    expect(await indexNames(NSID)).toContain('idx_test_mig_item_parent')

    const changes = await migrateSchema([schemaFor(V1)])
    expect(changes).toEqual(expect.arrayContaining([{ table: NSID, action: 'drop', column: 'parent' }]))
    expect(await columns(NSID)).not.toHaveProperty('parent')
    expect(await indexNames(NSID)).not.toContain('idx_test_mig_item_parent')
  })

  test('retypes an indexed ref column and rebuilds its index', async () => {
    // retype is drop-then-add; the drop used to throw on the index, which left
    // the ADD unreached and the column stuck at its old type.
    const asRef = schemaFor(lexicon({ text: { type: 'string' }, parent: { type: 'string', format: 'at-uri' } }))
    const asInt = schemaFor(lexicon({ text: { type: 'string' }, parent: { type: 'integer' } }))
    await boot([asInt], [asRef])
    expect((await columns(NSID)).parent).toBe('TEXT')

    const changes = await migrateSchema([asInt])
    expect(changes).toEqual(
      expect.arrayContaining([{ table: NSID, action: 'retype', column: 'parent', type: 'INTEGER' }]),
    )
    expect((await columns(NSID)).parent).toBe('INTEGER')
    // No longer a ref column, so the index is gone rather than rebuilt
    expect(await indexNames(NSID)).not.toContain('idx_test_mig_item_parent')
  })

  test('retypes a column whose type changed by dropping and re-adding it', async () => {
    const asText = schemaFor(lexicon({ text: { type: 'string' }, count: { type: 'string' } }))
    await boot([asText], [schemaFor(V1)])
    expect((await columns(NSID)).count).toBe('INTEGER')

    const changes = await migrateSchema([asText])
    expect(changes).toEqual([{ table: NSID, action: 'retype', column: 'count', type: 'TEXT' }])
    expect((await columns(NSID)).count).toBe('TEXT')
  })

  test('treats dialect synonyms as the same type rather than churning columns', async () => {
    // A column created as VARCHAR (say, by an older release) is TEXT to us.
    const s = schemaFor(V1)
    await boot([s])
    await runSQL(`ALTER TABLE "${NSID}" DROP COLUMN "count"`)
    await runSQL(`ALTER TABLE "${NSID}" ADD COLUMN "count" INT`)
    await runSQL(`ALTER TABLE "${NSID}" DROP COLUMN "text"`)
    await runSQL(`ALTER TABLE "${NSID}" ADD COLUMN "text" VARCHAR`)
    expect(await migrateSchema([s])).toEqual([])
  })

  test('diffs child tables as well as the main table', async () => {
    const withChild = lexicon(
      { text: { type: 'string' }, items: { type: 'array', items: { type: 'ref', ref: '#item' } } },
      { item: { type: 'object', properties: { label: { type: 'string' } } } },
    )
    const s = schemaFor(withChild)
    await boot([s])
    await runSQL(`ALTER TABLE "${NSID}__items" ADD COLUMN stale TEXT`)
    await runSQL(`DROP INDEX idx_test_mig_item__items_label`)
    await runSQL(`ALTER TABLE "${NSID}__items" DROP COLUMN label`)

    const changes = await migrateSchema([s])
    expect(changes).toEqual(
      expect.arrayContaining([
        { table: `${NSID}__items`, action: 'add', column: 'label', type: 'TEXT' },
        { table: `${NSID}__items`, action: 'drop', column: 'stale' },
      ]),
    )
    const cols = await columns(`${NSID}__items`)
    expect(cols).toHaveProperty('label')
    expect(cols).not.toHaveProperty('stale')
  })

  test('diffs union branch tables too', async () => {
    const withUnion = lexicon(
      { text: { type: 'string' }, embed: { type: 'union', refs: ['#card'] } },
      { card: { type: 'object', properties: { heading: { type: 'string' } } } },
    )
    const s = schemaFor(withUnion)
    await boot([s])
    await runSQL(`ALTER TABLE "${NSID}__embed_card" ADD COLUMN extra TEXT`)

    const changes = await migrateSchema([s])
    expect(changes).toEqual([{ table: `${NSID}__embed_card`, action: 'drop', column: 'extra' }])
  })

  test('leaves generic JSON-storage tables alone', async () => {
    const generic: TableSchema = {
      collection: NSID,
      tableName: `"${NSID}"`,
      columns: [],
      refColumns: [],
      children: [],
      unions: [],
    }
    await boot([generic], [])
    await runSQL(`CREATE TABLE "${NSID}" (uri TEXT PRIMARY KEY, did TEXT, indexed_at TEXT, data TEXT, anything TEXT)`)
    expect(await migrateSchema([generic])).toEqual([])
    expect(await columns(NSID)).toHaveProperty('anything')
  })

  test('a brand-new collection re-queues active repos so backfill picks it up', async () => {
    // The table was created this boot; nothing to diff, but existing repos
    // have never had this collection fetched.
    const s = schemaFor(V1)
    await boot([s], [])
    await setRepoStatus('did:plc:old', 'active', undefined, { handle: 'old.test' })
    await setRepoStatus('did:plc:broken', 'failed', undefined, { retryCount: 1, retryAfter: 0 })

    expect(await migrateSchema([s])).toEqual([])
    expect(await getRepoStatus('did:plc:old')).toBe('pending')
    expect(await getRepoStatus('did:plc:broken')).toBe('failed') // only active repos are re-queued
  })

  test('a brand-new collection on an empty _repos table does nothing', async () => {
    const s = schemaFor(V1)
    await boot([s], [])
    expect(await migrateSchema([s])).toEqual([])
    expect(await querySQL(`SELECT COUNT(*) AS n FROM _repos`)).toEqual([{ n: 0 }])
  })

  test('drops a child or branch table whose field was removed from the lexicon', async () => {
    // The orphan sweep depends on dialect.listTablesQuery actually running;
    // when it throws, migrateSchema swallows it and leaves the table behind.
    const withChild = lexicon(
      { text: { type: 'string' }, items: { type: 'array', items: { type: 'ref', ref: '#item' } } },
      { item: { type: 'object', properties: { label: { type: 'string' } } } },
    )
    await boot([schemaFor(V1)], [schemaFor(withChild)])
    expect(await querySQL(`SELECT name FROM sqlite_master WHERE name = '${NSID}__items'`)).toHaveLength(1)

    await migrateSchema([schemaFor(V1)])
    expect(await querySQL(`SELECT name FROM sqlite_master WHERE name = '${NSID}__items'`)).toEqual([])
    // The collection's own table is untouched
    expect(await querySQL(`SELECT name FROM sqlite_master WHERE name = '${NSID}'`)).toHaveLength(1)
  })

  test('rejects a table name that could smuggle SQL into introspection', async () => {
    const evil: TableSchema = {
      collection: 'bad"; DROP TABLE _repos; --',
      tableName: '"x"',
      columns: [{ name: 'text', originalName: 'text', sqlType: 'TEXT', notNull: false, isRef: false, isJson: false }],
      refColumns: [],
      children: [],
      unions: [],
    }
    await boot([schemaFor(V1)])
    await expect(migrateSchema([evil])).rejects.toThrow(/Invalid table name/)
  })
})
