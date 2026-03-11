import { resolve, relative } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { log } from './logger.ts'
import { querySQL, runSQL } from './db.ts'

export interface SetupContext {
  db: {
    query: (sql: string, params?: any[]) => Promise<any[]>
    run: (sql: string, ...params: any[]) => Promise<void>
  }
}

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
      db: { query: querySQL, run: runSQL },
    }

    log(`[setup] running: ${name}`)
    await handler(ctx)
    log(`[setup] done: ${name}`)
  }
}
