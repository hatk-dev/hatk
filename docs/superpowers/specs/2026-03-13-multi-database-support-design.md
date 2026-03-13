# Multi-Database Support via Hexagonal Architecture

## Motivation

Support DuckDB, SQLite, and future PostgreSQL to give users a choice at project creation time and remove adoption barriers for users who can't or won't install DuckDB.

Each hatk project commits to one database engine — no runtime switching.

## Configuration

Users set `database: 'duckdb' | 'sqlite'` in `hatk.config.ts`. At startup, hatk dynamically imports the matching adapter. Users only need the driver for their chosen database installed.

## Architecture

### Ports

Two interfaces define the hexagonal boundary:

**DatabasePort** — low-level SQL execution:

```typescript
interface DatabasePort {
  open(path: string): Promise<void>
  close(): Promise<void>

  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<void>

  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>

  createBulkInserter(table: string, columns: string[]): Promise<BulkInserter>

  dialect: Dialect
}

interface BulkInserter {
  append(values: unknown[]): void
  flush(): Promise<void>
  close(): Promise<void>
}

type Dialect = 'duckdb' | 'sqlite' | 'postgres'
```

**SearchPort** — optional FTS capability:

```typescript
interface SearchPort {
  createIndex(table: string, columns: string[]): Promise<void>
  search(table: string, query: string, opts: SearchOpts): Promise<SearchResult[]>
}
```

Adapters declare whether they implement `SearchPort`. When unavailable, hatk falls back to `LIKE` matching.

### Dialect-Aware SQL Generation

A `SqlDialect` helper provides per-engine variations so the shared layer avoids scattered conditionals:

```typescript
interface SqlDialect {
  typeMap: Record<string, string>
  param(index: number): string       // $1 vs ?
  supportsAppender: boolean
  returningClause: boolean
  upsertSyntax: 'on_conflict' | 'insert_or_replace'
  jsonExtract(column: string, path: string): string
}
```

Type mappings used by `schema.ts`:

| Lexicon type | DuckDB       | SQLite    | Postgres      |
|-------------|-------------|-----------|---------------|
| `string`    | `TEXT`      | `TEXT`    | `TEXT`        |
| `integer`   | `BIGINT`   | `INTEGER` | `BIGINT`      |
| `boolean`   | `BOOLEAN`  | `INTEGER` | `BOOLEAN`     |
| `bytes`     | `BLOB`     | `BLOB`   | `BYTEA`       |
| `datetime`  | `TIMESTAMPTZ` | `TEXT` | `TIMESTAMPTZ` |

SQLite stores booleans as integers and datetimes as text. The shared layer handles conversion at the binding/reading boundary.

### Adapters

**DuckDBAdapter** (~200-300 lines)
- Wraps `@duckdb/node-api`
- `BulkInserter` maps to DuckDB's native appender
- Implements `SearchPort` using DuckDB's FTS extension
- Read/write connection separation

**SQLiteAdapter** (~200-300 lines)
- Wraps `better-sqlite3`
- `BulkInserter` batches rows into multi-row `INSERT` within a transaction
- No `SearchPort` — falls back to `LIKE`
- WAL mode for concurrent reads

**PostgresAdapter** (future, ~200-300 lines)
- Wraps `pg` (node-postgres)
- `BulkInserter` uses `COPY FROM`
- Implements `SearchPort` using `tsvector`/`tsquery`
- Connection pooling

### Adapter Loading

```typescript
async function createAdapter(config: HatkConfig): Promise<DatabasePort> {
  switch (config.database) {
    case 'duckdb': {
      const { DuckDBAdapter } = await import('./adapters/duckdb.js')
      return new DuckDBAdapter()
    }
    case 'sqlite': {
      const { SQLiteAdapter } = await import('./adapters/sqlite.js')
      return new SQLiteAdapter()
    }
  }
}
```

### OAuth

OAuth operations (sessions, tokens, keys, DPoP) go through the same `DatabasePort`. No separate database or port needed — the queries are simple CRUD.

## File Structure

All database code moves to `src/database/`:

```
src/database/
  ports.ts          # DatabasePort, BulkInserter, SearchPort interfaces
  dialect.ts        # SqlDialect interface + per-engine dialect configs
  db.ts             # Shared data access layer (refactored from current db.ts)
  schema.ts         # DDL generation (refactored from current schema.ts)
  fts.ts            # FTS dispatcher with LIKE fallback
  adapters/
    duckdb.ts       # DuckDB adapter + SearchPort
    sqlite.ts       # SQLite adapter
```

The rest of the codebase (`server.ts`, `indexer.ts`, `main.ts`, etc.) imports from `database/db.ts` instead of `db.ts` — same API surface, different path.

## Implementation

Done as a single pass, not phased:

1. Create `src/database/` with `ports.ts` and `dialect.ts`
2. Extract DuckDB-specific code from current `db.ts` into `adapters/duckdb.ts`
3. Refactor `db.ts` into `database/db.ts`, calling through `DatabasePort`
4. Refactor `schema.ts` into `database/schema.ts`, using `SqlDialect.typeMap`
5. Extract DuckDB FTS from `fts.ts` into adapter's `SearchPort`, add `LIKE` fallback
6. Implement `SQLiteAdapter` in `adapters/sqlite.ts`
7. Add `database` config option and dynamic adapter loading in startup
8. Update all imports across the codebase
9. Update `hatk new` scaffolding to include database choice
