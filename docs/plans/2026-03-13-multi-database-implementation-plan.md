# Multi-Database Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor hatk's data layer into a hexagonal architecture supporting DuckDB and SQLite (and future PostgreSQL) via a `DatabasePort` interface.

**Architecture:** Extract a low-level `DatabasePort` interface for SQL execution, transactions, and bulk inserts. Keep all business logic (record ops, queries, repo tracking) in a shared `database/db.ts`. Each engine gets a thin adapter. FTS uses an optional `SearchPort` with `LIKE` fallback.

**Tech Stack:** TypeScript, DuckDB (`@duckdb/node-api`), SQLite (`better-sqlite3`), Node.js 25+

---

## Overview of Current State

**`src/db.ts` (1556 lines)** — monolithic data access layer tightly coupled to DuckDB. Module-level state: `instance`, `con` (write connection), `readCon` (read connection). Uses `writeQueue`/`readQueue` promise chains for serialization. Exports ~45 functions consumed by 13 other files.

**`src/schema.ts` (468 lines)** — generates `TableSchema` objects and DuckDB-specific DDL from AT Protocol lexicons. Uses `duckdbType` field name throughout. Consumed by `db.ts`, `fts.ts`, `main.ts`, `cli.ts`, `test.ts`, `views.ts`, `xrpc.ts`, `indexer.ts`, `server.ts`, `seed.ts`.

**`src/fts.ts` (801 lines)** — builds DuckDB FTS shadow tables using `PRAGMA create_fts_index`. Consumed by `db.ts`, `indexer.ts`, `main.ts`.

**`src/oauth/db.ts` (244 lines)** — OAuth DDL and CRUD. Uses `querySQL`/`runSQL` from `db.ts`. Already uses `$1`-style params and portable SQL.

**`src/config.ts`** — `HatkConfig.database` is currently the file path string. Need a new `databaseEngine` field.

### Files that import from db.ts (all need path updates)

- `server.ts`, `indexer.ts`, `main.ts`, `cli.ts` (not in list but uses schema.ts)
- `backfill.ts`, `feeds.ts`, `xrpc.ts`, `opengraph.ts`
- `hydrate.ts`, `labels.ts`, `hooks.ts`, `setup.ts`, `test.ts`, `seed.ts`
- `fts.ts`, `oauth/db.ts`, `oauth/server.ts`

### Files that import from schema.ts

- `db.ts`, `fts.ts`, `main.ts`, `cli.ts`, `test.ts`
- `views.ts`, `xrpc.ts`, `indexer.ts`, `server.ts`, `seed.ts`

### Files that import from fts.ts

- `db.ts`, `indexer.ts`, `main.ts`

---

## Task 1: Create `src/database/ports.ts` — Port Interfaces

**Files:**
- Create: `packages/hatk/src/database/ports.ts`

**Step 1: Write the port interfaces file**

```typescript
// packages/hatk/src/database/ports.ts

export type Dialect = 'duckdb' | 'sqlite' | 'postgres'

export interface DatabasePort {
  /** Dialect identifier for SQL generation differences */
  dialect: Dialect

  /** Open a database connection. path is file path or ':memory:' */
  open(path: string): Promise<void>

  /** Close all connections and release resources */
  close(): void

  /** Execute a read query, return rows as plain objects */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>

  /** Execute a write statement (INSERT, UPDATE, DELETE, DDL) */
  execute(sql: string, params?: unknown[]): Promise<void>

  /** Execute multiple statements in sequence (for DDL batches) */
  executeMultiple(sql: string): Promise<void>

  /** Begin a transaction */
  beginTransaction(): Promise<void>

  /** Commit the current transaction */
  commit(): Promise<void>

  /** Rollback the current transaction */
  rollback(): Promise<void>

  /** Create a bulk inserter for high-throughput writes */
  createBulkInserter(table: string, columns: string[]): Promise<BulkInserter>
}

export interface BulkInserter {
  /** Append a single row of values */
  append(values: unknown[]): void

  /** Flush buffered rows to the database */
  flush(): Promise<void>

  /** Close the inserter and release resources */
  close(): Promise<void>
}

export interface SearchPort {
  /** Build/rebuild an FTS index for a table */
  buildIndex(
    shadowTable: string,
    sourceQuery: string,
    searchColumns: string[],
  ): Promise<void>

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

**Step 2: Verify the file compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit packages/hatk/src/database/ports.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/hatk/src/database/ports.ts
git commit -m "feat: add DatabasePort, BulkInserter, and SearchPort interfaces"
```

---

## Task 2: Create `src/database/dialect.ts` — SQL Dialect Configs

**Files:**
- Create: `packages/hatk/src/database/dialect.ts`

**Context:** This replaces the hardcoded DuckDB types in `schema.ts:54-74` (`mapType` function). The `duckdbType` field on `ColumnDef` will be renamed to `sqlType` in a later task.

**Step 1: Write the dialect configuration file**

```typescript
// packages/hatk/src/database/dialect.ts

import type { Dialect } from './ports.ts'

export interface SqlDialect {
  /** Map from lexicon type key to SQL column type */
  typeMap: Record<string, string>

  /** Timestamp type name */
  timestampType: string

  /** JSON type name */
  jsonType: string

  /** Parameter placeholder for index (1-based). DuckDB/Postgres: $1  SQLite: ? */
  param(index: number): string

  /** Whether the engine supports native bulk appenders (DuckDB) vs batched INSERT */
  supportsAppender: boolean

  /** SQL for upsert — 'INSERT OR REPLACE' (DuckDB/SQLite) vs 'ON CONFLICT DO UPDATE' */
  upsertPrefix: string

  /** Extract a string value from a JSON column. Returns SQL expression. */
  jsonExtractString(column: string, path: string): string

  /** Aggregate strings from a JSON array. Returns SQL expression. */
  jsonArrayStringAgg(column: string, jsonPath: string): string

  /** Information schema query to list user tables */
  listTablesQuery: string

  /** CHECKPOINT or equivalent (for WAL compaction). null if not needed. */
  checkpointSQL: string | null

  /** Current timestamp expression */
  currentTimestamp: string
}

export const DUCKDB_DIALECT: SqlDialect = {
  typeMap: {
    text: 'TEXT',
    integer: 'INTEGER',
    bigint: 'BIGINT',
    boolean: 'BOOLEAN',
    blob: 'BLOB',
    timestamp: 'TIMESTAMP',
    timestamptz: 'TIMESTAMPTZ',
    json: 'JSON',
  },
  timestampType: 'TIMESTAMP',
  jsonType: 'JSON',
  param: (i: number) => `$${i}`,
  supportsAppender: true,
  upsertPrefix: 'INSERT OR REPLACE INTO',
  jsonExtractString: (col, path) => `json_extract_string(${col}, '${path}')`,
  jsonArrayStringAgg: (col, path) => `list_string_agg(json_extract_string(${col}, '${path}'))`,
  listTablesQuery: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name NOT LIKE '\\_%' ESCAPE '\\\\'`,
  checkpointSQL: 'CHECKPOINT',
  currentTimestamp: 'CURRENT_TIMESTAMP',
}

export const SQLITE_DIALECT: SqlDialect = {
  typeMap: {
    text: 'TEXT',
    integer: 'INTEGER',
    bigint: 'INTEGER',
    boolean: 'INTEGER',
    blob: 'BLOB',
    timestamp: 'TEXT',
    timestamptz: 'TEXT',
    json: 'TEXT',
  },
  timestampType: 'TEXT',
  jsonType: 'TEXT',
  param: (_i: number) => '?',
  supportsAppender: false,
  upsertPrefix: 'INSERT OR REPLACE INTO',
  jsonExtractString: (col, path) => `json_extract(${col}, '${path}')`,
  jsonArrayStringAgg: (col, path) => {
    // SQLite doesn't have list_string_agg — use json_each + group_concat
    return `(SELECT group_concat(je.value, ' ') FROM json_each(${col}, '${path}') je)`
  },
  listTablesQuery: `SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\\\'`,
  checkpointSQL: null,
  currentTimestamp: "datetime('now')",
}

export function getDialect(dialect: Dialect): SqlDialect {
  switch (dialect) {
    case 'duckdb': return DUCKDB_DIALECT
    case 'sqlite': return SQLITE_DIALECT
    case 'postgres': throw new Error('PostgreSQL adapter not yet implemented')
  }
}
```

**Step 2: Verify the file compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit packages/hatk/src/database/dialect.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/hatk/src/database/dialect.ts
git commit -m "feat: add SQL dialect configs for DuckDB and SQLite"
```

---

## Task 3: Create DuckDB Adapter — `src/database/adapters/duckdb.ts`

**Files:**
- Create: `packages/hatk/src/database/adapters/duckdb.ts`

**Context:** Extract from `src/db.ts` lines 1-100 (the DuckDB instance, connections, `bindParams`, `enqueue`). The adapter wraps `@duckdb/node-api` and implements `DatabasePort`. It keeps the read/write connection separation and queuing.

**Step 1: Write the DuckDB adapter**

```typescript
// packages/hatk/src/database/adapters/duckdb.ts

import { DuckDBInstance } from '@duckdb/node-api'
import type { DatabasePort, BulkInserter } from '../ports.ts'
import type { Dialect } from '../ports.ts'

export class DuckDBAdapter implements DatabasePort {
  dialect: Dialect = 'duckdb'

  private instance!: DuckDBInstance
  private writeCon!: Awaited<ReturnType<DuckDBInstance['connect']>>
  private readCon!: Awaited<ReturnType<DuckDBInstance['connect']>>
  private writeQueue = Promise.resolve()
  private readQueue = Promise.resolve()

  async open(path: string): Promise<void> {
    this.instance = await DuckDBInstance.create(path)
    this.writeCon = await this.instance.connect()
    this.readCon = await this.instance.connect()
  }

  close(): void {
    try { this.readCon?.closeSync() } catch {}
    try { this.writeCon?.closeSync() } catch {}
    try { this.instance?.closeSync() } catch {}
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.enqueue('read', async () => {
      if (params.length === 0) {
        const reader = await this.readCon.runAndReadAll(sql)
        return this.rowsToObjects(reader) as T[]
      }
      const prepared = await this.readCon.prepare(sql)
      this.bindParams(prepared, params)
      const reader = await prepared.runAndReadAll()
      return this.rowsToObjects(reader) as T[]
    })
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    return this.enqueue('write', async () => {
      if (params.length === 0) {
        await this.writeCon.run(sql)
        return
      }
      const prepared = await this.writeCon.prepare(sql)
      this.bindParams(prepared, params)
      await prepared.run()
    })
  }

  async executeMultiple(sql: string): Promise<void> {
    return this.enqueue('write', async () => {
      await this.writeCon.run(sql)
    })
  }

  async beginTransaction(): Promise<void> {
    return this.enqueue('write', async () => {
      await this.writeCon.run('BEGIN TRANSACTION')
    })
  }

  async commit(): Promise<void> {
    return this.enqueue('write', async () => {
      await this.writeCon.run('COMMIT')
    })
  }

  async rollback(): Promise<void> {
    return this.enqueue('write', async () => {
      await this.writeCon.run('ROLLBACK')
    })
  }

  async createBulkInserter(table: string, columns: string[]): Promise<BulkInserter> {
    // DuckDB appender uses the write connection's table appender
    // Note: DuckDB appender doesn't take column names — it appends in table column order
    const appender = await this.writeCon.createAppender('main', table.replace(/"/g, ''))
    return {
      append(values: unknown[]) {
        appender.appendRow(...values)
      },
      async flush() {
        appender.flush()
      },
      async close() {
        appender.close()
      },
    }
  }

  // --- Internal helpers ---

  private enqueue<T>(queue: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    if (queue === 'write') {
      const p = this.writeQueue.then(fn)
      this.writeQueue = p.then(() => {}, () => {})
      return p
    } else {
      const p = this.readQueue.then(fn)
      this.readQueue = p.then(() => {}, () => {})
      return p
    }
  }

  private bindParams(prepared: any, params: unknown[]): void {
    for (let i = 0; i < params.length; i++) {
      const idx = i + 1
      const value = params[i]
      if (value === null || value === undefined) {
        prepared.bindNull(idx)
      } else if (typeof value === 'string') {
        prepared.bindVarchar(idx, value)
      } else if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          prepared.bindInteger(idx, value)
        } else {
          prepared.bindDouble(idx, value)
        }
      } else if (typeof value === 'boolean') {
        prepared.bindBoolean(idx, value)
      } else if (value instanceof Uint8Array) {
        prepared.bindBlob(idx, value)
      } else {
        prepared.bindVarchar(idx, JSON.stringify(value))
      }
    }
  }

  private rowsToObjects(reader: any): Record<string, unknown>[] {
    const columns = reader.columnNames()
    const rows = reader.getRows()
    return rows.map((row: any[]) => {
      const obj: Record<string, unknown> = {}
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i]
      }
      return obj
    })
  }
}
```

**Important notes for implementer:**
- The `bindParams` method is copied from `src/db.ts:46-80`. Check the original for any additional type bindings (BigInt, Date, etc.) that may have been added since this plan was written.
- The `rowsToObjects` method replaces the inline conversion in `src/db.ts`. Check `querySQL` (line ~1241) and `queryRecords` (line ~846) for how results are currently converted — the DuckDB reader API returns column-based data that needs flattening.
- `createBulkInserter` wraps DuckDB's `createAppender`. The current code at `db.ts:572-845` (`bulkInsertRecords`) manually manages appenders — this adapter provides the low-level appender and the shared `db.ts` will manage the staging/batch logic.

**Step 2: Verify the file compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit packages/hatk/src/database/adapters/duckdb.ts`
Expected: No errors (may need to check exact DuckDB API method names)

**Step 3: Commit**

```bash
git add packages/hatk/src/database/adapters/duckdb.ts
git commit -m "feat: add DuckDB adapter implementing DatabasePort"
```

---

## Task 4: Create SQLite Adapter — `src/database/adapters/sqlite.ts`

**Files:**
- Create: `packages/hatk/src/database/adapters/sqlite.ts`

**Context:** New adapter using `better-sqlite3`. SQLite is synchronous, so we wrap in promises. Uses WAL mode for concurrent reads. `BulkInserter` batches rows into multi-row INSERT within a transaction.

**Step 1: Add `better-sqlite3` dependency**

Run: `cd /Users/chadmiller/code/hatk/packages/hatk && npm install better-sqlite3 && npm install -D @types/better-sqlite3`

**Step 2: Write the SQLite adapter**

```typescript
// packages/hatk/src/database/adapters/sqlite.ts

import Database from 'better-sqlite3'
import type { DatabasePort, BulkInserter, Dialect } from '../ports.ts'

export class SQLiteAdapter implements DatabasePort {
  dialect: Dialect = 'sqlite'

  private db!: Database.Database

  async open(path: string): Promise<void> {
    this.db = new Database(path === ':memory:' ? ':memory:' : path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
  }

  close(): void {
    try { this.db?.close() } catch {}
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    return stmt.all(...params) as T[]
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const stmt = this.db.prepare(sql)
    stmt.run(...params)
  }

  async executeMultiple(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  async beginTransaction(): Promise<void> {
    this.db.exec('BEGIN')
  }

  async commit(): Promise<void> {
    this.db.exec('COMMIT')
  }

  async rollback(): Promise<void> {
    this.db.exec('ROLLBACK')
  }

  async createBulkInserter(table: string, columns: string[]): Promise<BulkInserter> {
    const placeholders = columns.map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
    const stmt = this.db.prepare(sql)
    const buffer: unknown[][] = []
    const BATCH_SIZE = 500

    const self = this
    return {
      append(values: unknown[]) {
        buffer.push(values)
        if (buffer.length >= BATCH_SIZE) {
          const tx = self.db.transaction(() => {
            for (const row of buffer) {
              stmt.run(...row)
            }
          })
          tx()
          buffer.length = 0
        }
      },
      async flush() {
        if (buffer.length > 0) {
          const tx = self.db.transaction(() => {
            for (const row of buffer) {
              stmt.run(...row)
            }
          })
          tx()
          buffer.length = 0
        }
      },
      async close() {
        // flush remaining
        if (buffer.length > 0) {
          const tx = self.db.transaction(() => {
            for (const row of buffer) {
              stmt.run(...row)
            }
          })
          tx()
          buffer.length = 0
        }
      },
    }
  }
}
```

**Step 3: Verify the file compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit packages/hatk/src/database/adapters/sqlite.ts`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/hatk/src/database/adapters/sqlite.ts
git commit -m "feat: add SQLite adapter implementing DatabasePort"
```

---

## Task 5: Rename `duckdbType` to `sqlType` in `schema.ts`

**Files:**
- Modify: `packages/hatk/src/schema.ts` — rename `duckdbType` field to `sqlType` everywhere
- Modify: `packages/hatk/src/db.ts` — update all references to `duckdbType`
- Modify: `packages/hatk/src/fts.ts` — update all references to `duckdbType`

**Context:** The `ColumnDef` interface at `schema.ts:4-10` has `duckdbType: string`. This needs to become `sqlType: string` since it will hold dialect-specific types. This is a mechanical rename.

**Step 1: Rename in schema.ts**

In `packages/hatk/src/schema.ts`:
- Line 8: `duckdbType: string` → `sqlType: string`
- All occurrences of `duckdbType` in the file (in `mapType` return values, `generateTableSchema`, `generateCreateTableSQL`, etc.) → `sqlType`
- Rename `TypeMapping.duckdbType` (line 50) → `TypeMapping.sqlType`
- Update all `mapType` return values: `{ duckdbType: 'TEXT', ... }` → `{ sqlType: 'TEXT', ... }`

**Step 2: Rename in db.ts**

In `packages/hatk/src/db.ts`:
- Search for all `duckdbType` references and replace with `sqlType`
- These appear in `insertRecord`, `bulkInsertRecords`, `queryRecords`, `reshapeRow`, and a few other functions where column type is checked

**Step 3: Rename in fts.ts**

In `packages/hatk/src/fts.ts`:
- Search for all `duckdbType` references and replace with `sqlType`
- These appear in `buildFtsIndex` where it checks column types

**Step 4: Verify everything compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit`
Expected: No errors

**Step 5: Run tests**

Run: `cd /Users/chadmiller/code/hatk && npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/hatk/src/schema.ts packages/hatk/src/db.ts packages/hatk/src/fts.ts
git commit -m "refactor: rename duckdbType to sqlType for dialect neutrality"
```

---

## Task 6: Make `schema.ts` Dialect-Aware

**Files:**
- Modify: `packages/hatk/src/schema.ts`

**Context:** The `mapType` function at `schema.ts:54-74` returns hardcoded DuckDB type names. Refactor it to accept a dialect and use the dialect's type map. The function is called from `generateTableSchema` (line 255) and `resolveUnionBranch` (line 239).

**Step 1: Update `mapType` to accept a type map**

The current `mapType` returns strings like `'TEXT'`, `'INTEGER'`, `'BOOLEAN'`, `'BLOB'`, `'JSON'`, `'TIMESTAMP'`. Replace these with lookups from a type map parameter:

```typescript
import type { SqlDialect } from './database/dialect.ts'

function mapType(prop: any, dialect: SqlDialect): TypeMapping {
  if (prop.type === 'string') {
    if (prop.format === 'datetime') return { sqlType: dialect.typeMap.timestamp, isRef: false }
    if (prop.format === 'at-uri') return { sqlType: dialect.typeMap.text, isRef: true }
    return { sqlType: dialect.typeMap.text, isRef: false }
  }
  if (prop.type === 'integer') return { sqlType: dialect.typeMap.integer, isRef: false }
  if (prop.type === 'boolean') return { sqlType: dialect.typeMap.boolean, isRef: false }
  if (prop.type === 'bytes') return { sqlType: dialect.typeMap.blob, isRef: false }
  if (prop.type === 'cid-link') return { sqlType: dialect.typeMap.text, isRef: false }
  if (prop.type === 'array') return { sqlType: dialect.jsonType, isRef: false }
  if (prop.type === 'blob') return { sqlType: dialect.jsonType, isRef: false }
  if (prop.type === 'union') return { sqlType: dialect.jsonType, isRef: false }
  if (prop.type === 'unknown') return { sqlType: dialect.jsonType, isRef: false }
  if (prop.type === 'object') return { sqlType: dialect.jsonType, isRef: false }
  if (prop.type === 'ref') {
    if (prop.ref === 'com.atproto.repo.strongRef') return { sqlType: 'STRONG_REF', isRef: true }
    return { sqlType: dialect.jsonType, isRef: false }
  }
  return { sqlType: dialect.typeMap.text, isRef: false }
}
```

**Step 2: Thread dialect through `generateTableSchema`, `resolveUnionBranch`, `generateCreateTableSQL`, `buildSchemas`**

All of these functions need a `dialect: SqlDialect` parameter added. Thread it through the call chain:

- `buildSchemas(lexicons, collections, dialect)` → passes to `generateTableSchema`
- `generateTableSchema(nsid, lexicon, lexicons, dialect)` → passes to `mapType` and `resolveUnionBranch`
- `resolveUnionBranch(..., dialect)` → passes to `mapType`
- `generateCreateTableSQL(schema, dialect)` → uses `dialect.timestampType` for the `indexed_at` column and system columns

Update `generateCreateTableSQL` to use `dialect.timestampType` for the `indexed_at TIMESTAMP` column (line 369):
```typescript
// Before:
'  indexed_at TIMESTAMP NOT NULL',
// After:
`  indexed_at ${dialect.timestampType} NOT NULL`,
```

And `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` in OAuth DDL becomes dialect-aware too.

**Step 3: Update callers of `buildSchemas`**

- `main.ts:70` — `buildSchemas(lexicons, collections)` → `buildSchemas(lexicons, collections, dialect)` (dialect comes from adapter)
- `cli.ts` — same pattern

**Step 4: Verify everything compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit`
Expected: No errors

**Step 5: Run tests**

Run: `cd /Users/chadmiller/code/hatk && npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/hatk/src/schema.ts packages/hatk/src/main.ts packages/hatk/src/cli.ts
git commit -m "refactor: make schema generation dialect-aware via SqlDialect"
```

---

## Task 7: Refactor `db.ts` to Use `DatabasePort`

**Files:**
- Modify: `packages/hatk/src/db.ts` (will become `packages/hatk/src/database/db.ts`)

**Context:** This is the largest task. The current `db.ts` has module-level DuckDB state. Replace with a module-level `DatabasePort` reference. All functions that call DuckDB directly (`con.run()`, `readCon.prepare()`, etc.) switch to `port.query()` / `port.execute()`.

**Step 1: Replace module-level DuckDB state with port reference**

Remove:
```typescript
import { DuckDBInstance } from '@duckdb/node-api'
let instance: DuckDBInstance
let con: ...
let readCon: ...
let writeQueue = Promise.resolve()
let readQueue = Promise.resolve()
function enqueue(...) { ... }
function bindParams(...) { ... }
```

Replace with:
```typescript
import type { DatabasePort, BulkInserter } from './ports.ts'
import { getDialect, type SqlDialect } from './dialect.ts'

let port: DatabasePort
let dialect: SqlDialect

export function getDatabasePort(): DatabasePort { return port }
export function getSqlDialect(): SqlDialect { return dialect }
```

**Step 2: Refactor `initDatabase`**

Current `initDatabase` (line 121) creates a DuckDB instance and runs DDL. Replace with:

```typescript
export async function initDatabase(
  adapter: DatabasePort,
  dbPath: string,
  tableSchemas: TableSchema[],
  ddlStatements: string[],
): Promise<void> {
  port = adapter
  dialect = getDialect(adapter.dialect)

  await port.open(dbPath)

  // Run system table DDL
  await port.executeMultiple(SYSTEM_DDL)

  // Run collection DDL
  for (const ddl of ddlStatements) {
    await port.executeMultiple(ddl)
  }

  // Store schemas in memory
  for (const s of tableSchemas) {
    schemas.set(s.collection, s)
  }
}
```

**Step 3: Refactor `querySQL` and `runSQL`**

Current implementations use the read/write connections directly. Replace with port calls:

```typescript
export async function querySQL(sql: string, params: any[] = []): Promise<any[]> {
  return port.query(sql, params)
}

export async function runSQL(sql: string, ...params: any[]): Promise<void> {
  return port.execute(sql, params)
}
```

**Step 4: Refactor `closeDatabase`**

```typescript
export function closeDatabase(): void {
  port?.close()
}
```

**Step 5: Refactor all other functions**

Every function that currently uses `enqueue('write', ...)` or `enqueue('read', ...)` with raw DuckDB calls needs to switch to `port.query()` or `port.execute()`. Key functions:

- `getCursor`, `setCursor` — simple query/execute, straightforward
- `setRepoStatus`, `getRepoStatus`, etc. — simple query/execute
- `insertRecord` — uses `con.prepare()` and `bindParams`. Replace with `port.execute(sql, params)`
- `deleteRecord` — similar
- `bulkInsertRecords` — currently manages DuckDB appenders directly. Replace appender creation with `port.createBulkInserter()`. The staging table logic needs adjustment based on `dialect.supportsAppender`.
- `queryRecords` — builds SQL and reads results. Replace query execution with `port.query()`. The result row conversion (DuckDB reader → objects) moves into the adapter.
- `searchRecords` — builds FTS query (DuckDB-specific `match_bm25`). This needs to dispatch to SearchPort or LIKE fallback.
- `runBatch` — iterates operations, executes each. Use `port.execute()`.

**Step 6: Handle SQL dialect differences in query building**

Places where SQL differs by dialect (found in current `db.ts`):

1. **Parameter placeholders:** Current code uses `$1`, `$2`, etc. For SQLite, these become `?`. Use `dialect.param(i)` when building parameterized queries.

2. **`INSERT OR REPLACE`:** Used in `setRepoStatus`, `setCursor`, `storeServerKey`, etc. This syntax works in both DuckDB and SQLite. No change needed.

3. **`CURRENT_TIMESTAMP`:** Used in several places. Works in both. No change needed.

4. **`string_agg`:** Used in `searchRecords`. SQLite uses `group_concat`. Parameterize.

5. **`information_schema.tables`:** Used in `getSchemaDump` and `main.ts` orphan detection. Use `dialect.listTablesQuery`.

6. **`json_extract_string` / `list_string_agg`:** DuckDB-specific JSON functions. Use dialect helpers.

**Step 7: Move file to `packages/hatk/src/database/db.ts`**

Move the refactored `db.ts` to its new location. Update the import of `schema.ts` and `fts.ts` to be relative within `database/`.

**Step 8: Verify everything compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit`
Expected: Compilation errors from files still importing old path — these are fixed in Task 9.

**Step 9: Commit**

```bash
git add packages/hatk/src/database/db.ts
git commit -m "refactor: rewrite db.ts to use DatabasePort instead of direct DuckDB calls"
```

---

## Task 8: Move `schema.ts` and `fts.ts` into `database/`

**Files:**
- Move: `packages/hatk/src/schema.ts` → `packages/hatk/src/database/schema.ts`
- Move: `packages/hatk/src/fts.ts` → `packages/hatk/src/database/fts.ts`

**Step 1: Move schema.ts**

Move the file. Update its internal imports if any (currently it has no imports from other hatk files).

**Step 2: Move fts.ts**

Move the file. Update its imports:
- `from './db.ts'` → `from './db.ts'` (same since both are now in `database/`)
- `from './schema.ts'` → `from './schema.ts'` (same)

**Step 3: Refactor `fts.ts` for SearchPort**

The current `fts.ts` uses DuckDB-specific `PRAGMA create_fts_index` and shadow tables. Refactor:

- Keep `stripStopWords`, `getSearchColumns`, `getLastRebuiltAt`, `ftsTableName` as-is (utility functions)
- `buildFtsIndex` should check if a `SearchPort` is available. If yes, delegate. If no, skip FTS (the `LIKE` fallback is in `searchRecords` in `db.ts`)
- `rebuildAllIndexes` stays as orchestrator

```typescript
import type { SearchPort } from './ports.ts'

let searchPort: SearchPort | null = null

export function setSearchPort(port: SearchPort | null): void {
  searchPort = port
}

export function hasSearchPort(): boolean {
  return searchPort !== null
}

export async function buildFtsIndex(collection: string): Promise<void> {
  if (!searchPort) return // No FTS support for this adapter

  // ... existing shadow table query building logic ...
  // Instead of running PRAGMA directly, call:
  await searchPort.buildIndex(safeName, sourceQuery, searchColNames)
}
```

**Step 4: Commit**

```bash
git add packages/hatk/src/database/schema.ts packages/hatk/src/database/fts.ts
git rm packages/hatk/src/schema.ts packages/hatk/src/fts.ts
git commit -m "refactor: move schema.ts and fts.ts into database/ directory"
```

---

## Task 9: Create DuckDB SearchPort — `src/database/adapters/duckdb-search.ts`

**Files:**
- Create: `packages/hatk/src/database/adapters/duckdb-search.ts`

**Context:** Extract the DuckDB FTS PRAGMA calls from `fts.ts` into a `SearchPort` implementation.

**Step 1: Write the DuckDB search adapter**

```typescript
// packages/hatk/src/database/adapters/duckdb-search.ts

import type { SearchPort } from '../ports.ts'
import type { DatabasePort } from '../ports.ts'

export class DuckDBSearchPort implements SearchPort {
  constructor(private port: DatabasePort) {}

  async buildIndex(
    shadowTable: string,
    sourceQuery: string,
    searchColumns: string[],
  ): Promise<void> {
    // Create shadow table
    await this.port.execute(`CREATE OR REPLACE TABLE ${shadowTable} AS ${sourceQuery}`)

    // Drop existing index
    try {
      await this.port.execute(`PRAGMA drop_fts_index('${shadowTable}')`)
    } catch {}

    // Build FTS index
    const colList = searchColumns.map((c) => `'${c}'`).join(', ')
    await this.port.execute(
      `PRAGMA create_fts_index('${shadowTable}', 'uri', ${colList}, stemmer='porter', stopwords='english', strip_accents=1, lower=1, overwrite=1)`
    )
  }

  async search(
    shadowTable: string,
    query: string,
    searchColumns: string[],
    limit: number,
    offset: number,
  ): Promise<Array<{ uri: string; score: number }>> {
    const colList = searchColumns.map((c) => `'${c}'`).join(', ')
    const sql = `SELECT uri, fts_main_${shadowTable}.match_bm25(uri, $1, fields := ${colList}) AS score
      FROM ${shadowTable}
      WHERE score IS NOT NULL
      ORDER BY score DESC
      LIMIT $2 OFFSET $3`
    return this.port.query(sql, [query, limit, offset])
  }
}
```

**Step 2: Commit**

```bash
git add packages/hatk/src/database/adapters/duckdb-search.ts
git commit -m "feat: add DuckDB SearchPort for FTS via PRAGMA"
```

---

## Task 10: Update All Import Paths

**Files to modify (every file that imports from `db.ts`, `schema.ts`, or `fts.ts`):**

- `packages/hatk/src/server.ts` — `'./db.ts'` → `'./database/db.ts'`, `'./schema.ts'` → `'./database/schema.ts'`
- `packages/hatk/src/indexer.ts` — `'./db.ts'` → `'./database/db.ts'`, `'./schema.ts'` → `'./database/schema.ts'`, `'./fts.ts'` → `'./database/fts.ts'`
- `packages/hatk/src/main.ts` — `'./db.ts'` → `'./database/db.ts'`, `'./schema.ts'` → `'./database/schema.ts'`, `'./fts.ts'` → `'./database/fts.ts'`
- `packages/hatk/src/cli.ts` — `'./schema.ts'` → `'./database/schema.ts'`
- `packages/hatk/src/backfill.ts` — `'./db.ts'` → `'./database/db.ts'`
- `packages/hatk/src/feeds.ts` — `'./db.ts'` → `'./database/db.ts'`
- `packages/hatk/src/xrpc.ts` — `'./db.ts'` → `'./database/db.ts'`, `'./schema.ts'` → `'./database/schema.ts'`
- `packages/hatk/src/opengraph.ts` — `'./db.ts'` → `'./database/db.ts'`
- `packages/hatk/src/hydrate.ts` — `'./db.ts'` → `'./database/db.ts'`
- `packages/hatk/src/labels.ts` — `'./db.ts'` → `'./database/db.ts'`
- `packages/hatk/src/hooks.ts` — `'./db.ts'` → `'./database/db.ts'`
- `packages/hatk/src/setup.ts` — `'./db.ts'` → `'./database/db.ts'`
- `packages/hatk/src/test.ts` — `'./db.ts'` → `'./database/db.ts'`, `'./schema.ts'` → `'./database/schema.ts'`
- `packages/hatk/src/seed.ts` — `'./schema.ts'` → `'./database/schema.ts'`
- `packages/hatk/src/views.ts` — `'./schema.ts'` → `'./database/schema.ts'`
- `packages/hatk/src/oauth/db.ts` — `'../db.ts'` → `'../database/db.ts'`
- `packages/hatk/src/oauth/server.ts` — `'../db.ts'` → `'../database/db.ts'`

**Step 1: Update all imports**

Mechanical find-and-replace in each file listed above. Also delete the old `src/db.ts`, `src/schema.ts`, `src/fts.ts` files if not already done.

**Step 2: Verify everything compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit`
Expected: No errors

**Step 3: Run tests**

Run: `cd /Users/chadmiller/code/hatk && npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: update all import paths to database/ directory"
```

---

## Task 11: Add `databaseEngine` Config Option and Adapter Factory

**Files:**
- Modify: `packages/hatk/src/config.ts` — add `databaseEngine` field
- Create: `packages/hatk/src/database/adapter-factory.ts` — dynamic import and instantiation
- Modify: `packages/hatk/src/main.ts` — use adapter factory

**Step 1: Add config field**

In `packages/hatk/src/config.ts`, add to `HatkConfig` interface (line 40-51):
```typescript
databaseEngine: 'duckdb' | 'sqlite'  // which database adapter to use
```

In `loadConfig` (line 69), add default:
```typescript
databaseEngine: (env.DATABASE_ENGINE as any) || parsed.databaseEngine || 'duckdb',
```

Update `HatkConfigInput` to make it optional (it defaults to `'duckdb'`).

**Step 2: Create adapter factory**

```typescript
// packages/hatk/src/database/adapter-factory.ts

import type { DatabasePort } from './ports.ts'
import type { SearchPort } from './ports.ts'

export async function createAdapter(engine: 'duckdb' | 'sqlite'): Promise<{
  adapter: DatabasePort
  searchPort: SearchPort | null
}> {
  switch (engine) {
    case 'duckdb': {
      const { DuckDBAdapter } = await import('./adapters/duckdb.ts')
      const { DuckDBSearchPort } = await import('./adapters/duckdb-search.ts')
      const adapter = new DuckDBAdapter()
      const searchPort = new DuckDBSearchPort(adapter)
      return { adapter, searchPort }
    }
    case 'sqlite': {
      const { SQLiteAdapter } = await import('./adapters/sqlite.ts')
      return { adapter: new SQLiteAdapter(), searchPort: null }
    }
    default:
      throw new Error(`Unsupported database engine: ${engine}`)
  }
}
```

**Step 3: Update `main.ts` startup**

Replace the current direct DuckDB initialization with:

```typescript
import { createAdapter } from './database/adapter-factory.ts'
import { setSearchPort } from './database/fts.ts'

// ... after config loaded ...
const { adapter, searchPort } = await createAdapter(config.databaseEngine)
setSearchPort(searchPort)

if (config.database !== ':memory:') {
  mkdirSync(dirname(config.database), { recursive: true })
}
await initDatabase(adapter, config.database, schemas, ddlStatements)
log(`[main] Database initialized (${config.databaseEngine}, ${config.database === ':memory:' ? 'in-memory' : config.database})`)
```

**Step 4: Update `test.ts` startup**

The test utility at `packages/hatk/src/test.ts` also calls `initDatabase`. Update it similarly to create a DuckDB adapter (or make the adapter configurable for test).

**Step 5: Verify everything compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit`
Expected: No errors

**Step 6: Run tests**

Run: `cd /Users/chadmiller/code/hatk && npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add packages/hatk/src/config.ts packages/hatk/src/database/adapter-factory.ts packages/hatk/src/main.ts packages/hatk/src/test.ts
git commit -m "feat: add databaseEngine config and adapter factory for DuckDB/SQLite selection"
```

---

## Task 12: Create `database/index.ts` Re-Export

**Files:**
- Create: `packages/hatk/src/database/index.ts`

**Context:** Provide a clean public API for the database module. External consumers (user-written feeds, xrpc handlers) may import from hatk — provide a barrel export.

**Step 1: Write the index file**

```typescript
// packages/hatk/src/database/index.ts

export type { DatabasePort, BulkInserter, SearchPort, Dialect } from './ports.ts'
export type { SqlDialect } from './dialect.ts'
export { getDialect, DUCKDB_DIALECT, SQLITE_DIALECT } from './dialect.ts'
export { createAdapter } from './adapter-factory.ts'

// Re-export commonly used functions from db.ts
export {
  initDatabase,
  closeDatabase,
  querySQL,
  runSQL,
  insertRecord,
  deleteRecord,
  queryRecords,
  searchRecords,
  getRecordByUri,
  getCursor,
  setCursor,
  bulkInsertRecords,
  packCursor,
  unpackCursor,
} from './db.ts'

// Re-export schema utilities
export {
  type TableSchema,
  type ColumnDef,
  type ChildTableSchema,
  loadLexicons,
  discoverCollections,
  buildSchemas,
  generateTableSchema,
  generateCreateTableSQL,
  toSnakeCase,
  getLexicon,
  getLexiconArray,
  getAllLexicons,
  storeLexicons,
} from './schema.ts'
```

**Step 2: Commit**

```bash
git add packages/hatk/src/database/index.ts
git commit -m "feat: add database module barrel export"
```

---

## Task 13: End-to-End Verification

**Step 1: Full type check**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit`
Expected: No errors

**Step 2: Run all tests**

Run: `cd /Users/chadmiller/code/hatk && npm test`
Expected: All tests pass

**Step 3: Build**

Run: `cd /Users/chadmiller/code/hatk && npm run build`
Expected: Clean build

**Step 4: Manual smoke test with DuckDB**

Run: `cd /Users/chadmiller/code/hatk && node packages/hatk/dist/cli.js dev`
Expected: Server starts, connects to DuckDB, runs normally

**Step 5: Manual smoke test with SQLite**

Create a test config with `databaseEngine: 'sqlite'` and `database: 'test.db'`. Run and verify tables are created in SQLite format.

**Step 6: Commit any fixes**

If any issues were found, fix and commit.

---

## Task 14: Update `hatk new` Scaffolding

**Files:**
- Modify: `packages/hatk/src/cli.ts` — add database engine prompt to `hatk new`

**Context:** The `hatk new` command scaffolds a new project. Add a prompt asking which database engine to use, and set the default in the generated `hatk.config.ts`.

**Step 1: Find the `hatk new` command implementation**

Look in `cli.ts` for the `new` command handler. Add a selection prompt for database engine.

**Step 2: Update generated `hatk.config.ts` template**

The generated config should include:
```typescript
databaseEngine: 'duckdb', // or 'sqlite' based on selection
```

**Step 3: Update generated `package.json` dependencies**

If user selects SQLite, include `better-sqlite3` instead of `@duckdb/node-api` in the generated `package.json`.

**Step 4: Verify scaffolding works**

Run: `cd /tmp && hatk new test-project` (select each database option)
Expected: Project scaffolded with correct config and dependencies

**Step 5: Commit**

```bash
git add packages/hatk/src/cli.ts
git commit -m "feat: add database engine selection to hatk new scaffolding"
```

---

## Summary

| Task | Description | Key files |
|------|-------------|-----------|
| 1 | Port interfaces | `database/ports.ts` |
| 2 | Dialect configs | `database/dialect.ts` |
| 3 | DuckDB adapter | `database/adapters/duckdb.ts` |
| 4 | SQLite adapter | `database/adapters/sqlite.ts` |
| 5 | Rename duckdbType→sqlType | `schema.ts`, `db.ts`, `fts.ts` |
| 6 | Dialect-aware schema gen | `schema.ts` |
| 7 | Refactor db.ts to use port | `database/db.ts` |
| 8 | Move schema+fts to database/ | `database/schema.ts`, `database/fts.ts` |
| 9 | DuckDB SearchPort | `database/adapters/duckdb-search.ts` |
| 10 | Update all import paths | 17 files |
| 11 | Config + adapter factory | `config.ts`, `database/adapter-factory.ts`, `main.ts` |
| 12 | Barrel export | `database/index.ts` |
| 13 | End-to-end verification | — |
| 14 | Update hatk new scaffolding | `cli.ts` |
