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
