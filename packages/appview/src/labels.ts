import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import type { LabelDefinition } from './config.ts'
import { querySQL, runSQL, insertLabels, getSchema } from './db.ts'
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

interface LabelRule {
  name: string
  evaluate: (ctx: LabelRuleContext) => Promise<string[]>
}

const rules: LabelRule[] = []
let labelDefs: LabelDefinition[] = []
let labelSrc = 'self'

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
    const mod = await import(scriptPath)
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

export async function rescanLabels(collections: string[]): Promise<{ scanned: number; labeled: number }> {
  const beforeRows = await querySQL(`SELECT COUNT(*) as count FROM _labels`)
  const beforeCount = Number(beforeRows[0]?.count || 0)

  let scanned = 0

  for (const collection of collections) {
    const schema = getSchema(collection)
    if (!schema) continue

    const rows = await querySQL(`SELECT * FROM ${schema.tableName}`)
    for (const row of rows) {
      scanned++
      const value: Record<string, any> = {}
      for (const col of schema.columns) {
        let v = row[col.name]
        if (v === null || v === undefined) continue
        if (col.duckdbType === 'JSON' && typeof v === 'string') {
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

  const afterRows = await querySQL(`SELECT COUNT(*) as count FROM _labels`)
  const afterCount = Number(afterRows[0]?.count || 0)

  return { scanned, labeled: afterCount - beforeCount }
}

export function getLabelDefinitions(): LabelDefinition[] {
  return labelDefs
}
