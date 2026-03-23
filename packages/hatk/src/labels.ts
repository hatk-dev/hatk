/**
 * Label system for applying moderation labels to records as they are indexed.
 *
 * Place label modules in the `labels/` directory. Each module default-exports
 * an object with a `definition` (label metadata) and/or an `evaluate` function
 * (rule that returns label values for a given record).
 *
 * @example
 * ```ts
 * // labels/nsfw.ts
 * import type { LabelRuleContext } from '@hatk/hatk/labels'
 *
 * export default {
 *   definition: {
 *     identifier: 'nsfw',
 *     severity: 'alert',
 *     blurs: 'media',
 *     defaultSetting: 'warn',
 *     locales: [{ lang: 'en', name: 'NSFW', description: 'Not safe for work' }],
 *   },
 *
 *   async evaluate(ctx: LabelRuleContext): Promise<string[]> {
 *     if (ctx.record.value.nsfw === true) return ['nsfw']
 *     return []
 *   },
 * }
 * ```
 */
import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import type { LabelDefinition } from './config.ts'
import { querySQL, runSQL, insertLabels, getSchema } from './database/db.ts'
import { log, emit } from './logger.ts'

/** Context passed to label rule evaluate() functions */
export interface LabelRuleContext {
  db: {
    query: (sql: string, params?: any[]) => Promise<any[]>
    run: (sql: string, ...params: any[]) => Promise<void>
  }
  record: {
    uri: string
    cid: string
    did: string
    collection: string
    value: Record<string, any>
  }
}

export interface LabelModule {
  definition?: LabelDefinition
  evaluate?: (ctx: LabelRuleContext) => Promise<string[]>
}

export function defineLabel(module: LabelModule) {
  return { __type: 'labels' as const, ...module }
}

/** Internal representation of a loaded label rule module. */
interface LabelRule {
  name: string
  evaluate: (ctx: LabelRuleContext) => Promise<string[]>
}

const rules: LabelRule[] = []
let labelDefs: LabelDefinition[] = []
let labelSrc = 'self'

/**
 * Discover and load label rule modules from the `labels/` directory.
 *
 * Each module should default-export an object with an optional `definition`
 * (label metadata like severity and blur behavior) and an optional `evaluate`
 * function that returns label values to apply to a record.
 *
 * @param labelsDir - Absolute path to the `labels/` directory
 */
export async function initLabels(labelsDir: string): Promise<void> {
  let files: string[]
  try {
    files = readdirSync(labelsDir)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('_'))
      .sort()
  } catch {
    return
  }

  for (const file of files) {
    const name = file.replace(/\.(ts|js)$/, '')
    const scriptPath = resolve(labelsDir, file)
    const mod = await import(/* @vite-ignore */ `${scriptPath}?t=${Date.now()}`)
    const handler = mod.default

    if (handler.definition) {
      labelDefs.push(handler.definition)
    }

    if (handler.evaluate) {
      rules.push({
        name,
        evaluate: async (ctx: LabelRuleContext) => {
          return handler.evaluate(ctx)
        },
      })
    }

    log(`[labels] discovered: ${name}${handler.evaluate ? ' (rule)' : ''}`)
  }

  if (labelDefs.length > 0) {
    log(`[labels] ${labelDefs.length} label definitions loaded`)
  }
}

/** Clear all registered label definitions and rules (for hot-reload). */
export function clearLabels(): void {
  labelDefs.length = 0
  rules.length = 0
}

/** Register a single label module from a scanned server/ module. */
export function registerLabelModule(
  name: string,
  labelMod: { definition?: LabelDefinition; evaluate?: (ctx: LabelRuleContext) => Promise<string[]> },
): void {
  if (labelMod.definition) {
    labelDefs.push(labelMod.definition)
  }
  if (labelMod.evaluate) {
    rules.push({ name, evaluate: labelMod.evaluate })
  }
}

/**
 * Evaluate all loaded label rules against a record and persist any resulting labels.
 * Called after each record is indexed. Rule errors are logged but never block indexing.
 */
export async function runLabelRules(record: {
  uri: string
  cid: string
  did: string
  collection: string
  value: Record<string, any>
}): Promise<void> {
  if (rules.length === 0) return

  const ctx: LabelRuleContext = {
    db: { query: querySQL, run: runSQL },
    record,
  }

  const allLabels: Array<{ src: string; uri: string; val: string }> = []

  for (const rule of rules) {
    try {
      const vals = await rule.evaluate(ctx)
      for (const val of vals) {
        allLabels.push({ src: labelSrc, uri: record.uri, val })
      }
    } catch (err: any) {
      emit('labels', 'rule_error', { rule: rule.name, error: err.message })
    }
  }

  if (allLabels.length > 0) {
    await insertLabels(allLabels)
    emit('labels', 'applied', { count: allLabels.length, uri: record.uri, vals: allLabels.map((l) => l.val) })
  }
}

/**
 * Re-evaluate all label rules against every existing record in the given collections.
 * Used by `/admin/rescan-labels` to apply new or updated rules retroactively.
 *
 * @returns Count of records scanned and new labels applied
 */
export async function rescanLabels(collections: string[]): Promise<{ scanned: number; labeled: number }> {
  const beforeRows = (await querySQL(`SELECT COUNT(*) as count FROM _labels`)) as { count: number }[]
  const beforeCount = Number(beforeRows[0]?.count || 0)

  let scanned = 0

  for (const collection of collections) {
    const schema = getSchema(collection)
    if (!schema) continue

    const rows = (await querySQL(`SELECT * FROM ${schema.tableName}`)) as Record<string, any>[]
    for (const row of rows) {
      scanned++
      const value: Record<string, any> = {}
      for (const col of schema.columns) {
        let v = row[col.name]
        if (v === null || v === undefined) continue
        if (col.isJson && typeof v === 'string') {
          try {
            v = JSON.parse(v)
          } catch {}
        }
        value[col.originalName] = v
      }

      await runLabelRules({
        uri: row.uri,
        cid: row.cid,
        did: row.did,
        collection,
        value,
      })
    }
  }

  const afterRows = (await querySQL(`SELECT COUNT(*) as count FROM _labels`)) as { count: number }[]
  const afterCount = Number(afterRows[0]?.count || 0)

  return { scanned, labeled: afterCount - beforeCount }
}

/** Return all label definitions discovered during {@link initLabels}. */
export function getLabelDefinitions(): LabelDefinition[] {
  return labelDefs
}
