/**
 * db.ts writes DuckDB-flavoured SQL (`$1`, booleans, `INSERT OR REPLACE`) and
 * relies on the SQLite adapter to translate. The translation is the whole
 * reason one code path can serve both engines, so its edge cases — repeated
 * placeholders, booleans, no-param statements — are pinned here directly
 * against the adapter, without the rest of db.ts in the way.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { SQLiteAdapter } from '../src/database/adapters/sqlite.ts'
import { SQLiteSearchPort } from '../src/database/adapters/sqlite-search.ts'
import { createAdapter } from '../src/database/adapter-factory.ts'

describe('createAdapter', () => {
  test('sqlite returns an adapter paired with a search port that shares its connection', async () => {
    const { adapter, searchPort } = await createAdapter('sqlite')
    expect(adapter).toBeInstanceOf(SQLiteAdapter)
    expect(adapter.dialect).toBe('sqlite')
    expect(searchPort).toBeInstanceOf(SQLiteSearchPort)
  })

  test('an engine nobody implemented is rejected up front, not at first query', async () => {
    await expect(createAdapter('postgres' as any)).rejects.toThrow(/Unsupported database engine: postgres/)
  })
})

describe('SQLiteAdapter', () => {
  const db = new SQLiteAdapter()

  beforeAll(async () => {
    await db.open(':memory:')
    await db.executeMultiple(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER)`)
  })

  test('translates $N placeholders to ? in order', async () => {
    await db.execute(`INSERT INTO items (id, name) VALUES ($1, $2)`, [1, 'one'])
    const rows = await db.query<{ name: string }>(`SELECT name FROM items WHERE id = $1`, [1])
    expect(rows).toEqual([{ name: 'one' }])
  })

  test('a placeholder used twice binds the same value twice', async () => {
    // listReposPaginated does `did ILIKE $1 OR handle ILIKE $1` with one param
    const rows = await db.query<{ a: string; b: string }>(`SELECT $1 AS a, $1 AS b`, ['x'])
    expect(rows).toEqual([{ a: 'x', b: 'x' }])
  })

  test('placeholders may appear out of order and still bind by number', async () => {
    const rows = await db.query<{ a: string; b: string }>(`SELECT $2 AS a, $1 AS b`, ['first', 'second'])
    expect(rows).toEqual([{ a: 'second', b: 'first' }])
  })

  test('JS booleans become 0/1 — better-sqlite3 cannot bind a boolean', async () => {
    await db.execute(`INSERT INTO items (id, name, flag) VALUES ($1, $2, $3)`, [2, 'two', true])
    const rows = await db.query<{ flag: number }>(`SELECT flag FROM items WHERE id = $1`, [2])
    expect(rows[0].flag).toBe(1)
    const f = await db.query<{ v: number }>(`SELECT $1 AS v`, [false])
    expect(f[0].v).toBe(0)
  })

  test('a statement with no params is passed through untouched', async () => {
    // A literal `$` in SQL with no params must not be rewritten
    const rows = await db.query<{ v: string }>(`SELECT '$1' AS v`)
    expect(rows[0].v).toBe('$1')
  })

  test('rollback discards writes made inside a transaction', async () => {
    await db.beginTransaction()
    await db.execute(`INSERT INTO items (id, name) VALUES ($1, $2)`, [10, 'temp'])
    await db.rollback()
    const rows = await db.query(`SELECT 1 FROM items WHERE id = $1`, [10])
    expect(rows).toEqual([])
  })

  test('commit keeps writes made inside a transaction', async () => {
    await db.beginTransaction()
    await db.execute(`INSERT INTO items (id, name) VALUES ($1, $2)`, [11, 'kept'])
    await db.commit()
    const rows = await db.query(`SELECT 1 FROM items WHERE id = $1`, [11])
    expect(rows).toHaveLength(1)
  })

  test('executeMultiple runs several semicolon-separated statements', async () => {
    await db.executeMultiple(
      `INSERT INTO items (id, name) VALUES (20, 'a'); INSERT INTO items (id, name) VALUES (21, 'b');`,
    )
    const rows = await db.query(`SELECT 1 FROM items WHERE id IN (20, 21)`)
    expect(rows).toHaveLength(2)
  })

  test('sets the pragmas the indexer depends on', async () => {
    const fk = await db.query<{ foreign_keys: number }>(`PRAGMA foreign_keys`)
    expect(fk[0].foreign_keys).toBe(1)
    // WAL is not available for an in-memory database, but the call must not throw
    const jm = await db.query<{ journal_mode: string }>(`PRAGMA journal_mode`)
    expect(jm[0].journal_mode).toMatch(/^(wal|memory)$/)
  })

  test('close is safe to call twice and before open', () => {
    const fresh = new SQLiteAdapter()
    expect(() => fresh.close()).not.toThrow()
    fresh.close()
  })
})

describe('SQLiteAdapter bulk inserter', () => {
  const db = new SQLiteAdapter()

  beforeAll(async () => {
    await db.open(':memory:')
    await db.executeMultiple(`CREATE TABLE bulk (k TEXT PRIMARY KEY, v TEXT)`)
  })

  async function count(): Promise<number> {
    const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM bulk`)
    return rows[0].n
  }

  test('buffers rows until batchSize then flushes them in one transaction', async () => {
    const ins = await db.createBulkInserter('bulk', ['k', 'v'], { batchSize: 2 })
    ins.append(['a', '1'])
    expect(await count()).toBe(0)
    ins.append(['b', '2'])
    expect(await count()).toBe(2) // hit the batch size
    ins.append(['c', '3'])
    expect(await count()).toBe(2) // still buffered
    await ins.flush()
    expect(await count()).toBe(3)
    await ins.close()
  })

  test('close flushes whatever is still buffered', async () => {
    const ins = await db.createBulkInserter('bulk', ['k', 'v'])
    ins.append(['d', '4'])
    await ins.close()
    expect(await count()).toBe(4)
  })

  test('flushing an empty buffer is a no-op', async () => {
    const ins = await db.createBulkInserter('bulk', ['k', 'v'])
    await expect(ins.flush()).resolves.toBeUndefined()
    await ins.close()
  })

  test('onConflict ignore keeps the existing row', async () => {
    const ins = await db.createBulkInserter('bulk', ['k', 'v'], { onConflict: 'ignore' })
    ins.append(['a', 'changed'])
    await ins.close()
    const rows = await db.query<{ v: string }>(`SELECT v FROM bulk WHERE k = 'a'`)
    expect(rows[0].v).toBe('1')
  })

  test('onConflict replace overwrites the existing row', async () => {
    const ins = await db.createBulkInserter('bulk', ['k', 'v'], { onConflict: 'replace' })
    ins.append(['a', 'changed'])
    await ins.close()
    const rows = await db.query<{ v: string }>(`SELECT v FROM bulk WHERE k = 'a'`)
    expect(rows[0].v).toBe('changed')
  })

  test('without onConflict a duplicate key fails the whole batch and leaves the buffer intact', async () => {
    // The default is a plain INSERT: bulkInsertRecords stages into a fresh
    // table precisely so this cannot fire on the target table.
    const ins = await db.createBulkInserter('bulk', ['k', 'v'])
    ins.append(['zz', 'new'])
    ins.append(['a', 'dup'])
    await expect(ins.flush()).rejects.toThrow(/UNIQUE/)
    const rows = await db.query(`SELECT 1 FROM bulk WHERE k = 'zz'`)
    expect(rows).toEqual([]) // transaction rolled back both rows
  })
})

describe('SQLiteSearchPort', () => {
  test('search treats a query that is nothing but punctuation as empty', async () => {
    // FTS5 would raise a syntax error on "..." — the port strips the
    // operators and returns nothing instead of throwing.
    const db = new SQLiteAdapter()
    await db.open(':memory:')
    const sp = new SQLiteSearchPort(db)
    expect(await sp.search('_fts_none', '... *** ()', [], 10, 0)).toEqual([])
  })

  test('indexExists requires both the shadow table and its FTS virtual table', async () => {
    const db = new SQLiteAdapter()
    await db.open(':memory:')
    const sp = new SQLiteSearchPort(db)
    expect(await sp.indexExists('_fts_x')).toBe(false)
    await db.executeMultiple(`CREATE TABLE _fts_x (uri TEXT, body TEXT)`)
    expect(await sp.indexExists('_fts_x')).toBe(false) // half-built
    await db.executeMultiple(`CREATE VIRTUAL TABLE _fts_x_fts USING fts5(uri UNINDEXED, body, content=_fts_x)`)
    expect(await sp.indexExists('_fts_x')).toBe(true)
  })

  test('deleteFromIndex on a URI that was never indexed is a no-op', async () => {
    const db = new SQLiteAdapter()
    await db.open(':memory:')
    const sp = new SQLiteSearchPort(db)
    await sp.buildIndex('_fts_y', `SELECT 'at://x' AS uri, 'hello' AS body`, ['body'])
    await expect(sp.deleteFromIndex('_fts_y', 'at://never', ['body'])).resolves.toBeUndefined()
    expect(await sp.search('_fts_y', 'hello', ['body'], 10, 0)).toEqual([expect.objectContaining({ uri: 'at://x' })])
  })
})
