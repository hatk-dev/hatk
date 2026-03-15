import { resolve, relative } from 'node:path'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { log } from './logger.ts'

export interface ScannedModule {
  path: string
  name: string
  mod: any
}

export interface ScanResult {
  feeds: ScannedModule[]
  queries: ScannedModule[]
  procedures: ScannedModule[]
  hooks: ScannedModule[]
  setup: ScannedModule[]
  labels: ScannedModule[]
  og: ScannedModule[]
  renderer: ScannedModule | null
}

/** Recursively collect .ts/.js files, skipping _ prefixed and dot files */
function walkDir(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue
      const full = resolve(dir, entry)
      if (statSync(full).isDirectory()) {
        results.push(...walkDir(full))
      } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        results.push(full)
      }
    }
  } catch {}
  return results.sort()
}

/**
 * Scan a directory for hatk server modules.
 * Each file's default export is inspected for a `__type` tag.
 */
export async function scanServerDir(serverDir: string): Promise<ScanResult> {
  const result: ScanResult = {
    feeds: [],
    queries: [],
    procedures: [],
    hooks: [],
    setup: [],
    labels: [],
    og: [],
    renderer: null,
  }

  if (!existsSync(serverDir)) return result

  const files = walkDir(serverDir)

  for (const filePath of files) {
    const name = relative(serverDir, filePath).replace(/\.(ts|js)$/, '')
    const mod = await import(/* @vite-ignore */ `${filePath}?t=${Date.now()}`)
    const exported = mod.default

    if (!exported) {
      log(`[scanner] ${name}: no default export, skipping`)
      continue
    }

    const entry: ScannedModule = { path: filePath, name, mod: exported }

    switch (exported.__type) {
      case 'feed':
        result.feeds.push(entry)
        break
      case 'query':
        result.queries.push(entry)
        break
      case 'procedure':
        result.procedures.push(entry)
        break
      case 'hook':
        result.hooks.push(entry)
        break
      case 'setup':
        result.setup.push(entry)
        break
      case 'labels':
        result.labels.push(entry)
        break
      case 'og':
        result.og.push(entry)
        break
      case 'renderer':
        result.renderer = entry
        break
      default:
        log(`[scanner] ${name}: no recognized __type tag, skipping`)
    }
  }

  return result
}
