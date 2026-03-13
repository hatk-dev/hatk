import type { SearchPort } from '../ports.ts'
import type { DatabasePort } from '../ports.ts'

export class DuckDBSearchPort implements SearchPort {
  constructor(private port: DatabasePort) {}

  async buildIndex(shadowTable: string, sourceQuery: string, searchColumns: string[]): Promise<void> {
    // Create shadow table
    await this.port.execute(`CREATE OR REPLACE TABLE ${shadowTable} AS ${sourceQuery}`, [])

    // Drop existing index
    try {
      await this.port.execute(`PRAGMA drop_fts_index('${shadowTable}')`, [])
    } catch {}

    // Build FTS index
    const colList = searchColumns.map((c) => `'${c}'`).join(', ')
    await this.port.execute(
      `PRAGMA create_fts_index('${shadowTable}', 'uri', ${colList}, stemmer='porter', stopwords='english', strip_accents=1, lower=1, overwrite=1)`,
      [],
    )
  }

  async search(
    shadowTable: string,
    query: string,
    searchColumns: string[],
    limit: number,
    offset: number,
  ): Promise<Array<{ uri: string; score: number }>> {
    const ftsSchema = `fts_main_${shadowTable}`
    const sql = `SELECT uri, ${ftsSchema}.match_bm25(uri, $1) AS score
      FROM ${shadowTable}
      WHERE score IS NOT NULL
      ORDER BY score DESC
      LIMIT $2 OFFSET $3`
    return this.port.query(sql, [query, limit, offset])
  }
}
