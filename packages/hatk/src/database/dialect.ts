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

  /** ILIKE or equivalent for case-insensitive matching */
  ilike: string

  /** Cast expression for safe timestamp parsing. DuckDB: TRY_CAST(x AS TIMESTAMP), SQLite: x */
  tryCastTimestamp(expr: string): string

  /** COUNT(*)::INTEGER or equivalent */
  countAsInteger: string

  /** GREATEST(...) or MAX(...) for multi-arg max */
  greatest(exprs: string[]): string

  /** jaro_winkler_similarity or null if unsupported */
  jaroWinklerSimilarity: string | null

  /** string_agg or group_concat */
  stringAgg(column: string, separator: string): string

  /** CREATE SEQUENCE support */
  supportsSequences: boolean

  /** SQL to get columns for a table. Returns rows with column_name/name and data_type/type. */
  introspectColumnsQuery(tableName: string): string
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
  ilike: 'ILIKE',
  tryCastTimestamp: (expr) => `TRY_CAST(${expr} AS TIMESTAMP)`,
  countAsInteger: 'COUNT(*)::INTEGER',
  greatest: (exprs) => `GREATEST(${exprs.join(', ')})`,
  jaroWinklerSimilarity: 'jaro_winkler_similarity',
  stringAgg: (col, sep) => `string_agg(${col}, ${sep})`,
  supportsSequences: true,
  introspectColumnsQuery: (tableName) =>
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableName}'`,
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
    return `(SELECT group_concat(je.value, ' ') FROM json_each(${col}, '${path}') je)`
  },
  listTablesQuery: `SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\\\'`,
  checkpointSQL: null,
  currentTimestamp: 'CURRENT_TIMESTAMP',
  ilike: 'LIKE',
  tryCastTimestamp: (expr) => expr,
  countAsInteger: 'CAST(COUNT(*) AS INTEGER)',
  greatest: (exprs) => `MAX(${exprs.join(', ')})`,
  jaroWinklerSimilarity: null,
  stringAgg: (col, sep) => `group_concat(${col}, ${sep})`,
  supportsSequences: false,
  introspectColumnsQuery: (tableName) =>
    `PRAGMA table_info("${tableName}")`,
}

export function getDialect(dialect: Dialect): SqlDialect {
  switch (dialect) {
    case 'duckdb': return DUCKDB_DIALECT
    case 'sqlite': return SQLITE_DIALECT
    case 'postgres': throw new Error('PostgreSQL adapter not yet implemented')
  }
}
