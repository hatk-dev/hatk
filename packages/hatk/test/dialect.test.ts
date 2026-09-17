/**
 * The dialect objects are the only place SQL differences between engines
 * live; everything in db.ts and fts.ts assembles SQL from these expressions
 * and never branches on the engine name. A wrong expression here breaks every
 * caller at once, so each function is checked both as a string (DuckDB — no
 * binary in the test environment) and by running it against a real SQLite
 * engine where we can.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { DUCKDB_DIALECT, SQLITE_DIALECT, getDialect } from '../src/database/dialect.ts'
import { SQLiteAdapter } from '../src/database/adapters/sqlite.ts'

describe('getDialect', () => {
  test('returns the DuckDB and SQLite dialect objects by name', () => {
    expect(getDialect('duckdb')).toBe(DUCKDB_DIALECT)
    expect(getDialect('sqlite')).toBe(SQLITE_DIALECT)
  })

  test('postgres is declared in the Dialect type but has no implementation yet', () => {
    expect(() => getDialect('postgres')).toThrow(/PostgreSQL adapter not yet implemented/)
  })
})

describe('DUCKDB_DIALECT', () => {
  test('uses positional $N placeholders', () => {
    expect(DUCKDB_DIALECT.param(1)).toBe('$1')
    expect(DUCKDB_DIALECT.param(12)).toBe('$12')
  })

  test('maps lexicon types to native DuckDB types', () => {
    expect(DUCKDB_DIALECT.typeMap.json).toBe('JSON')
    expect(DUCKDB_DIALECT.typeMap.boolean).toBe('BOOLEAN')
    expect(DUCKDB_DIALECT.typeMap.timestamp).toBe('TIMESTAMP')
    expect(DUCKDB_DIALECT.jsonType).toBe('JSON')
    expect(DUCKDB_DIALECT.timestampType).toBe('TIMESTAMP')
  })

  test('JSON helpers use DuckDB json_extract_string and list_string_agg', () => {
    expect(DUCKDB_DIALECT.jsonExtractString('t.meta', '$.mood')).toBe("json_extract_string(t.meta, '$.mood')")
    expect(DUCKDB_DIALECT.jsonArrayStringAgg('t.tags', '$[*]')).toBe(
      "list_string_agg(json_extract_string(t.tags, '$[*]'))",
    )
  })

  test('wraps timestamp parsing in TRY_CAST so bad input yields NULL instead of an error', () => {
    // bulkInsertRecords relies on this to filter rows that would violate NOT NULL
    expect(DUCKDB_DIALECT.tryCastTimestamp('created_at')).toBe('TRY_CAST(created_at AS TIMESTAMP)')
  })

  test('aggregate helpers use GREATEST and string_agg', () => {
    expect(DUCKDB_DIALECT.greatest(['a', 'b', 'c'])).toBe('GREATEST(a, b, c)')
    expect(DUCKDB_DIALECT.stringAgg('c.name', "' '")).toBe("string_agg(c.name, ' ')")
  })

  test('advertises native capabilities SQLite lacks', () => {
    expect(DUCKDB_DIALECT.supportsAppender).toBe(true)
    expect(DUCKDB_DIALECT.supportsSequences).toBe(true)
    expect(DUCKDB_DIALECT.jaroWinklerSimilarity).toBe('jaro_winkler_similarity')
    expect(DUCKDB_DIALECT.checkpointSQL).toBe('CHECKPOINT')
    expect(DUCKDB_DIALECT.ilike).toBe('ILIKE')
    expect(DUCKDB_DIALECT.countAsInteger).toBe('COUNT(*)::INTEGER')
  })

  test('introspects columns through information_schema', () => {
    expect(DUCKDB_DIALECT.introspectColumnsQuery('app.bsky.feed.post')).toBe(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'app.bsky.feed.post'",
    )
  })

  test('the table listing hides internal underscore-prefixed tables', () => {
    expect(DUCKDB_DIALECT.listTablesQuery).toContain("NOT LIKE '\\_%'")
  })
})

describe('SQLITE_DIALECT', () => {
  test('uses anonymous ? placeholders regardless of index', () => {
    expect(SQLITE_DIALECT.param(1)).toBe('?')
    expect(SQLITE_DIALECT.param(7)).toBe('?')
  })

  test('collapses every rich type onto TEXT/INTEGER — SQLite has no JSON, BOOLEAN or TIMESTAMP', () => {
    expect(SQLITE_DIALECT.typeMap.json).toBe('TEXT')
    expect(SQLITE_DIALECT.typeMap.timestamp).toBe('TEXT')
    expect(SQLITE_DIALECT.typeMap.boolean).toBe('INTEGER')
    expect(SQLITE_DIALECT.typeMap.bigint).toBe('INTEGER')
    expect(SQLITE_DIALECT.jsonType).toBe('TEXT')
    expect(SQLITE_DIALECT.timestampType).toBe('TEXT')
  })

  test('timestamp cast is the identity — text compares lexicographically in ISO form', () => {
    expect(SQLITE_DIALECT.tryCastTimestamp('created_at')).toBe('created_at')
  })

  test('has no fuzzy search, no checkpoint, no sequences, no appender', () => {
    expect(SQLITE_DIALECT.jaroWinklerSimilarity).toBeNull()
    expect(SQLITE_DIALECT.checkpointSQL).toBeNull()
    expect(SQLITE_DIALECT.supportsSequences).toBe(false)
    expect(SQLITE_DIALECT.supportsAppender).toBe(false)
  })

  test('introspects columns with PRAGMA table_info, quoting the dotted NSID', () => {
    expect(SQLITE_DIALECT.introspectColumnsQuery('app.bsky.feed.post')).toBe('PRAGMA table_info("app.bsky.feed.post")')
  })
})

/**
 * String assertions only prove the SQLite expressions look right. These run
 * them: the shapes are what fts.ts feeds into shadow-table SELECTs, and a
 * syntax slip there makes search silently return nothing.
 */
describe('SQLITE_DIALECT expressions execute on a real SQLite engine', () => {
  const db = new SQLiteAdapter()

  beforeAll(async () => {
    await db.open(':memory:')
  })

  test('jsonExtractString pulls a nested string out of a JSON document', async () => {
    const expr = SQLITE_DIALECT.jsonExtractString(`'{"mood":"calm"}'`, '$.mood')
    const rows = await db.query<{ v: string }>(`SELECT ${expr} AS v`)
    expect(rows[0].v).toBe('calm')
  })

  test('jsonArrayStringAgg flattens a JSON string array into one space-joined text value', async () => {
    const expr = SQLITE_DIALECT.jsonArrayStringAgg(`'["vinyl","jazz","live"]'`, '$')
    const rows = await db.query<{ v: string }>(`SELECT ${expr} AS v`)
    expect(rows[0].v).toBe('vinyl jazz live')
  })

  // Unreachable today rather than broken: fts.ts (jsonSearchColumns) calls
  // jsonArrayStringAgg with the DuckDB-style paths '$[*]' and '$[*].<field>',
  // which SQLite's json_each rejects, but on SQLite jsonType is TEXT so every
  // JSON column takes computeFtsSchema's plain-TEXT branch and is indexed as
  // raw JSON text — the per-property extraction is never reached. Giving
  // SQLite real per-property JSON search is a feature (translate '$[*]' to
  // '$', '$[*].f' to a json_each subquery selecting je.value ->> 'f', and
  // rename the resulting search columns), not a correction, so it is left for
  // whoever wants that behaviour. Enable this alongside that work.
  test.todo("jsonArrayStringAgg accepts the '$[*]' wildcard path fts.ts passes it")

  test('greatest maps onto the multi-argument scalar MAX', async () => {
    const rows = await db.query<{ v: number }>(`SELECT ${SQLITE_DIALECT.greatest(['1', '9', '4'])} AS v`)
    expect(rows[0].v).toBe(9)
  })

  test('stringAgg concatenates grouped rows with the given separator', async () => {
    await db.executeMultiple(`CREATE TABLE names (n TEXT); INSERT INTO names VALUES ('x'), ('y')`)
    const rows = await db.query<{ v: string }>(`SELECT ${SQLITE_DIALECT.stringAgg('n', "'|'")} AS v FROM names`)
    expect(rows[0].v).toBe('x|y')
  })

  test('countAsInteger yields a JS number, not a bigint or string', async () => {
    const rows = await db.query<{ v: unknown }>(`SELECT ${SQLITE_DIALECT.countAsInteger} AS v FROM names`)
    expect(rows[0].v).toBe(2)
  })

  test('listTablesQuery reports user tables but hides underscore-prefixed internals', async () => {
    // The ESCAPE clause must reach SQLite as a single character, or the whole
    // query fails with "ESCAPE expression must be a single character" and
    // migrateSchema's orphan sweep silently does nothing.
    await db.executeMultiple(
      `CREATE TABLE "com.example.thing" (uri TEXT);
       CREATE TABLE "com.example.thing__tags" (parent_uri TEXT);
       CREATE TABLE "_cursor_internal" (k TEXT)`,
    )
    const rows = await db.query<{ table_name: string }>(SQLITE_DIALECT.listTablesQuery)
    const names = rows.map((r) => r.table_name)
    expect(names).toContain('com.example.thing')
    expect(names).toContain('com.example.thing__tags')
    expect(names).not.toContain('_cursor_internal')
  })

  test('introspectColumnsQuery returns name/type pairs as migrateSchema expects', async () => {
    const rows = await db.query<{ name: string; type: string }>(SQLITE_DIALECT.introspectColumnsQuery('names'))
    expect(rows).toEqual([expect.objectContaining({ name: 'n', type: 'TEXT' })])
  })
})
