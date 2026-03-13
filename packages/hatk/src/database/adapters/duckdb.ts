import { DuckDBInstance } from '@duckdb/node-api'
import type { DatabasePort, BulkInserter, Dialect } from '../ports.ts'

export class DuckDBAdapter implements DatabasePort {
  dialect: Dialect = 'duckdb'

  private instance!: DuckDBInstance
  private writeCon!: Awaited<ReturnType<DuckDBInstance['connect']>>
  private readCon!: Awaited<ReturnType<DuckDBInstance['connect']>>
  private writeQueue = Promise.resolve()
  private readQueue = Promise.resolve()

  async open(path: string): Promise<void> {
    this.instance = await DuckDBInstance.create(path === ':memory:' ? undefined : path)
    this.writeCon = await this.instance.connect()
    this.readCon = await this.instance.connect()
  }

  close(): void {
    try {
      this.readCon?.closeSync()
    } catch {}
    try {
      this.writeCon?.closeSync()
    } catch {}
    try {
      this.instance?.closeSync()
    } catch {}
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.enqueue('read', async () => {
      if (params.length === 0) {
        const reader = await this.readCon.runAndReadAll(sql)
        return reader.getRowObjects() as T[]
      }
      const prepared = await this.readCon.prepare(sql)
      this.bindParams(prepared, params)
      const reader = await prepared.runAndReadAll()
      return reader.getRowObjects() as T[]
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
      for (const statement of sql.split(';').filter((s) => s.trim())) {
        await this.writeCon.run(statement)
      }
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

  async createBulkInserter(
    table: string,
    _columns: string[],
    _options?: { onConflict?: 'ignore' | 'replace'; batchSize?: number },
  ): Promise<BulkInserter> {
    const appender = await this.writeCon.createAppender(table.replace(/"/g, ''))
    return {
      append(values: unknown[]) {
        for (const value of values) {
          if (value === null || value === undefined) {
            appender.appendNull()
          } else if (typeof value === 'string') {
            appender.appendVarchar(value)
          } else if (typeof value === 'number') {
            if (Number.isInteger(value)) {
              appender.appendInteger(value)
            } else {
              appender.appendDouble(value)
            }
          } else if (typeof value === 'boolean') {
            appender.appendBoolean(value)
          } else if (typeof value === 'bigint') {
            appender.appendBigInt(value)
          } else if (value instanceof Uint8Array) {
            appender.appendBlob(value)
          } else {
            appender.appendVarchar(String(value))
          }
        }
        appender.endRow()
      },
      async flush() {
        appender.flushSync()
      },
      async close() {
        appender.flushSync()
        appender.closeSync()
      },
    }
  }

  /** Enqueue a read or write operation for serialization */
  private enqueue<T>(queue: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    if (queue === 'write') {
      const p = this.writeQueue.then(fn)
      this.writeQueue = p.then(
        () => {},
        () => {},
      )
      return p
    } else {
      const p = this.readQueue.then(fn)
      this.readQueue = p.then(
        () => {},
        () => {},
      )
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
      } else if (typeof value === 'bigint') {
        prepared.bindBigInt(idx, value)
      } else if (value instanceof Uint8Array) {
        prepared.bindBlob(idx, value)
      } else {
        prepared.bindVarchar(idx, String(value))
      }
    }
  }
}
