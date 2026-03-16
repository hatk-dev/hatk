import type { SearchPort } from '../ports.ts'
import type { DatabasePort } from '../ports.ts'

/**
 * SQLite FTS5-based search port with incremental updates.
 *
 * Uses external content FTS5 tables (content=shadowTable) so the FTS index
 * references the shadow data table. Updates happen incrementally per-record
 * instead of dropping and rebuilding the entire index.
 */
export class SQLiteSearchPort implements SearchPort {
  constructor(private port: DatabasePort) {}

  async indexExists(shadowTable: string): Promise<boolean> {
    const rows = await this.port.query(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ($1, $2)`,
      [shadowTable, `${shadowTable}_fts`],
    )
    return rows.length >= 2
  }

  async buildIndex(shadowTable: string, sourceQuery: string, searchColumns: string[]): Promise<void> {
    await this.port.execute(`DROP TABLE IF EXISTS ${shadowTable}_fts`, [])
    await this.port.execute(`DROP TABLE IF EXISTS ${shadowTable}`, [])

    // Create shadow data table from source query
    await this.port.execute(`CREATE TABLE ${shadowTable} AS ${sourceQuery}`, [])
    await this.port.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${shadowTable}_uri ON ${shadowTable}(uri)`,
      [],
    )

    // Create FTS5 virtual table with external content pointing to shadow table
    const colList = searchColumns.join(', ')
    await this.port.execute(
      `CREATE VIRTUAL TABLE ${shadowTable}_fts USING fts5(uri UNINDEXED, ${colList}, content=${shadowTable}, content_rowid=rowid, tokenize='porter unicode61 remove_diacritics 2')`,
      [],
    )

    // Populate FTS from shadow table
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

    // Remove old FTS entry if record already indexed
    await this._deleteFromFts(shadowTable, uri, searchColumns)

    // Upsert shadow table
    const placeholders = searchColumns.map((_, i) => `$${i + 2}`)
    const setClauses = searchColumns.map((c, i) => `${c} = $${i + 2}`)
    const values = [uri, ...searchColumns.map((c) => row[c] ?? null)]
    await this.port.execute(
      `INSERT INTO ${shadowTable} (uri, ${colList}) VALUES ($1, ${placeholders.join(', ')}) ON CONFLICT(uri) DO UPDATE SET ${setClauses.join(', ')}`,
      values,
    )

    // Read back rowid and insert new FTS entry
    const rows = await this.port.query(`SELECT rowid FROM ${shadowTable} WHERE uri = $1`, [uri])
    if (rows.length > 0) {
      const rowid = (rows[0] as any).rowid
      const ftsPlaceholders = searchColumns.map((_, i) => `$${i + 3}`)
      await this.port.execute(
        `INSERT INTO ${shadowTable}_fts(rowid, uri, ${colList}) VALUES($1, $2, ${ftsPlaceholders.join(', ')})`,
        [rowid, uri, ...searchColumns.map((c) => row[c] ?? '')],
      )
    }
  }

  async deleteFromIndex(shadowTable: string, uri: string, searchColumns: string[]): Promise<void> {
    await this._deleteFromFts(shadowTable, uri, searchColumns)
    await this.port.execute(`DELETE FROM ${shadowTable} WHERE uri = $1`, [uri])
  }

  private async _deleteFromFts(
    shadowTable: string,
    uri: string,
    searchColumns: string[],
  ): Promise<void> {
    const colList = searchColumns.join(', ')
    const rows = await this.port.query(
      `SELECT rowid, uri, ${colList} FROM ${shadowTable} WHERE uri = $1`,
      [uri],
    )
    if (rows.length === 0) return

    const old = rows[0] as any
    const placeholders = searchColumns.map((_, i) => `$${i + 3}`)
    await this.port.execute(
      `INSERT INTO ${shadowTable}_fts(${shadowTable}_fts, rowid, uri, ${colList}) VALUES('delete', $1, $2, ${placeholders.join(', ')})`,
      [old.rowid, uri, ...searchColumns.map((c) => old[c] ?? '')],
    )
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
