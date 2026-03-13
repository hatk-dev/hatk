import type { DatabasePort, SearchPort } from './ports.ts'

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
      const { SQLiteSearchPort } = await import('./adapters/sqlite-search.ts')
      const adapter = new SQLiteAdapter()
      const searchPort = new SQLiteSearchPort(adapter)
      return { adapter, searchPort }
    }
    default:
      throw new Error(`Unsupported database engine: ${engine}`)
  }
}
