/**
 * Setup scripts that run once on server boot for initializing custom tables,
 * views, or other database state.
 *
 * Place scripts in the `setup/` directory. Each module default-exports a handler
 * function (or `{ handler }`) that receives a {@link SetupContext} with database
 * access. Scripts run in sorted filename order — prefix with numbers to control
 * execution order. Files starting with `_` are ignored.
 *
 * @example
 * ```ts
 * // setup/01-leaderboard.ts
 * import type { SetupContext } from '@hatk/hatk/setup'
 *
 * export default async function (ctx: SetupContext) {
 *   await ctx.db.run(`
 *     CREATE TABLE IF NOT EXISTS leaderboard (
 *       did TEXT PRIMARY KEY,
 *       score INTEGER DEFAULT 0
 *     )
 *   `)
 * }
 * ```
 */
import { resolve, relative } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { log } from './logger.ts'
import { querySQL, runSQL, runBatch, createBulkInserterSQL } from './database/db.ts'
import type { BulkInserter } from './database/ports.ts'

/** Context passed to each setup script's handler function. */
export interface SetupContext {
  db: {
    query: (sql: string, params?: any[]) => Promise<any[]>
    run: (sql: string, params?: any[]) => Promise<void>
    runBatch: (operations: Array<{ sql: string; params: any[] }>) => Promise<void>
    createBulkInserter: (table: string, columns: string[], options?: { onConflict?: 'ignore' | 'replace'; batchSize?: number }) => Promise<BulkInserter>
  }
}

/** Recursively collect .ts/.js files in a directory, skipping files prefixed with `_`. */
function walkDir(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry)
      if (statSync(full).isDirectory()) {
        results.push(...walkDir(full))
      } else if ((entry.endsWith('.ts') || entry.endsWith('.js')) && !entry.startsWith('_')) {
        results.push(full)
      }
    }
  } catch {}
  return results.sort()
}

/**
 * Run all setup scripts in the given directory on server boot.
 *
 * Each script should export a default handler function (or `{ handler }`) that
 * receives a {@link SetupContext} with database access. Scripts run in sorted
 * filename order — prefix with numbers (e.g. `01-create-tables.ts`) to control
 * execution order. Files starting with `_` are ignored.
 *
 * @param setupDir - Absolute path to the `setup/` directory
 */
export async function initSetup(setupDir: string): Promise<void> {
  const files = walkDir(setupDir)
  if (files.length === 0) return

  for (const scriptPath of files) {
    const name = relative(setupDir, scriptPath).replace(/\.(ts|js)$/, '')
    const mod = await import(scriptPath)
    const handler = mod.default?.handler || mod.default
    if (typeof handler !== 'function') {
      console.warn(`[setup] ${name}: no handler function found, skipping`)
      continue
    }

    const ctx: SetupContext = {
      db: { query: querySQL, run: runSQL, runBatch, createBulkInserter: createBulkInserterSQL },
    }

    log(`[setup] running: ${name}`)
    await handler(ctx)
    log(`[setup] done: ${name}`)
  }
}
