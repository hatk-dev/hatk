import { DuckDBInstance } from '@duckdb/node-api'
import { type TableSchema, toSnakeCase } from './schema.ts'
import type { Row } from './lex-types.ts'
import { getSearchColumns, stripStopWords } from './fts.ts'
import { emit, timer } from './logger.ts'
import { OAUTH_DDL } from './oauth/db.ts'

let instance: DuckDBInstance
let con: Awaited<ReturnType<DuckDBInstance['connect']>>
let readCon: Awaited<ReturnType<DuckDBInstance['connect']>>
const schemas = new Map<string, TableSchema>()

export function closeDatabase(): void {
  try { readCon?.closeSync() } catch {}
  try { con?.closeSync() } catch {}
  try { instance?.closeSync() } catch {}
}

let writeQueue = Promise.resolve()
let readQueue = Promise.resolve()

function enqueue<T>(queue: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
  if (queue === 'write') {
    const p = writeQueue.then(fn)
    writeQueue = p.then(
      () => {},
      () => {},
    )
    return p
  } else {
    const p = readQueue.then(fn)
    readQueue = p.then(
      () => {},
      () => {},
    )
    return p
  }
}

function bindParams(prepared: any, params: any[]): void {
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

async function runDirect(sql: string, ...params: any[]): Promise<void> {
  if (params.length === 0) {
    await con.run(sql)
    return
  }
  const prepared = await con.prepare(sql)
  bindParams(prepared, params)
  await prepared.run()
}

async function run(sql: string, ...params: any[]): Promise<void> {
  return enqueue('write', () => runDirect(sql, ...params))
}

export async function runBatch(operations: Array<{ sql: string; params: any[] }>): Promise<void> {
  return enqueue('write', async () => {
    await con.run('BEGIN TRANSACTION')
    for (const op of operations) {
      try {
        if (op.params.length === 0) {
          await con.run(op.sql)
        } else {
          const prepared = await con.prepare(op.sql)
          bindParams(prepared, op.params)
          await prepared.run()
        }
      } catch {
        // Skip bad records, continue with rest of batch
      }
    }
    await con.run('COMMIT')
  })
}

async function allDirect(sql: string, ...params: any[]): Promise<any[]> {
  if (params.length === 0) {
    const reader = await readCon.runAndReadAll(sql)
    return reader.getRowObjects()
  }
  const prepared = await readCon.prepare(sql)
  bindParams(prepared, params)
  const reader = await prepared.runAndReadAll()
  return reader.getRowObjects()
}

async function all(sql: string, ...params: any[]): Promise<any[]> {
  return enqueue('read', () => allDirect(sql, ...params))
}

export async function initDatabase(
  dbPath: string,
  tableSchemas: TableSchema[],
  ddlStatements: string[],
): Promise<void> {
  instance = await DuckDBInstance.create(dbPath === ':memory:' ? undefined : dbPath)
  con = await instance.connect()
  readCon = await instance.connect()

  for (const schema of tableSchemas) {
    schemas.set(schema.collection, schema)
  }

  for (const ddl of ddlStatements) {
    for (const statement of ddl.split(';').filter((s) => s.trim())) {
      await run(statement)
    }
  }

  // Internal tables for backfill state
  await run(`CREATE TABLE IF NOT EXISTS _repos (
    did TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    handle TEXT,
    backfilled_at TIMESTAMP,
    rev TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    retry_after INTEGER NOT NULL DEFAULT 0
  )`)

  // Migration: add handle column to existing _repos tables
  try {
    await run(`ALTER TABLE _repos ADD COLUMN handle TEXT`)
  } catch {}
  // Re-queue repos with missing handles so backfill populates them
  await run(`UPDATE _repos SET status = 'pending' WHERE handle IS NULL`)

  await run(`CREATE TABLE IF NOT EXISTS _cursor (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`)

  // Labels table (atproto-compatible)
  await run(`CREATE SEQUENCE IF NOT EXISTS _labels_seq START 1`)
  await run(`CREATE TABLE IF NOT EXISTS _labels (
    id INTEGER PRIMARY KEY DEFAULT nextval('_labels_seq'),
    src TEXT NOT NULL,
    uri TEXT NOT NULL,
    val TEXT NOT NULL,
    neg BOOLEAN DEFAULT FALSE,
    cts TIMESTAMP NOT NULL,
    exp TIMESTAMP
  )`)
  await run(`CREATE INDEX IF NOT EXISTS idx_labels_uri ON _labels(uri)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_labels_src ON _labels(src)`)

  // Preferences table (generic key-value per user)
  await run(`CREATE TABLE IF NOT EXISTS _preferences (
    did TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (did, key)
  )`)

  // OAuth tables
  for (const statement of OAUTH_DDL.split(';').filter((s) => s.trim())) {
    await run(statement)
  }
}

export async function getCursor(key: string): Promise<string | null> {
  const rows = await all(`SELECT value FROM _cursor WHERE key = $1`, key)
  return rows[0]?.value || null
}

export async function setCursor(key: string, value: string): Promise<void> {
  await run(`INSERT OR REPLACE INTO _cursor (key, value) VALUES ($1, $2)`, key, value)
}

export async function getRepoStatus(did: string): Promise<string | null> {
  const rows = await all(`SELECT status FROM _repos WHERE did = $1`, did)
  return rows[0]?.status || null
}

export async function setRepoStatus(
  did: string,
  status: string,
  rev?: string,
  opts?: { retryCount?: number; retryAfter?: number; handle?: string | null },
): Promise<void> {
  if (status === 'active') {
    // Update existing row preserving handle if not provided
    await run(
      `UPDATE _repos SET status = $1, handle = COALESCE($2, handle), backfilled_at = $3, rev = COALESCE($4, rev), retry_count = 0, retry_after = 0 WHERE did = $5`,
      status,
      opts?.handle || null,
      new Date().toISOString(),
      rev || null,
      did,
    )
    // Insert if row didn't exist yet
    await run(
      `INSERT OR IGNORE INTO _repos (did, status, handle, backfilled_at, rev, retry_count, retry_after) VALUES ($1, $2, $3, $4, $5, 0, 0)`,
      did,
      status,
      opts?.handle || null,
      new Date().toISOString(),
      rev || null,
    )
  } else if (status === 'failed' && opts) {
    await run(
      `UPDATE _repos SET status = $1, retry_count = $2, retry_after = $3, handle = COALESCE($4, handle) WHERE did = $5`,
      status,
      opts.retryCount ?? 0,
      opts.retryAfter ?? 0,
      opts.handle || null,
      did,
    )
    // If row didn't exist yet, insert it
    await run(
      `INSERT OR IGNORE INTO _repos (did, status, handle, retry_count, retry_after) VALUES ($1, $2, $3, $4, $5)`,
      did,
      status,
      opts.handle || null,
      opts.retryCount ?? 0,
      opts.retryAfter ?? 0,
    )
  } else {
    await run(`UPDATE _repos SET status = $1 WHERE did = $2`, status, did)
    await run(`INSERT OR IGNORE INTO _repos (did, status) VALUES ($1, $2)`, did, status)
  }
}

export async function getRepoRetryInfo(did: string): Promise<{ retryCount: number; retryAfter: number } | null> {
  const rows = await all(`SELECT retry_count, retry_after FROM _repos WHERE did = $1`, did)
  if (rows.length === 0) return null
  return { retryCount: Number(rows[0].retry_count), retryAfter: Number(rows[0].retry_after) }
}

export async function listRetryEligibleRepos(maxRetries: number): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000)
  const rows = await all(
    `SELECT did FROM _repos WHERE status = 'failed' AND retry_after <= $1 AND retry_count < $2`,
    now,
    maxRetries,
  )
  return rows.map((r: any) => r.did)
}

export async function listPendingRepos(): Promise<string[]> {
  const rows = await all(`SELECT did FROM _repos WHERE status = 'pending'`)
  return rows.map((r: any) => r.did)
}

export async function listAllRepoStatuses(): Promise<Array<{ did: string; status: string }>> {
  return (await all(`SELECT did, status FROM _repos`)) as Array<{ did: string; status: string }>
}

export async function listReposPaginated(
  opts: {
    limit?: number
    offset?: number
    status?: string
    q?: string
  } = {},
): Promise<{ repos: any[]; total: number }> {
  const { limit = 50, offset = 0, status, q } = opts
  const conditions: string[] = []
  const params: any[] = []
  let paramIdx = 1

  if (status) {
    conditions.push(`status = $${paramIdx++}`)
    params.push(status)
  }
  if (q) {
    conditions.push(`(did ILIKE $${paramIdx} OR handle ILIKE $${paramIdx})`)
    params.push(`%${q}%`)
    paramIdx++
  }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''

  const countRows = await all(`SELECT COUNT(*)::INTEGER as total FROM _repos${where}`, ...params)
  const total = Number(countRows[0]?.total || 0)

  const rows = await all(
    `SELECT did, handle, status, backfilled_at, rev FROM _repos${where} ORDER BY backfilled_at DESC NULLS LAST, did LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    ...params,
    limit,
    offset,
  )

  return { repos: rows, total }
}

export async function getCollectionCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const [collection, schema] of schemas) {
    const rows = await all(`SELECT COUNT(*)::INTEGER as count FROM ${schema.tableName}`)
    counts[collection] = Number(rows[0]?.count || 0)
  }
  return counts
}

export async function getSchemaDump(): Promise<string> {
  const rows = await all(`SELECT sql FROM duckdb_tables() ORDER BY table_name`)
  return rows.map((r: any) => r.sql + ';').join('\n\n')
}

export function buildInsertOp(
  collection: string,
  uri: string,
  cid: string,
  authorDid: string,
  record: Record<string, any>,
): { sql: string; params: any[] } {
  const schema = schemas.get(collection)
  if (!schema) throw new Error(`Unknown collection: ${collection}`)

  const colNames = ['uri', 'cid', 'did', 'indexed_at']
  const placeholders = ['$1', '$2', '$3', '$4']
  const values: any[] = [uri, cid, authorDid, new Date().toISOString()]

  let paramIdx = 5
  for (const col of schema.columns) {
    let rawValue = record[col.originalName]
    // Handle strongRef expansion: subject_uri reads record.subject.uri, subject__cid reads record.subject.cid
    if (rawValue && typeof rawValue === 'object' && col.name.endsWith('_uri') && col.isRef) {
      rawValue = rawValue.uri
    } else if (col.originalName.endsWith('__cid') && record[col.originalName.replace('__cid', '')]) {
      rawValue = record[col.originalName.replace('__cid', '')].cid
    }
    colNames.push(col.name)
    placeholders.push(`$${paramIdx++}`)

    if (rawValue === undefined || rawValue === null) {
      values.push(null)
    } else if (col.duckdbType === 'JSON') {
      values.push(JSON.stringify(rawValue))
    } else {
      values.push(rawValue)
    }
  }

  const sql = `INSERT OR REPLACE INTO ${schema.tableName} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`
  return { sql, params: values }
}

export async function insertRecord(
  collection: string,
  uri: string,
  cid: string,
  authorDid: string,
  record: Record<string, any>,
): Promise<void> {
  const schema = schemas.get(collection)
  if (!schema) throw new Error(`Unknown collection: ${collection}`)
  const { sql, params } = buildInsertOp(collection, uri, cid, authorDid, record)
  await run(sql, ...params)

  // Insert child table rows
  for (const child of schema.children) {
    const items = record[child.fieldName]
    if (!Array.isArray(items)) continue

    // Delete existing child rows (handles INSERT OR REPLACE on main table)
    await run(`DELETE FROM ${child.tableName} WHERE parent_uri = $1`, uri)

    for (const item of items) {
      const colNames = ['parent_uri', 'parent_did']
      const placeholders = ['$1', '$2']
      const values: any[] = [uri, authorDid]
      let idx = 3

      for (const col of child.columns) {
        colNames.push(col.name)
        placeholders.push(`$${idx++}`)
        const raw = item[col.originalName]
        if (raw === undefined || raw === null) {
          values.push(null)
        } else if (col.duckdbType === 'JSON') {
          values.push(JSON.stringify(raw))
        } else {
          values.push(raw)
        }
      }

      await run(
        `INSERT INTO ${child.tableName} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`,
        ...values,
      )
    }
  }

  // Insert union branch rows
  for (const union of schema.unions) {
    const unionValue = record[union.fieldName]
    if (!unionValue || !unionValue.$type) continue

    const branch = union.branches.find(b => b.type === unionValue.$type)
    if (!branch) continue

    // Delete existing branch rows (handles INSERT OR REPLACE)
    for (const b of union.branches) {
      await run(`DELETE FROM ${b.tableName} WHERE parent_uri = $1`, uri)
    }

    if (branch.isArray && branch.arrayField) {
      // Array branch (e.g., embed.images) — insert one row per array item
      const items = unionValue[branch.arrayField]
      if (!Array.isArray(items)) continue
      for (const item of items) {
        const colNames = ['parent_uri', 'parent_did']
        const placeholders = ['$1', '$2']
        const values: any[] = [uri, authorDid]
        let idx = 3
        for (const col of branch.columns) {
          colNames.push(col.name)
          placeholders.push(`$${idx++}`)
          const raw = item[col.originalName]
          if (raw === undefined || raw === null) {
            values.push(null)
          } else if (col.duckdbType === 'JSON') {
            values.push(JSON.stringify(raw))
          } else {
            values.push(raw)
          }
        }
        await run(
          `INSERT INTO ${branch.tableName} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`,
          ...values,
        )
      }
    } else {
      // Single-value branch — extract data from wrapper or direct properties
      const branchData = resolveBranchData(unionValue, branch)
      const colNames = ['parent_uri', 'parent_did']
      const placeholders = ['$1', '$2']
      const values: any[] = [uri, authorDid]
      let idx = 3
      for (const col of branch.columns) {
        colNames.push(col.name)
        placeholders.push(`$${idx++}`)
        const raw = branchData[col.originalName]
        if (raw === undefined || raw === null) {
          values.push(null)
        } else if (col.duckdbType === 'JSON') {
          values.push(JSON.stringify(raw))
        } else {
          values.push(raw)
        }
      }
      await run(
        `INSERT INTO ${branch.tableName} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`,
        ...values,
      )
    }
  }
}

/** Extract branch data from a union value, handling wrapper properties */
function resolveBranchData(unionValue: any, branch: { wrapperField?: string }): Record<string, any> {
  if (branch.wrapperField) {
    const wrapper = unionValue[branch.wrapperField]
    if (wrapper && typeof wrapper === 'object') return wrapper
  }
  return unionValue
}

export async function deleteRecord(collection: string, uri: string): Promise<void> {
  const schema = schemas.get(collection)
  if (!schema) return
  for (const child of schema.children) {
    await run(`DELETE FROM ${child.tableName} WHERE parent_uri = $1`, uri)
  }
  for (const union of schema.unions) {
    for (const branch of union.branches) {
      await run(`DELETE FROM ${branch.tableName} WHERE parent_uri = $1`, uri)
    }
  }
  await run(`DELETE FROM ${schema.tableName} WHERE uri = $1`, uri)
}

export async function insertLabels(
  labels: Array<{ src: string; uri: string; val: string; neg?: boolean; cts?: string; exp?: string }>,
): Promise<void> {
  if (labels.length === 0) return
  for (const label of labels) {
    // Skip if an active (non-negated, non-expired, not-superseded-by-negation) label already exists
    const existing = await all(
      `SELECT 1 FROM _labels l1 WHERE l1.src = $1 AND l1.uri = $2 AND l1.val = $3 AND l1.neg = false AND (l1.exp IS NULL OR l1.exp > CURRENT_TIMESTAMP) AND NOT EXISTS (SELECT 1 FROM _labels l2 WHERE l2.uri = l1.uri AND l2.val = l1.val AND l2.neg = true AND l2.id > l1.id) LIMIT 1`,
      label.src,
      label.uri,
      label.val,
    )
    if (!label.neg && existing.length > 0) continue

    await run(
      `INSERT INTO _labels (src, uri, val, neg, cts, exp) VALUES ($1, $2, $3, $4, $5, $6)`,
      label.src,
      label.uri,
      label.val,
      label.neg || false,
      label.cts || new Date().toISOString(),
      label.exp || null,
    )
  }
}

export async function queryLabelsForUris(
  uris: string[],
): Promise<
  Map<string, Array<{ src: string; uri: string; val: string; neg: boolean; cts: string; exp: string | null }>>
> {
  if (uris.length === 0) return new Map()
  const placeholders = uris.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all(
    `SELECT src, uri, val, neg, cts, exp FROM _labels l1 WHERE uri IN (${placeholders}) AND (exp IS NULL OR exp > CURRENT_TIMESTAMP) AND neg = false AND NOT EXISTS (SELECT 1 FROM _labels l2 WHERE l2.uri = l1.uri AND l2.val = l1.val AND l2.neg = true AND l2.id > l1.id)`,
    ...uris,
  )
  const result = new Map<string, Array<any>>()
  for (const row of rows) {
    const key = row.uri as string
    if (!result.has(key)) result.set(key, [])
    result.get(key)!.push({
      src: row.src,
      uri: row.uri,
      val: row.val,
      neg: row.neg,
      cts: normalizeValue(row.cts),
      exp: row.exp ? String(row.exp) : null,
    })
  }
  return result
}

export interface BulkRecord {
  collection: string
  uri: string
  cid: string
  did: string
  record: Record<string, any>
}

export async function bulkInsertRecords(records: BulkRecord[]): Promise<number> {
  if (records.length === 0) return 0

  // Group records by collection
  const byCollection = new Map<string, BulkRecord[]>()
  for (const rec of records) {
    const list = byCollection.get(rec.collection) || []
    list.push(rec)
    byCollection.set(rec.collection, list)
  }

  let inserted = 0
  for (const [collection, recs] of byCollection) {
    const schema = schemas.get(collection)
    if (!schema) continue

    const stagingTable = `_staging_${collection.replace(/\./g, '_')}`
    const allCols = ['uri', 'cid', 'did', 'indexed_at', ...schema.columns.map((c) => c.name)]
    const colDefs = [
      'uri TEXT',
      'cid TEXT',
      'did TEXT',
      'indexed_at TEXT',
      ...schema.columns.map((c) => `${c.name} ${c.duckdbType === 'TIMESTAMP' ? 'TEXT' : c.duckdbType}`),
    ]

    // Create staging table + appender + merge all in one write queue slot
    await enqueue('write', async () => {
      await con.run(`DROP TABLE IF EXISTS ${stagingTable}`)
      await con.run(`CREATE TABLE ${stagingTable} (${colDefs.join(', ')})`)

      const appender = await con.createAppender(stagingTable)
      const now = new Date().toISOString()

      for (const rec of recs) {
        try {
          appender.appendVarchar(rec.uri)
          appender.appendVarchar(rec.cid)
          appender.appendVarchar(rec.did)
          appender.appendVarchar(now)

          for (const col of schema.columns) {
            let rawValue = rec.record[col.originalName]
            if (rawValue && typeof rawValue === 'object' && col.name.endsWith('_uri') && col.isRef) {
              rawValue = rawValue.uri
            } else if (col.originalName.endsWith('__cid') && rec.record[col.originalName.replace('__cid', '')]) {
              rawValue = rec.record[col.originalName.replace('__cid', '')].cid
            }

            if (rawValue === undefined || rawValue === null) {
              appender.appendNull()
            } else if (col.duckdbType === 'JSON') {
              appender.appendVarchar(JSON.stringify(rawValue))
            } else if (col.duckdbType === 'INTEGER') {
              appender.appendInteger(typeof rawValue === 'number' ? rawValue : parseInt(rawValue))
            } else if (col.duckdbType === 'BOOLEAN') {
              appender.appendBoolean(!!rawValue)
            } else {
              appender.appendVarchar(String(rawValue))
            }
          }
          appender.endRow()
          inserted++
        } catch {
          // Skip bad records
        }
      }

      appender.flushSync()
      appender.closeSync()

      // Merge into target with TRY_CAST for TIMESTAMP columns, filtering rows that would violate NOT NULL
      const selectCols = allCols.map((name) => {
        const col = schema.columns.find((c) => c.name === name)
        if (name === 'indexed_at' || (col && col.duckdbType === 'TIMESTAMP')) {
          return `TRY_CAST(${name} AS TIMESTAMP) AS ${name}`
        }
        return name
      })
      // Build WHERE clause to exclude rows missing NOT NULL fields
      const notNullChecks: string[] = ['uri IS NOT NULL', 'did IS NOT NULL']
      for (const col of schema.columns) {
        if (col.notNull) {
          if (col.duckdbType === 'TIMESTAMP') {
            notNullChecks.push(`TRY_CAST(${col.name} AS TIMESTAMP) IS NOT NULL`)
          } else {
            notNullChecks.push(`${col.name} IS NOT NULL`)
          }
        }
      }
      const whereClause = notNullChecks.length ? ` WHERE ${notNullChecks.join(' AND ')}` : ''
      await con.run(
        `INSERT OR REPLACE INTO ${schema.tableName} (${allCols.join(', ')}) SELECT ${selectCols.join(', ')} FROM ${stagingTable}${whereClause}`,
      )
      await con.run(`DROP TABLE ${stagingTable}`)

      // Populate child tables
      for (const child of schema.children) {
        const childStagingTable = `_staging_${collection.replace(/\./g, '_')}__${child.fieldName}`
        const childColDefs = [
          'parent_uri TEXT',
          'parent_did TEXT',
          ...child.columns.map((c) => `${c.name} ${c.duckdbType === 'TIMESTAMP' ? 'TEXT' : c.duckdbType}`),
        ]
        const childAllCols = ['parent_uri', 'parent_did', ...child.columns.map((c) => c.name)]

        await con.run(`DROP TABLE IF EXISTS ${childStagingTable}`)
        await con.run(`CREATE TABLE ${childStagingTable} (${childColDefs.join(', ')})`)

        const childAppender = await con.createAppender(childStagingTable)

        for (const rec of recs) {
          const items = rec.record[child.fieldName]
          if (!Array.isArray(items)) continue

          for (const item of items) {
            try {
              childAppender.appendVarchar(rec.uri)
              childAppender.appendVarchar(rec.did)

              for (const col of child.columns) {
                const rawValue = item[col.originalName]
                if (rawValue === undefined || rawValue === null) {
                  childAppender.appendNull()
                } else if (col.duckdbType === 'JSON') {
                  childAppender.appendVarchar(JSON.stringify(rawValue))
                } else if (col.duckdbType === 'INTEGER') {
                  childAppender.appendInteger(typeof rawValue === 'number' ? rawValue : parseInt(rawValue))
                } else if (col.duckdbType === 'BOOLEAN') {
                  childAppender.appendBoolean(!!rawValue)
                } else {
                  childAppender.appendVarchar(String(rawValue))
                }
              }
              childAppender.endRow()
            } catch {
              // Skip bad items
            }
          }
        }

        childAppender.flushSync()
        childAppender.closeSync()

        // Delete existing child rows for these URIs, then merge staging
        const uriPlaceholders = recs.map((_, i) => `$${i + 1}`).join(',')
        const delStmt = await con.prepare(
          `DELETE FROM ${child.tableName} WHERE parent_uri IN (${uriPlaceholders})`,
        )
        bindParams(delStmt, recs.map((r) => r.uri))
        await delStmt.run()

        const childSelectCols = childAllCols.map((name) => {
          const col = child.columns.find((c) => c.name === name)
          if (col && col.duckdbType === 'TIMESTAMP') return `TRY_CAST(${name} AS TIMESTAMP) AS ${name}`
          return name
        })
        await con.run(
          `INSERT INTO ${child.tableName} (${childAllCols.join(', ')}) SELECT ${childSelectCols.join(', ')} FROM ${childStagingTable} WHERE parent_uri IS NOT NULL`,
        )
        await con.run(`DROP TABLE ${childStagingTable}`)
      }

      // Populate union branch tables
      for (const union of schema.unions) {
        for (const branch of union.branches) {
          const branchStagingTable = `_staging_${collection.replace(/\./g, '_')}__${toSnakeCase(union.fieldName)}_${branch.branchName}`
          const branchColDefs = [
            'parent_uri TEXT',
            'parent_did TEXT',
            ...branch.columns.map((c) => `${c.name} ${c.duckdbType === 'TIMESTAMP' ? 'TEXT' : c.duckdbType}`),
          ]
          const branchAllCols = ['parent_uri', 'parent_did', ...branch.columns.map((c) => c.name)]

          await con.run(`DROP TABLE IF EXISTS ${branchStagingTable}`)
          await con.run(`CREATE TABLE ${branchStagingTable} (${branchColDefs.join(', ')})`)

          const branchAppender = await con.createAppender(branchStagingTable)

          for (const rec of recs) {
            const unionValue = rec.record[union.fieldName]
            if (!unionValue || typeof unionValue !== 'object') continue
            if (unionValue.$type !== branch.type) continue

            if (branch.isArray && branch.arrayField) {
              const items = resolveBranchData(unionValue, branch)[branch.arrayField]
              if (!Array.isArray(items)) continue
              for (const item of items) {
                try {
                  branchAppender.appendVarchar(rec.uri)
                  branchAppender.appendVarchar(rec.did)
                  for (const col of branch.columns) {
                    const rawValue = item[col.originalName]
                    if (rawValue === undefined || rawValue === null) {
                      branchAppender.appendNull()
                    } else if (col.duckdbType === 'JSON') {
                      branchAppender.appendVarchar(JSON.stringify(rawValue))
                    } else if (col.duckdbType === 'INTEGER') {
                      branchAppender.appendInteger(typeof rawValue === 'number' ? rawValue : parseInt(rawValue))
                    } else if (col.duckdbType === 'BOOLEAN') {
                      branchAppender.appendBoolean(!!rawValue)
                    } else {
                      branchAppender.appendVarchar(String(rawValue))
                    }
                  }
                  branchAppender.endRow()
                } catch {
                  // Skip bad items
                }
              }
            } else {
              try {
                const branchData = resolveBranchData(unionValue, branch)
                branchAppender.appendVarchar(rec.uri)
                branchAppender.appendVarchar(rec.did)
                for (const col of branch.columns) {
                  const rawValue = branchData[col.originalName]
                  if (rawValue === undefined || rawValue === null) {
                    branchAppender.appendNull()
                  } else if (col.duckdbType === 'JSON') {
                    branchAppender.appendVarchar(JSON.stringify(rawValue))
                  } else if (col.duckdbType === 'INTEGER') {
                    branchAppender.appendInteger(typeof rawValue === 'number' ? rawValue : parseInt(rawValue))
                  } else if (col.duckdbType === 'BOOLEAN') {
                    branchAppender.appendBoolean(!!rawValue)
                  } else {
                    branchAppender.appendVarchar(String(rawValue))
                  }
                }
                branchAppender.endRow()
              } catch {
                // Skip bad records
              }
            }
          }

          branchAppender.flushSync()
          branchAppender.closeSync()

          // Delete existing branch rows for these URIs, then merge staging
          const uriPlaceholders = recs.map((_, i) => `$${i + 1}`).join(',')
          const delStmt = await con.prepare(
            `DELETE FROM ${branch.tableName} WHERE parent_uri IN (${uriPlaceholders})`,
          )
          bindParams(delStmt, recs.map((r) => r.uri))
          await delStmt.run()

          const branchSelectCols = branchAllCols.map((name) => {
            const col = branch.columns.find((c) => c.name === name)
            if (col && col.duckdbType === 'TIMESTAMP') return `TRY_CAST(${name} AS TIMESTAMP) AS ${name}`
            return name
          })
          await con.run(
            `INSERT INTO ${branch.tableName} (${branchAllCols.join(', ')}) SELECT ${branchSelectCols.join(', ')} FROM ${branchStagingTable} WHERE parent_uri IS NOT NULL`,
          )
          await con.run(`DROP TABLE ${branchStagingTable}`)
        }
      }
    })
  }

  return inserted
}

interface QueryOpts {
  limit?: number
  cursor?: string
  filters?: Record<string, string>
  sort?: string
  order?: 'asc' | 'desc'
}

export async function queryRecords(
  collection: string,
  opts: QueryOpts = {},
): Promise<{ records: any[]; cursor?: string }> {
  const schema = schemas.get(collection)
  if (!schema) throw new Error(`Unknown collection: ${collection}`)

  const { limit = 20, cursor, filters, sort = 'indexed_at', order = 'desc' } = opts

  // Validate sort field exists
  const sortCol =
    sort === 'indexed_at' ? 'indexed_at' : schema.columns.find((c) => c.originalName === sort || c.name === sort)
  const sortName = typeof sortCol === 'string' ? sortCol : sortCol?.name
  if (!sortName) throw new Error(`Invalid sort field: ${sort}`)

  const conditions: string[] = []
  const params: any[] = []
  let paramIdx = 1

  // Cursor pagination — compound keyset (sortCol, cid)
  if (cursor) {
    const parsed = unpackCursor(cursor)
    if (parsed) {
      const op = order === 'desc' ? '<' : '>'
      const pSort1 = `$${paramIdx++}`
      const pSort2 = `$${paramIdx++}`
      const pCid = `$${paramIdx++}`
      conditions.push(`(t.${sortName} ${op} ${pSort1} OR (t.${sortName} = ${pSort2} AND t.cid ${op} ${pCid}))`)
      params.push(parsed.primary, parsed.primary, parsed.cid)
    }
  }

  // Field filters — validate each against schema
  if (filters) {
    const validColumns = new Set(schema.columns.map((c) => c.name))
    validColumns.add('did')
    for (const [key, value] of Object.entries(filters)) {
      const colName = toSnakeCase(key)
      if (!validColumns.has(colName)) continue // silently skip invalid filters
      conditions.push(`t.${colName} = $${paramIdx++}`)
      params.push(value)
    }
  }

  let sql = `SELECT t.*, r.handle FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did WHERE (r.status IS NULL OR r.status != 'takendown')`
  if (conditions.length) sql += ' AND ' + conditions.join(' AND ')
  sql += ` ORDER BY t.${sortName} ${order.toUpperCase()}, t.cid ${order.toUpperCase()} LIMIT $${paramIdx++}`
  params.push(limit + 1) // fetch one extra for cursor

  const rows = await all(sql, ...params)
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  // Attach child data if this collection has decomposed arrays
  if (schema.children.length > 0 && rows.length > 0) {
    const uris = rows.map((r: any) => r.uri)
    const childData = new Map<string, Map<string, any[]>>()
    for (const child of schema.children) {
      const childRows = await getChildRows(child.tableName, uris)
      childData.set(child.fieldName, childRows)
    }
    for (const row of rows) {
      (row as any).__childData = childData
    }
  }

  // Attach union branch data
  if (schema.unions.length > 0 && rows.length > 0) {
    const uris = rows.map((r: any) => r.uri)
    const unionData = new Map<string, Map<string, Map<string, any[]>>>()
    for (const union of schema.unions) {
      const branchData = new Map<string, Map<string, any[]>>()
      for (const branch of union.branches) {
        const branchRows = await getChildRows(branch.tableName, uris)
        branchData.set(branch.branchName, branchRows)
      }
      unionData.set(union.fieldName, branchData)
    }
    for (const row of rows) {
      (row as any).__unionData = unionData
    }
  }

  const lastRow = rows[rows.length - 1]
  const nextCursor = hasMore && lastRow ? packCursor(lastRow[sortName], lastRow.cid) : undefined

  return { records: rows, cursor: nextCursor }
}

export async function getRecordByUri(uri: string): Promise<any | null> {
  for (const [_collection, schema] of schemas) {
    const rows = await all(
      `SELECT t.*, r.handle FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did WHERE t.uri = $1 AND (r.status IS NULL OR r.status != 'takendown')`,
      uri,
    )
    if (rows.length > 0) {
      const row = rows[0]
      if (schema.children.length > 0) {
        const childData = new Map<string, Map<string, any[]>>()
        for (const child of schema.children) {
          const childRows = await getChildRows(child.tableName, [uri])
          childData.set(child.fieldName, childRows)
        }
        ;(row as any).__childData = childData
      }
      if (schema.unions.length > 0) {
        const unionData = new Map<string, Map<string, Map<string, any[]>>>()
        for (const union of schema.unions) {
          const branchData = new Map<string, Map<string, any[]>>()
          for (const branch of union.branches) {
            const branchRows = await getChildRows(branch.tableName, [uri])
            branchData.set(branch.branchName, branchRows)
          }
          unionData.set(union.fieldName, branchData)
        }
        ;(row as any).__unionData = unionData
      }
      return row
    }
  }
  return null
}

export async function getRecordsByUris(collection: string, uris: string[]): Promise<any[]> {
  if (uris.length === 0) return []
  const schema = schemas.get(collection)
  if (!schema) return []
  const placeholders = uris.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all(
    `SELECT t.*, r.handle FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did WHERE t.uri IN (${placeholders}) AND (r.status IS NULL OR r.status != 'takendown')`,
    ...uris,
  )

  // Batch-fetch child rows for all URIs
  const childData = new Map<string, Map<string, any[]>>()
  for (const child of schema.children) {
    const childRows = await getChildRows(child.tableName, uris)
    childData.set(child.fieldName, childRows)
  }

  // Batch-fetch union branch rows for all URIs
  const unionData = new Map<string, Map<string, Map<string, any[]>>>()
  for (const union of schema.unions) {
    const branchData = new Map<string, Map<string, any[]>>()
    for (const branch of union.branches) {
      const branchRows = await getChildRows(branch.tableName, uris)
      branchData.set(branch.branchName, branchRows)
    }
    unionData.set(union.fieldName, branchData)
  }

  // Attach child data to rows for reshapeRow
  for (const row of rows) {
    (row as any).__childData = childData
    if (unionData.size > 0) (row as any).__unionData = unionData
  }

  // Preserve ordering
  const byUri = new Map(rows.map((r: any) => [r.uri, r]))
  return uris.map((u) => byUri.get(u)).filter(Boolean)
}

/**
 * Multi-phase search across any collection's records.
 *
 * 1. **BM25** — Full-text search via DuckDB FTS. Multi-word queries use conjunctive
 *    mode (ALL terms required) to avoid spurious single-token matches.
 * 2. **Exact substring** — ILIKE scan on all TEXT/JSON columns catches phrase matches
 *    that BM25 missed or ranked low (e.g. "bad bunny"). Results are prepended to BM25.
 * 3. **Recent rows** — ILIKE scan of rows ingested since the last FTS rebuild, so newly
 *    written records are immediately searchable before the index catches up.
 * 4. **Fuzzy** — Jaro-Winkler similarity fallback for typo tolerance when earlier phases
 *    return fewer than `limit` results.
 *
 * All phases derive searchable columns generically from the collection schema — no
 * column names are hardcoded.
 */
export async function searchRecords(
  collection: string,
  query: string,
  opts: { limit?: number; cursor?: string; fuzzy?: boolean } = {},
): Promise<{ records: any[]; cursor?: string }> {
  const schema = schemas.get(collection)
  if (!schema) throw new Error(`Unknown collection: ${collection}`)

  const elapsed = timer()
  const { limit = 20, cursor, fuzzy = true } = opts
  const textCols = schema.columns.filter((c) => c.duckdbType === 'TEXT')

  // Also check if FTS has indexed any columns (including derived JSON columns)
  const ftsSearchCols = getSearchColumns(collection)
  if (textCols.length === 0 && ftsSearchCols.length === 0) {
    throw new Error(`No searchable columns in ${collection}`)
  }

  // FTS shadow table name (dots replaced with underscores)
  const safeName = '_fts_' + collection.replace(/\./g, '_')
  const ftsSchema = `fts_main_${safeName}`

  const phaseErrors: string[] = []
  const phasesUsed: string[] = []

  // Phase 1: BM25 ranked search on FTS shadow table
  let bm25Results: any[] = []
  try {
    let paramIdx = 1

    const ftsQuery = stripStopWords(query)
    const isMultiWord = ftsQuery.split(/\s+/).length > 1
    const conjunctiveFlag = isMultiWord ? ', conjunctive := 1' : ''
    let sql = `SELECT m.*, ${ftsSchema}.match_bm25(s.uri, $${paramIdx++}${conjunctiveFlag}) AS score
      FROM ${safeName} s
      JOIN ${schema.tableName} m ON m.uri = s.uri
      LEFT JOIN _repos r ON m.did = r.did
      WHERE score IS NOT NULL
      AND (r.status IS NULL OR r.status != 'takendown')`

    const params: any[] = [ftsQuery]

    if (cursor) {
      const parsed = unpackCursor(cursor)
      if (parsed) {
        const pScore1 = `$${paramIdx++}`
        const pScore2 = `$${paramIdx++}`
        const pCid = `$${paramIdx++}`
        sql += ` AND (score > ${pScore1} OR (score = ${pScore2} AND m.cid < ${pCid}))`
        params.push(parsed.primary, parsed.primary, parsed.cid)
      }
    }

    sql += ` ORDER BY score, m.cid DESC LIMIT $${paramIdx++}`
    params.push(limit + 1)

    bm25Results = await all(sql, ...params)
    phasesUsed.push('bm25')
  } catch (err: any) {
    phaseErrors.push(`bm25: ${err.message}`)
  }

  const bm25Count = bm25Results.length
  const hasMore = bm25Results.length > limit
  if (hasMore) bm25Results.pop()

  // Phase 2: Exact substring match — boosts phrase matches above BM25 results
  const exactMatchResults: any[] = []
  const bm25Uris = new Set(bm25Results.map((r: any) => r.uri))
  try {
    const searchParam = `%${query}%`
    let paramIdx = 1
    const ilikeConds: string[] = []
    const params: any[] = []

    // TEXT columns — direct ILIKE
    for (const c of textCols) {
      ilikeConds.push(`t.${c.name} ILIKE $${paramIdx++}`)
      params.push(searchParam)
    }

    // JSON columns — cast to text then ILIKE
    const jsonCols = schema.columns.filter((c) => c.duckdbType === 'JSON')
    for (const c of jsonCols) {
      ilikeConds.push(`CAST(t.${c.name} AS TEXT) ILIKE $${paramIdx++}`)
      params.push(searchParam)
    }

    // Handle from _repos table
    ilikeConds.push(`r.handle ILIKE $${paramIdx++}`)
    params.push(searchParam)

    if (ilikeConds.length > 0) {
      const exactSQL = `SELECT t.* FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did
        WHERE (${ilikeConds.join(' OR ')})
        ORDER BY t.indexed_at DESC
        LIMIT $${paramIdx++}`
      params.push(limit)

      const rows = await all(exactSQL, ...params)
      phasesUsed.push('exact')
      for (const row of rows) {
        if (!bm25Uris.has(row.uri)) {
          exactMatchResults.push(row)
          bm25Uris.add(row.uri)
        }
      }
    }
  } catch (err: any) {
    phaseErrors.push(`exact: ${err.message}`)
  }

  // Merge: exact matches first, then BM25 results, capped at limit
  const mergedResults = [...exactMatchResults, ...bm25Results].slice(0, limit + (hasMore ? 1 : 0))
  // Replace bm25Results with merged for downstream phases
  bm25Results = mergedResults

  // Phase 3: ILIKE scan of rows written since last FTS rebuild (immediate searchability)
  const existingUris = new Set(bm25Results.map((r: any) => r.uri))

  const { getLastRebuiltAt } = await import('./fts.ts')
  const rebuiltAt = getLastRebuiltAt(collection)
  let recentCount = 0

  if (rebuiltAt && bm25Results.length < limit) {
    const remaining = limit - bm25Results.length
    const searchParam = `%${query}%`
    let paramIdx = 1
    const ilikeParts = textCols.map((c) => `t.${c.name} ILIKE $${paramIdx++}`)
    ilikeParts.push(`r.handle ILIKE $${paramIdx++}`)
    const ilikeConds = ilikeParts.join(' OR ')
    const params: any[] = [...textCols.map(() => searchParam), searchParam]

    const recentSQL = `SELECT t.* FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did
      WHERE t.indexed_at >= $${paramIdx++} AND t.uri NOT IN (SELECT uri FROM ${safeName}) AND (${ilikeConds})
      ORDER BY t.indexed_at DESC
      LIMIT $${paramIdx++}`
    params.push(rebuiltAt, remaining + existingUris.size)

    try {
      const recentRows = await all(recentSQL, ...params)
      phasesUsed.push('recent')
      for (const row of recentRows) {
        if (bm25Results.length >= limit) break
        if (!existingUris.has(row.uri)) {
          existingUris.add(row.uri)
          bm25Results.push(row)
          recentCount++
        }
      }
    } catch (err: any) {
      phaseErrors.push(`recent: ${err.message}`)
    }
  }

  // Phase 4: Fuzzy fallback for typo tolerance (if still under limit)
  let fuzzyCount = 0
  if (fuzzy && bm25Results.length < limit) {
    const remaining = limit - bm25Results.length
    const simExprs = [
      ...textCols.map((c) => `jaro_winkler_similarity(lower(t.${c.name}), lower($1))`),
      `jaro_winkler_similarity(lower(r.handle), lower($1))`,
    ]
    // Include child table TEXT columns via correlated subquery
    for (const child of schema.children) {
      for (const col of child.columns) {
        if (col.duckdbType === 'TEXT') {
          simExprs.push(
            `COALESCE((SELECT MAX(jaro_winkler_similarity(lower(c.${col.name}), lower($1))) FROM ${child.tableName} c WHERE c.parent_uri = t.uri), 0)`,
          )
        }
      }
    }
    const greatestExpr = `GREATEST(${simExprs.join(', ')})`
    const fuzzySQL = `SELECT t.*, ${greatestExpr} AS fuzzy_score
      FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did
      WHERE ${greatestExpr} >= 0.8
      ORDER BY fuzzy_score DESC
      LIMIT $2`

    try {
      const fuzzyRows = await all(fuzzySQL, query, remaining + existingUris.size)
      phasesUsed.push('fuzzy')
      for (const row of fuzzyRows) {
        if (bm25Results.length >= limit) break
        if (!existingUris.has(row.uri)) {
          bm25Results.push(row)
          fuzzyCount++
        }
      }
    } catch (err: any) {
      phaseErrors.push(`fuzzy: ${err.message}`)
    }
  }

  // Remove score columns from results
  const records = bm25Results.map(({ score: _score, fuzzy_score: _fuzzy_score, ...rest }: any) => rest)

  const lastRow = bm25Results[bm25Results.length - 1]
  const nextCursor = hasMore && lastRow?.score != null ? packCursor(lastRow.score, lastRow.cid) : undefined

  emit('search', 'query', {
    collection,
    query,
    bm25_count: bm25Count > limit ? bm25Count - 1 : bm25Count,
    exact_count: exactMatchResults.length,
    recent_count: recentCount,
    fuzzy_count: fuzzyCount,
    total_results: records.length,
    duration_ms: elapsed(),
    phases_used: phasesUsed.join(','),
    error: phaseErrors.length > 0 ? phaseErrors.join('; ') : undefined,
  })

  return { records, cursor: nextCursor }
}

// Raw SQL for script feeds
export async function querySQL(sql: string, params: any[] = []): Promise<any[]> {
  return all(sql, ...params)
}

export async function runSQL(sql: string, ...params: any[]): Promise<void> {
  return run(sql, ...params)
}

export function getSchema(collection: string): TableSchema | undefined {
  return schemas.get(collection)
}

export async function countByField(collection: string, field: string, value: string): Promise<number> {
  const schema = schemas.get(collection)
  if (!schema) return 0
  const rows = await all(`SELECT COUNT(*) as count FROM ${schema.tableName} WHERE ${field} = $1`, value)
  return Number(rows[0]?.count || 0)
}

export async function countByFieldBatch(
  collection: string,
  field: string,
  values: string[],
): Promise<Map<string, number>> {
  if (values.length === 0) return new Map()
  const schema = schemas.get(collection)
  if (!schema) return new Map()
  const placeholders = values.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all(
    `SELECT ${field}, COUNT(*) as count FROM ${schema.tableName} WHERE ${field} IN (${placeholders}) GROUP BY ${field}`,
    ...values,
  )
  const result = new Map<string, number>()
  for (const row of rows) {
    result.set(row[field], Number(row.count))
  }
  return result
}

export async function findByField(collection: string, field: string, value: string): Promise<any | null> {
  const schema = schemas.get(collection)
  if (!schema) return null
  const rows = await all(`SELECT * FROM ${schema.tableName} WHERE ${field} = $1 LIMIT 1`, value)
  return rows[0] || null
}

export async function findByFieldBatch(
  collection: string,
  field: string,
  values: string[],
): Promise<Map<string, any[]>> {
  if (values.length === 0) return new Map()
  const schema = schemas.get(collection)
  if (!schema) return new Map()
  const placeholders = values.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all(
    `SELECT t.*, r.handle FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did WHERE t.${field} IN (${placeholders})`,
    ...values,
  )
  // Attach child data if this collection has decomposed arrays
  if (schema.children.length > 0 && rows.length > 0) {
    const uris = rows.map((r: any) => r.uri)
    const childData = new Map<string, Map<string, any[]>>()
    for (const child of schema.children) {
      const childRows = await getChildRows(child.tableName, uris)
      childData.set(child.fieldName, childRows)
    }
    for (const row of rows) {
      (row as any).__childData = childData
    }
  }

  const result = new Map<string, any[]>()
  for (const row of rows) {
    const key = row[field]
    if (!result.has(key)) result.set(key, [])
    result.get(key)!.push(row)
  }
  return result
}

export async function lookupByFieldBatch(
  collection: string,
  field: string,
  values: string[],
): Promise<Map<string, Row<unknown>>> {
  if (values.length === 0) return new Map()
  const results = await findByFieldBatch(collection, field, values)
  const map = new Map<string, Row<unknown>>()
  for (const [key, records] of results) {
    const shaped = records.length > 0 ? reshapeRow(records[0], records[0]?.__childData) : null
    if (shaped) map.set(key, shaped)
  }
  return map
}

export async function findUriByFields(
  collection: string,
  conditions: { field: string; value: string }[],
): Promise<string | null> {
  const schema = schemas.get(collection)
  if (!schema) return null
  const where = conditions.map((c, i) => `${c.field} = $${i + 1}`).join(' AND ')
  const params = conditions.map((c) => c.value)
  const rows = await all(`SELECT uri FROM ${schema.tableName} WHERE ${where} LIMIT 1`, ...params)
  return rows[0]?.uri || null
}

const ENVELOPE_KEYS = new Set(['uri', 'cid', 'did', 'handle', 'indexed_at'])
const INTERNAL_KEYS = new Set(['__childData', '__unionData'])

export function normalizeValue(v: any): any {
  if (v && typeof v === 'object' && 'micros' in v) return new Date(Number(v.micros) / 1000).toISOString()
  if (typeof v === 'bigint') return Number(v)
  return v
}

export async function getChildRows(
  childTableName: string,
  parentUris: string[],
): Promise<Map<string, any[]>> {
  if (parentUris.length === 0) return new Map()
  const placeholders = parentUris.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all(
    `SELECT * FROM ${childTableName} WHERE parent_uri IN (${placeholders})`,
    ...parentUris,
  )
  const result = new Map<string, any[]>()
  for (const row of rows) {
    const key = row.parent_uri as string
    if (!result.has(key)) result.set(key, [])
    result.get(key)!.push(row)
  }
  return result
}

export function reshapeRow(
  row: any,
  childData?: Map<string, Map<string, any[]>>,
  unionData?: Map<string, Map<string, Map<string, any[]>>>,
): Row<unknown> | null {
  if (!row) return null
  // Derive collection from URI (at://did/collection/rkey)
  const collection = row.uri?.split('/')?.[3]
  const schema = collection ? schemas.get(collection) : null
  // Build snake→camel map and JSON column set from schema
  const nameMap = new Map<string, string>()
  const jsonCols = new Set<string>()
  if (schema) {
    for (const col of schema.columns) {
      nameMap.set(col.name, col.originalName)
      if (col.duckdbType === 'JSON') jsonCols.add(col.name)
    }
  }

  const value: Record<string, unknown> = {}
  const envelope: Record<string, unknown> = {}
  for (const [key, rawVal] of Object.entries(row)) {
    const val = normalizeValue(rawVal)
    if (INTERNAL_KEYS.has(key)) {
      continue
    } else if (ENVELOPE_KEYS.has(key)) {
      envelope[key] = val
    } else {
      const originalKey = nameMap.get(key) || key
      if (jsonCols.has(key) && typeof val === 'string') {
        try {
          value[originalKey] = JSON.parse(val)
        } catch {
          value[originalKey] = val
        }
      } else {
        value[originalKey] = val
      }
    }
  }

  // Reconstruct decomposed array fields from child data
  if (schema && childData) {
    for (const child of schema.children) {
      const childMap = childData.get(child.fieldName)
      const childRows = childMap?.get(row.uri) || []
      value[child.fieldName] = childRows.map((cr) => {
        const item: Record<string, unknown> = {}
        for (const col of child.columns) {
          const raw = cr[col.name]
          item[col.originalName] = normalizeValue(raw)
        }
        return item
      })
    }
  }

  // Reconstruct union fields from branch data
  const uData = unionData || (row as any).__unionData
  if (schema && uData) {
    for (const union of schema.unions) {
      const branchDataMap = uData.get(union.fieldName)
      if (!branchDataMap) continue

      // Find which branch has rows for this URI (implicit discrimination)
      for (const branch of union.branches) {
        const branchMap = branchDataMap.get(branch.branchName)
        const branchRows = branchMap?.get(row.uri)
        if (!branchRows || branchRows.length === 0) continue

        if (branch.isArray && branch.arrayField) {
          // Array branch: reconstruct { $type, arrayField: [...items] }
          const items = branchRows.map((br: any) => {
            const item: Record<string, unknown> = {}
            for (const col of branch.columns) {
              item[col.originalName] = normalizeValue(br[col.name])
            }
            return item
          })
          value[union.fieldName] = { $type: branch.type, [branch.arrayField]: items }
        } else {
          // Single-value branch: reconstruct { $type, ...properties }
          // If branchName matches a wrapper property pattern, nest under it
          const br = branchRows[0]
          const props: Record<string, unknown> = {}
          for (const col of branch.columns) {
            props[col.originalName] = normalizeValue(br[col.name])
          }

          if (branch.wrapperField) {
            value[union.fieldName] = { $type: branch.type, [branch.wrapperField]: props }
          } else {
            value[union.fieldName] = { $type: branch.type, ...props }
          }
        }
        break // Only one branch should match
      }
    }
  }

  return { ...envelope, value } as Row<unknown>
}

export function packCursor(sortVal: unknown, cid: string): string {
  const primary = sortVal instanceof Date ? sortVal.toISOString() : String(sortVal)
  return Buffer.from(`${primary}::${cid}`).toString('base64url')
}

export function unpackCursor(cursor: string): { primary: string; cid: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString()
    const idx = decoded.lastIndexOf('::')
    if (idx === -1) return null
    return { primary: decoded.substring(0, idx), cid: decoded.substring(idx + 2) }
  } catch {
    return null
  }
}

export async function queryLabelsByDid(did: string): Promise<any[]> {
  return all(
    `SELECT * FROM _labels WHERE uri LIKE $1 AND neg = false AND (exp IS NULL OR exp > CURRENT_TIMESTAMP)`,
    `at://${did}/%`,
  )
}

export async function searchAccounts(query: string, limit: number = 20): Promise<any[]> {
  return all(
    `SELECT did, handle, status FROM _repos WHERE did ILIKE $1 OR handle ILIKE $1 ORDER BY handle LIMIT $2`,
    `%${query}%`,
    limit,
  )
}

export async function getAccountRecordCount(did: string): Promise<number> {
  let total = 0
  for (const [, schema] of schemas) {
    const rows = await all(`SELECT COUNT(*) as count FROM ${schema.tableName} WHERE did = $1`, did)
    total += Number(rows[0]?.count || 0)
  }
  return total
}

export async function getAllRecordUrisForDid(did: string): Promise<string[]> {
  const uris: string[] = []
  for (const [, schema] of schemas) {
    const rows = await all(`SELECT uri FROM ${schema.tableName} WHERE did = $1`, did)
    uris.push(...rows.map((r: any) => r.uri))
  }
  return uris
}

export async function isTakendownDid(did: string): Promise<boolean> {
  const rows = await all(`SELECT 1 FROM _repos WHERE did = $1 AND status = 'takendown' LIMIT 1`, did)
  return rows.length > 0
}

export async function getPreferences(did: string): Promise<Record<string, any>> {
  const rows = await all(`SELECT key, value FROM _preferences WHERE did = $1`, did)
  const prefs: Record<string, any> = {}
  for (const row of rows) {
    try {
      prefs[row.key as string] = typeof row.value === 'string' ? JSON.parse(row.value as string) : row.value
    } catch {
      prefs[row.key as string] = row.value
    }
  }
  return prefs
}

export async function putPreference(did: string, key: string, value: any): Promise<void> {
  await run(
    `INSERT OR REPLACE INTO _preferences (did, key, value, updated_at) VALUES ($1, $2, $3, $4)`,
    did,
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  )
}

export async function filterTakendownDids(dids: string[]): Promise<Set<string>> {
  if (dids.length === 0) return new Set()
  const placeholders = dids.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all(`SELECT did FROM _repos WHERE did IN (${placeholders}) AND status = 'takendown'`, ...dids)
  return new Set(rows.map((r: any) => r.did))
}

export async function backfillChildTables(): Promise<void> {
  for (const [collection, schema] of schemas) {
    for (const child of schema.children) {
      // Check if child table needs backfill (significantly fewer rows than parent)
      const mainCount = (await all(`SELECT COUNT(*)::INTEGER as n FROM ${schema.tableName}`))[0]?.n || 0
      if (mainCount === 0) continue
      const childCount = (await all(`SELECT COUNT(DISTINCT parent_uri)::INTEGER as n FROM ${child.tableName}`))[0]?.n || 0
      if (childCount >= mainCount * 0.9) continue

      console.log(`[db] Backfilling ${child.tableName} from ${schema.tableName}...`)

      const snakeField = toSnakeCase(child.fieldName)
      const childColSelects = child.columns
        .map((c) => `json_extract_string(item.val, '$.${c.originalName}')`)
        .join(', ')
      const childColNames = ['parent_uri', 'parent_did', ...child.columns.map((c) => c.name)]

      const notNullFilters = child.columns
        .filter((c) => c.notNull)
        .map((c) => `json_extract_string(item.val, '$.${c.originalName}') IS NOT NULL`)

      const whereClause = [`p.${snakeField} IS NOT NULL`, ...notNullFilters].join(' AND ')

      try {
        await run(`DELETE FROM ${child.tableName}`)
        await run(`
          INSERT INTO ${child.tableName} (${childColNames.join(', ')})
          SELECT p.uri, p.did, ${childColSelects}
          FROM ${schema.tableName} p,
               unnest(from_json(p.${snakeField}::JSON, '["json"]')) AS item(val)
          WHERE ${whereClause}
        `)
        const result = await all(`SELECT COUNT(*)::INTEGER as n FROM ${child.tableName}`)
        console.log(`[db] Backfilled ${child.tableName}: ${result[0]?.n || 0} rows`)
      } catch (err: any) {
        console.warn(`[db] Backfill skipped for ${child.tableName}: ${err.message}`)
      }
    }
  }
}
