# SQLite Incremental FTS Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace SQLite's drop-and-rebuild FTS strategy with incremental FTS5 external content tables that stay in sync via application-level updates on insert/delete.

**Architecture:** Add `updateIndex()` and `deleteFromIndex()` methods to `SearchPort`. The SQLite implementation uses FTS5 external content mode (`content=shadowTable`) so the FTS index references the shadow data table directly. On `insertRecord()` and `deleteRecord()`, the framework incrementally updates both the shadow table and FTS index. The periodic `rebuildAllIndexes` in the indexer is skipped for SQLite. DuckDB keeps its existing drop-and-rebuild behavior unchanged.

**Tech Stack:** SQLite FTS5 with external content tables, TypeScript

---

### Task 1: Extend SearchPort Interface

**Files:**
- Modify: `packages/hatk/src/database/ports.ts:50-62`

**Step 1: Add new methods to SearchPort**

Add `updateIndex` and `deleteFromIndex` to the `SearchPort` interface:

```typescript
export interface SearchPort {
  /** Build/rebuild an FTS index for a table */
  buildIndex(shadowTable: string, sourceQuery: string, searchColumns: string[]): Promise<void>

  /** Incrementally update a single record in the FTS index */
  updateIndex?(shadowTable: string, uri: string, row: Record<string, string | null>, searchColumns: string[]): Promise<void>

  /** Remove a single record from the FTS index */
  deleteFromIndex?(shadowTable: string, uri: string): Promise<void>

  /** Check if the FTS index already exists (for skipping rebuild on startup) */
  indexExists?(shadowTable: string): Promise<boolean>

  /** Search a table, returning URIs with scores */
  search(
    shadowTable: string,
    query: string,
    searchColumns: string[],
    limit: number,
    offset: number,
  ): Promise<Array<{ uri: string; score: number }>>
}
```

Note: Methods are optional (`?`) so DuckDB's SearchPort doesn't need to implement them.

**Step 2: Commit**

```bash
git add packages/hatk/src/database/ports.ts
git commit -m "feat: add incremental FTS methods to SearchPort interface"
```

---

### Task 2: Rewrite SQLiteSearchPort for External Content FTS5

**Files:**
- Modify: `packages/hatk/src/database/adapters/sqlite-search.ts`

**Step 1: Rewrite the SQLiteSearchPort class**

Replace the entire file with:

```typescript
import type { SearchPort } from '../ports.ts'
import type { DatabasePort } from '../ports.ts'

/**
 * SQLite FTS5-based search port with incremental updates.
 *
 * Uses external content FTS5 tables (`content=shadowTable`) so the FTS index
 * references the shadow data table. Updates happen incrementally per-record
 * instead of dropping and rebuilding the entire index.
 */
export class SQLiteSearchPort implements SearchPort {
  constructor(private port: DatabasePort) {}

  async indexExists(shadowTable: string): Promise<boolean> {
    const rows = await this.port.query(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=$1`,
      [shadowTable],
    )
    return rows.length > 0
  }

  async buildIndex(shadowTable: string, sourceQuery: string, searchColumns: string[]): Promise<void> {
    // Drop existing FTS table and data table
    await this.port.execute(`DROP TABLE IF EXISTS ${shadowTable}_fts`, [])
    await this.port.execute(`DROP TABLE IF EXISTS ${shadowTable}`, [])

    // Create the shadow data table from the source query
    await this.port.execute(`CREATE TABLE ${shadowTable} AS ${sourceQuery}`, [])

    // Add a unique index on uri for fast lookups during incremental updates
    await this.port.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${shadowTable}_uri ON ${shadowTable}(uri)`, [])

    // Create the FTS5 virtual table with external content pointing to shadow table
    const colList = searchColumns.join(', ')
    await this.port.execute(
      `CREATE VIRTUAL TABLE ${shadowTable}_fts USING fts5(uri UNINDEXED, ${colList}, content=${shadowTable}, content_rowid=rowid, tokenize='porter unicode61 remove_diacritics 2')`,
      [],
    )

    // Populate FTS table from the shadow data table
    const selectCols = ['uri', ...searchColumns].map((c) => `COALESCE(CAST(${c} AS TEXT), '')`)
    await this.port.execute(
      `INSERT INTO ${shadowTable}_fts (uri, ${colList}) SELECT ${selectCols.join(', ')} FROM ${shadowTable}`,
      [],
    )
  }

  async updateIndex(
    shadowTable: string,
    uri: string,
    row: Record<string, string | null>,
    searchColumns: string[],
  ): Promise<void> {
    // Get existing rowid if this record is already indexed (for FTS delete)
    const existing = await this.port.query(
      `SELECT rowid FROM ${shadowTable} WHERE uri = $1`,
      [uri],
    )

    if (existing.length > 0) {
      const oldRowid = (existing[0] as any).rowid
      // Read old values for FTS delete command
      const colList = searchColumns.join(', ')
      const oldRows = await this.port.query(
        `SELECT uri, ${colList} FROM ${shadowTable} WHERE rowid = $1`,
        [oldRowid],
      )
      if (oldRows.length > 0) {
        const old = oldRows[0] as any
        const oldVals = ['uri', ...searchColumns].map((c) => `COALESCE(CAST(${JSON.stringify(old[c] ?? '')} AS TEXT), '')`)
        // Delete old entry from FTS using special 'delete' command
        await this.port.execute(
          `INSERT INTO ${shadowTable}_fts(${shadowTable}_fts, rowid, uri, ${colList}) VALUES('delete', $1, ${oldVals.join(', ')})`,
          [oldRowid],
        )
      }

      // Update shadow table row
      const setClauses = searchColumns.map((c, i) => `${c} = $${i + 2}`)
      const values = [uri, ...searchColumns.map((c) => row[c] ?? null)]
      await this.port.execute(
        `UPDATE ${shadowTable} SET ${setClauses.join(', ')} WHERE uri = $1`,
        values,
      )

      // Re-read rowid (same after UPDATE) and insert new FTS entry
      const newVals = searchColumns.map((c) => `COALESCE(CAST($${searchColumns.indexOf(c) + 2} AS TEXT), '')`)
      await this.port.execute(
        `INSERT INTO ${shadowTable}_fts(rowid, uri, ${colList}) VALUES($1, $2, ${newVals.join(', ')})`,
        [oldRowid, uri, ...searchColumns.map((c) => row[c] ?? '')],
      )
    } else {
      // Insert new row into shadow table
      const colList = searchColumns.join(', ')
      const placeholders = searchColumns.map((_, i) => `$${i + 2}`)
      const values = [uri, ...searchColumns.map((c) => row[c] ?? null)]
      await this.port.execute(
        `INSERT INTO ${shadowTable} (uri, ${colList}) VALUES ($1, ${placeholders.join(', ')})`,
        values,
      )

      // Get the new rowid and insert into FTS
      const newRow = await this.port.query(`SELECT rowid FROM ${shadowTable} WHERE uri = $1`, [uri])
      const newRowid = (newRow[0] as any).rowid
      await this.port.execute(
        `INSERT INTO ${shadowTable}_fts(rowid, uri, ${colList}) VALUES($1, $2, ${placeholders.join(', ')})`,
        [newRowid, uri, ...searchColumns.map((c) => row[c] ?? '')],
      )
    }
  }

  async deleteFromIndex(shadowTable: string, uri: string): Promise<void> {
    // We need the rowid and old column values for the FTS delete command
    const rows = await this.port.query(
      `SELECT rowid, * FROM ${shadowTable} WHERE uri = $1`,
      [uri],
    )
    if (rows.length === 0) return

    const old = rows[0] as any
    const rowid = old.rowid

    // Delete from FTS — requires passing old values for token removal
    // Get column names from the shadow table (excluding uri, cid, did, indexed_at, handle metadata cols)
    await this.port.execute(`DELETE FROM ${shadowTable} WHERE uri = $1`, [uri])

    // Note: with content= table, deleting from the content table is sufficient
    // if we also run the FTS delete command. But since we use content=shadowTable,
    // and we just deleted from shadowTable, we need to tell FTS explicitly.
    // Actually with external content, we must manually sync.
    // The simplest approach: delete from shadow table, then rebuild FTS for this row.
    // But we already deleted... so we use the 'delete' command with old values.
  }

  async search(
    shadowTable: string,
    query: string,
    _searchColumns: string[],
    limit: number,
    offset: number,
  ): Promise<Array<{ uri: string; score: number }>> {
    const escaped = query.replace(/['"*(){}[\]^~\\:]/g, ' ').trim()
    if (!escaped) return []

    const sql = `SELECT uri, -bm25(${shadowTable}_fts) AS score
      FROM ${shadowTable}_fts
      WHERE ${shadowTable}_fts MATCH $1
      ORDER BY score DESC
      LIMIT $2 OFFSET $3`
    return this.port.query(sql, [escaped, limit, offset])
  }
}
```

**Wait** — the `updateIndex` and `deleteFromIndex` above are too complex with manual FTS delete commands and rowid tracking. Let me simplify.

**Step 1 (revised): Simpler approach using DELETE + INSERT on shadow table with FTS rebuild-row**

Actually, the cleanest approach for external content FTS5: since we use `content=shadowTable`, we can:
1. Upsert the shadow table row
2. Run `INSERT INTO fts(fts) VALUES('rebuild')` only for the changed row — but FTS5 doesn't support single-row rebuild.

The correct pattern for external content tables:
1. To **delete**: `INSERT INTO fts(fts, rowid, col1, ...) VALUES('delete', old_rowid, old_col1, ...)`
2. To **insert**: `INSERT INTO fts(rowid, col1, ...) VALUES(new_rowid, new_col1, ...)`
3. To **update**: delete old + insert new

This is fiddly. A simpler alternative: **don't use external content mode**. Instead, use a **regular FTS5 table** (no content= param) and keep it in sync manually. This way:
- INSERT: just `INSERT INTO fts(uri, cols) VALUES(...)`
- DELETE: `DELETE FROM fts WHERE uri = ...` — wait, FTS5 doesn't support DELETE by column, only by rowid.

OK, the simplest correct approach:

**Use the shadow data table as a lookup for old values, and do explicit FTS delete+insert.**

Let me write the final clean version:

```typescript
import type { SearchPort } from '../ports.ts'
import type { DatabasePort } from '../ports.ts'

export class SQLiteSearchPort implements SearchPort {
  constructor(private port: DatabasePort) {}

  async indexExists(shadowTable: string): Promise<boolean> {
    const rows = await this.port.query(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=$1`,
      [shadowTable],
    )
    return rows.length > 0
  }

  async buildIndex(shadowTable: string, sourceQuery: string, searchColumns: string[]): Promise<void> {
    await this.port.execute(`DROP TABLE IF EXISTS ${shadowTable}_fts`, [])
    await this.port.execute(`DROP TABLE IF EXISTS ${shadowTable}`, [])

    await this.port.execute(`CREATE TABLE ${shadowTable} AS ${sourceQuery}`, [])
    await this.port.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${shadowTable}_uri ON ${shadowTable}(uri)`, [])

    const colList = searchColumns.join(', ')
    await this.port.execute(
      `CREATE VIRTUAL TABLE ${shadowTable}_fts USING fts5(uri UNINDEXED, ${colList}, content=${shadowTable}, content_rowid=rowid, tokenize='porter unicode61 remove_diacritics 2')`,
      [],
    )

    const selectCols = ['uri', ...searchColumns].map((c) => `COALESCE(CAST(${c} AS TEXT), '')`)
    await this.port.execute(
      `INSERT INTO ${shadowTable}_fts (uri, ${colList}) SELECT ${selectCols.join(', ')} FROM ${shadowTable}`,
      [],
    )
  }

  async updateIndex(
    shadowTable: string,
    uri: string,
    row: Record<string, string | null>,
    searchColumns: string[],
  ): Promise<void> {
    const colList = searchColumns.join(', ')

    // Remove old entry from FTS if it exists
    await this._deleteFromFts(shadowTable, uri, searchColumns)

    // Upsert shadow table
    const placeholders = searchColumns.map((_, i) => `$${i + 2}`)
    const values = [uri, ...searchColumns.map((c) => row[c] ?? null)]
    await this.port.execute(
      `INSERT OR REPLACE INTO ${shadowTable} (uri, ${colList}) VALUES ($1, ${placeholders.join(', ')})`,
      values,
    )

    // Insert new FTS entry — read back rowid from shadow table
    const rows = await this.port.query(`SELECT rowid FROM ${shadowTable} WHERE uri = $1`, [uri])
    if (rows.length > 0) {
      const rowid = (rows[0] as any).rowid
      const ftsVals = searchColumns.map((c) => row[c] ?? '')
      const ftsPlaceholders = searchColumns.map((_, i) => `$${i + 3}`)
      await this.port.execute(
        `INSERT INTO ${shadowTable}_fts(rowid, uri, ${colList}) VALUES($1, $2, ${ftsPlaceholders.join(', ')})`,
        [rowid, uri, ...ftsVals],
      )
    }
  }

  async deleteFromIndex(shadowTable: string, uri: string): Promise<void> {
    const cols = await this._getShadowColumns(shadowTable)
    await this._deleteFromFts(shadowTable, uri, cols)
    await this.port.execute(`DELETE FROM ${shadowTable} WHERE uri = $1`, [uri])
  }

  private async _deleteFromFts(shadowTable: string, uri: string, searchColumns: string[]): Promise<void> {
    const colList = searchColumns.join(', ')
    const rows = await this.port.query(
      `SELECT rowid, uri, ${colList} FROM ${shadowTable} WHERE uri = $1`,
      [uri],
    )
    if (rows.length === 0) return

    const old = rows[0] as any
    const oldVals = searchColumns.map((c) => old[c] ?? '')
    const placeholders = searchColumns.map((_, i) => `$${i + 3}`)
    await this.port.execute(
      `INSERT INTO ${shadowTable}_fts(${shadowTable}_fts, rowid, uri, ${colList}) VALUES('delete', $1, $2, ${placeholders.join(', ')})`,
      [old.rowid, uri, ...oldVals],
    )
  }

  private async _getShadowColumns(shadowTable: string): Promise<string[]> {
    const info = await this.port.query(`PRAGMA table_info("${shadowTable}")`, [])
    return (info as any[])
      .map((r) => r.name)
      .filter((n: string) => !['uri', 'cid', 'did', 'indexed_at', 'handle', 'rowid'].includes(n))
  }

  async search(
    shadowTable: string,
    query: string,
    _searchColumns: string[],
    limit: number,
    offset: number,
  ): Promise<Array<{ uri: string; score: number }>> {
    const escaped = query.replace(/['"*(){}[\]^~\\:]/g, ' ').trim()
    if (!escaped) return []

    const sql = `SELECT uri, -bm25(${shadowTable}_fts) AS score
      FROM ${shadowTable}_fts
      WHERE ${shadowTable}_fts MATCH $1
      ORDER BY score DESC
      LIMIT $2 OFFSET $3`
    return this.port.query(sql, [escaped, limit, offset])
  }
}
```

**Step 2: Commit**

```bash
git add packages/hatk/src/database/adapters/sqlite-search.ts
git commit -m "feat: rewrite SQLiteSearchPort for incremental FTS5 with external content"
```

---

### Task 3: Add FTS Row Builder to fts.ts

**Files:**
- Modify: `packages/hatk/src/database/fts.ts`

The existing `buildFtsIndex()` constructs a SQL query to denormalize a record's searchable text. We need a similar function that builds the denormalized row for a **single record** (by URI) so `updateIndex` can be called with the right data.

**Step 1: Add `buildFtsRow()` function**

Add after the `buildFtsIndex` function (after line 192):

```typescript
/**
 * Build a denormalized FTS row for a single record.
 * Returns the search column values keyed by column name, or null if the record doesn't exist.
 */
export async function buildFtsRow(
  collection: string,
  uri: string,
): Promise<Record<string, string | null> | null> {
  const schema = getSchema(collection)
  if (!schema) return null

  const lexicon = getLexicon(collection)
  const record = lexicon?.defs?.main?.record
  const dialect = getSqlDialect()

  const selectExprs: string[] = []
  const colNames: string[] = []

  for (const col of schema.columns) {
    if (col.sqlType === 'TEXT') {
      selectExprs.push(`t.${col.name}`)
      colNames.push(col.name)
    } else if ((col.sqlType === 'JSON' || col.sqlType === 'TEXT') && record?.properties) {
      const prop = record.properties[col.originalName]
      if (prop?.type === 'blob') continue
      if (prop && lexicon) {
        const derived = jsonSearchColumns(`t.${col.name}`, prop, lexicon, dialect)
        if (derived.length > 0) {
          for (const d of derived) {
            selectExprs.push(`${d.expr} AS ${d.alias}`)
            colNames.push(d.alias)
          }
          continue
        }
      }
      selectExprs.push(`CAST(t.${col.name} AS TEXT) AS ${col.name}`)
      colNames.push(col.name)
    }
  }

  for (const child of schema.children) {
    for (const col of child.columns) {
      if (col.sqlType === 'TEXT') {
        const alias = `${child.fieldName}_${col.name}`
        const agg = dialect.stringAgg(`c.${col.name}`, "' '")
        selectExprs.push(`(SELECT ${agg} FROM ${child.tableName} c WHERE c.parent_uri = t.uri) AS ${alias}`)
        colNames.push(alias)
      }
    }
  }

  for (const union of schema.unions) {
    for (const branch of union.branches) {
      for (const col of branch.columns) {
        if (col.sqlType === 'TEXT') {
          const alias = `${union.fieldName}_${branch.branchName}_${col.name}`
          const agg = dialect.stringAgg(`c.${col.name}`, "' '")
          selectExprs.push(`(SELECT ${agg} FROM ${branch.tableName} c WHERE c.parent_uri = t.uri) AS ${alias}`)
          colNames.push(alias)
        }
      }
    }
  }

  selectExprs.push('r.handle')
  colNames.push('handle')

  if (colNames.length === 0) return null

  const sql = `SELECT ${selectExprs.join(', ')} FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did WHERE t.uri = $1`
  const rows = await runSQL(sql, [uri])
  if (!rows || rows.length === 0) return null

  const row = rows[0] as Record<string, any>
  const result: Record<string, string | null> = {}
  for (const col of colNames) {
    result[col] = row[col] != null ? String(row[col]) : null
  }
  return result
}
```

Also export `runSQL` helper if not already exported — check `db.ts` for the `all()` function. Actually, `runSQL` is already exported from `db.ts`. We import it at top of `fts.ts` already: `import { getSchema, runSQL, getSqlDialect } from './db.ts'`. Good.

But wait — `runSQL` uses the `all()` helper internally? Let me verify. Looking at the imports, `fts.ts` already imports `runSQL` from `db.ts`. We need to confirm `runSQL` returns rows. Looking at `db.ts`, there's `run()` (execute) and `all()` (query). The import says `runSQL` — let me check if that exists.

Actually from the fts.ts imports: `import { getSchema, runSQL, getSqlDialect } from './db.ts'`. And in db.ts there should be an exported `runSQL`. If it doesn't exist as a query function, use the exported `query` or add a wrapper. The implementation should use whatever query function is available from db.ts.

**Step 2: Commit**

```bash
git add packages/hatk/src/database/fts.ts
git commit -m "feat: add buildFtsRow() for single-record FTS denormalization"
```

---

### Task 4: Add updateFtsRecord() and deleteFtsRecord() to fts.ts

**Files:**
- Modify: `packages/hatk/src/database/fts.ts`

**Step 1: Add incremental update/delete functions**

Add after `buildFtsRow()`:

```typescript
/**
 * Incrementally update the FTS index for a single record.
 * Only works when the search port supports incremental updates (SQLite).
 * Falls back to no-op for ports without updateIndex (DuckDB).
 */
export async function updateFtsRecord(collection: string, uri: string): Promise<void> {
  if (!searchPort || !searchPort.updateIndex) return

  const searchCols = searchColumnCache.get(collection)
  if (!searchCols || searchCols.length === 0) return

  const row = await buildFtsRow(collection, uri)
  if (!row) return

  const safeName = ftsTableName(collection)
  await searchPort.updateIndex(safeName, uri, row, searchCols)
}

/**
 * Incrementally remove a record from the FTS index.
 * Only works when the search port supports incremental deletes (SQLite).
 */
export async function deleteFtsRecord(collection: string, uri: string): Promise<void> {
  if (!searchPort || !searchPort.deleteFromIndex) return

  const safeName = ftsTableName(collection)
  await searchPort.deleteFromIndex(safeName, uri)
}
```

**Step 2: Commit**

```bash
git add packages/hatk/src/database/fts.ts
git commit -m "feat: add updateFtsRecord/deleteFtsRecord for incremental FTS"
```

---

### Task 5: Hook Incremental FTS into insertRecord/deleteRecord

**Files:**
- Modify: `packages/hatk/src/database/db.ts:530-657`

**Step 1: Add import**

At the top of `db.ts`, update the import from `fts.ts`:

```typescript
import { getSearchColumns, stripStopWords, getSearchPort, updateFtsRecord, deleteFtsRecord } from './fts.ts'
```

**Step 2: Call updateFtsRecord at the end of insertRecord()**

Add at the end of `insertRecord()` (after the union branch inserts, before the closing `}`):

```typescript
  // Incrementally update FTS index for this record
  await updateFtsRecord(collection, uri)
```

**Step 3: Call deleteFtsRecord at the start of deleteRecord()**

Add at the beginning of `deleteRecord()`, before deleting child/union rows:

```typescript
  // Remove from FTS index before deleting the record data
  await deleteFtsRecord(collection, uri)
```

**Step 4: Commit**

```bash
git add packages/hatk/src/database/db.ts
git commit -m "feat: hook incremental FTS updates into insertRecord/deleteRecord"
```

---

### Task 6: Skip Periodic Rebuild for SQLite in Indexer

**Files:**
- Modify: `packages/hatk/src/indexer.ts:33-34,117-121`

**Step 1: Make periodic rebuild conditional on dialect**

Import the database port to check dialect:

```typescript
import { getDatabasePort } from './database/db.ts'
```

Replace the rebuild check in `flushBuffer()` (lines 117-121):

```typescript
  writesSinceRebuild += batch.length
  if (writesSinceRebuild >= ftsRebuildInterval) {
    writesSinceRebuild = 0
    // Skip periodic full rebuild for SQLite — it uses incremental FTS updates
    const port = getDatabasePort()
    if (port.dialect !== 'sqlite') {
      rebuildAllIndexes([...indexerCollections]).catch(() => {})
    }
  }
```

**Step 2: Commit**

```bash
git add packages/hatk/src/indexer.ts
git commit -m "feat: skip periodic FTS rebuild for SQLite (now incremental)"
```

---

### Task 7: Skip Startup Rebuild When FTS Tables Already Exist

**Files:**
- Modify: `packages/hatk/src/database/fts.ts:114-192`

**Step 1: Add early return to buildFtsIndex when tables exist (SQLite only)**

At the top of `buildFtsIndex()`, after the `if (!searchPort) return` check:

```typescript
  // For SQLite: skip rebuild if FTS tables already exist (incremental mode keeps them in sync)
  if (searchPort.indexExists) {
    const safeName = ftsTableName(collection)
    const exists = await searchPort.indexExists(safeName)
    if (exists) {
      // Still populate the search column cache so incremental updates work
      // ... (need to compute searchColNames without rebuilding)
    }
  }
```

Actually, we need the `searchColumnCache` populated even when skipping rebuild. Refactor `buildFtsIndex` to separate column computation from index creation:

```typescript
export async function buildFtsIndex(collection: string): Promise<void> {
  if (!searchPort) return

  const { searchColNames, sourceQuery, safeName } = computeFtsSchema(collection)
  if (searchColNames.length === 0) return

  // For incremental ports: skip rebuild if index already exists
  if (searchPort.indexExists) {
    const exists = await searchPort.indexExists(safeName)
    if (exists) {
      searchColumnCache.set(collection, searchColNames)
      lastRebuiltAt.set(collection, new Date().toISOString())
      return
    }
  }

  await searchPort.buildIndex(safeName, sourceQuery, searchColNames)
  searchColumnCache.set(collection, searchColNames)
  lastRebuiltAt.set(collection, new Date().toISOString())
}
```

Extract the column computation into a helper:

```typescript
function computeFtsSchema(collection: string): {
  searchColNames: string[]
  sourceQuery: string
  safeName: string
} {
  const schema = getSchema(collection)
  if (!schema) throw new Error(`Unknown collection: ${collection}`)

  const lexicon = getLexicon(collection)
  const record = lexicon?.defs?.main?.record
  const dialect = getSqlDialect()
  const selectExprs: string[] = ['t.uri', 't.cid', 't.did', 't.indexed_at']
  const searchColNames: string[] = []

  // ... (move existing column computation logic from buildFtsIndex here, lines 128-179)

  const safeName = ftsTableName(collection)
  const sourceQuery = `SELECT ${selectExprs.join(', ')} FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did`

  return { searchColNames, sourceQuery, safeName }
}
```

**Step 2: Commit**

```bash
git add packages/hatk/src/database/fts.ts
git commit -m "feat: skip FTS rebuild on startup when SQLite index already exists"
```

---

### Task 8: Make Backfill Completion Rebuild Conditional

**Files:**
- Modify: `packages/hatk/src/main.ts:168-176`

**Step 1: Skip post-backfill rebuild for SQLite**

```typescript
function runBackfillAndRestart() {
  runBackfill(backfillOpts)
    .then(async (recordCount) => {
      // SQLite uses incremental FTS — only rebuild for other engines
      const port = getDatabasePort()
      if (port.dialect !== 'sqlite') {
        log('[main] Backfill complete, rebuilding FTS indexes...')
        await rebuildAllIndexes(collections)
        log('[main] FTS indexes ready')
      } else {
        log('[main] Backfill complete (FTS updated incrementally)')
      }
      return recordCount
    })
```

Add the import at the top of main.ts:

```typescript
import { getDatabasePort } from './database/db.ts'
```

**Step 2: Commit**

```bash
git add packages/hatk/src/main.ts
git commit -m "feat: skip post-backfill FTS rebuild for SQLite"
```

---

### Task 9: Handle Shadow Table Schema for INSERT OR REPLACE

**Files:**
- Modify: `packages/hatk/src/database/adapters/sqlite-search.ts`

The shadow table created by `buildIndex` uses `CREATE TABLE AS SELECT`, which doesn't create a PRIMARY KEY or UNIQUE constraint on `uri`. The `INSERT OR REPLACE` in `updateIndex` needs a unique constraint to work.

**Step 1: Verify buildIndex creates the unique index**

Already handled in Task 2 — the `buildIndex` method includes:
```typescript
await this.port.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${shadowTable}_uri ON ${shadowTable}(uri)`, [])
```

But `INSERT OR REPLACE` requires a UNIQUE constraint on the table itself, not just an index. Fix by using `INSERT ... ON CONFLICT(uri) DO UPDATE` instead:

In `updateIndex`, replace the shadow table upsert:

```typescript
    // Upsert shadow table
    const setClauses = searchColumns.map((c, i) => `${c} = $${i + 2}`)
    await this.port.execute(
      `INSERT INTO ${shadowTable} (uri, ${colList}) VALUES ($1, ${placeholders.join(', ')})
       ON CONFLICT(uri) DO UPDATE SET ${setClauses.join(', ')}`,
      values,
    )
```

This works with the UNIQUE INDEX on uri.

**Step 2: Commit**

```bash
git add packages/hatk/src/database/adapters/sqlite-search.ts
git commit -m "fix: use ON CONFLICT for shadow table upsert"
```

---

### Task 10: Test Manually

**Step 1: Build hatk**

```bash
cd packages/hatk && npm run build
```

**Step 2: Run the teal template app locally**

```bash
cd /Users/chadmiller/code/hatk-template-teal
npm install
# Start local dev environment and verify:
# - FTS tables are created on first startup
# - Records are searchable immediately after insertion (no waiting for rebuild interval)
# - Restarting the app does NOT rebuild FTS tables
# - Search results are correct
```

**Step 3: Commit any fixes**

```bash
git commit -m "fix: address issues found during manual testing"
```
