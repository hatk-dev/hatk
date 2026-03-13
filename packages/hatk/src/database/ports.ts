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
