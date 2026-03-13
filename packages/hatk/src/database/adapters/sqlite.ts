import Database from 'better-sqlite3'
import type { DatabasePort, BulkInserter, Dialect } from '../ports.ts'

/**
 * Translate DuckDB-style `$1, $2` placeholders to SQLite `?` placeholders.
 * Handles repeated references to the same `$N` by duplicating the param value.
 * Returns the translated SQL and expanded params array.
 */
function translateParams(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  if (params.length === 0) return { sql, params }

  const expandedParams: unknown[] = []
  const translated = sql.replace(/\$(\d+)/g, (_match, numStr) => {
    const idx = parseInt(numStr) - 1 // $1 → index 0
    expandedParams.push(params[idx])
    return '?'
  })

  return { sql: translated, params: expandedParams }
}

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
    const t = translateParams(sql, params)
    const stmt = this.db.prepare(t.sql)
    return stmt.all(...t.params) as T[]
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const t = translateParams(sql, params)
    const stmt = this.db.prepare(t.sql)
    stmt.run(...t.params)
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

  async createBulkInserter(table: string, columns: string[], options?: { onConflict?: 'ignore' | 'replace'; batchSize?: number }): Promise<BulkInserter> {
    const placeholders = columns.map(() => '?').join(', ')
    const conflict = options?.onConflict === 'ignore' ? ' OR IGNORE' : options?.onConflict === 'replace' ? ' OR REPLACE' : ''
    const sql = `INSERT${conflict} INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
    const stmt = this.db.prepare(sql)
    const buffer: unknown[][] = []
    const batchSize = options?.batchSize ?? 5000

    const flushBuffer = this.db.transaction(() => {
      for (const row of buffer) {
        stmt.run(...row)
      }
    })

    const flush = () => {
      if (buffer.length > 0) {
        flushBuffer()
        buffer.length = 0
      }
    }

    return {
      append(values: unknown[]) {
        buffer.push(values)
        if (buffer.length >= batchSize) flush()
      },
      async flush() { flush() },
      async close() { flush() },
    }
  }
}
