import type { SearchPort } from '../ports.ts'
import type { DatabasePort } from '../ports.ts'

/**
 * SQLite FTS5-based search port.
 *
 * Uses SQLite's built-in FTS5 virtual tables for full-text search with BM25 ranking.
 * The shadow table name is reused as the FTS5 virtual table name.
 */
export class SQLiteSearchPort implements SearchPort {
  constructor(private port: DatabasePort) {}

  async buildIndex(shadowTable: string, sourceQuery: string, searchColumns: string[]): Promise<void> {
    // Drop existing FTS table and data table
    await this.port.execute(`DROP TABLE IF EXISTS ${shadowTable}_fts`, [])
    await this.port.execute(`DROP TABLE IF EXISTS ${shadowTable}`, [])

    // Create the data table from the source query
    await this.port.execute(`CREATE TABLE ${shadowTable} AS ${sourceQuery}`, [])

    // Create the FTS5 virtual table over the search columns
    const colList = searchColumns.join(', ')
    await this.port.execute(
      `CREATE VIRTUAL TABLE ${shadowTable}_fts USING fts5(uri UNINDEXED, ${colList}, tokenize='porter unicode61 remove_diacritics 2')`,
      [],
    )

    // Populate FTS table from the data table
    const selectCols = ['uri', ...searchColumns].map((c) => `COALESCE(CAST(${c} AS TEXT), '')`)
    await this.port.execute(
      `INSERT INTO ${shadowTable}_fts (uri, ${colList}) SELECT ${selectCols.join(', ')} FROM ${shadowTable}`,
      [],
    )
  }

  async search(
    shadowTable: string,
    query: string,
    _searchColumns: string[],
    limit: number,
    offset: number,
  ): Promise<Array<{ uri: string; score: number }>> {
    // Escape FTS5 special characters and build query
    const escaped = query.replace(/['"*(){}[\]^~\\:]/g, ' ').trim()
    if (!escaped) return []

    // Use FTS5 MATCH with bm25() ranking (lower = better match, negate for DESC)
    const sql = `SELECT uri, -bm25(${shadowTable}_fts) AS score
      FROM ${shadowTable}_fts
      WHERE ${shadowTable}_fts MATCH $1
      ORDER BY score DESC
      LIMIT $2 OFFSET $3`
    return this.port.query(sql, [escaped, limit, offset])
  }
}
