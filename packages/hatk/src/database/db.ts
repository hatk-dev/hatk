import { type TableSchema, toSnakeCase, q } from './schema.ts'
import type { Row } from '../lex-types.ts'
import { getSearchColumns, stripStopWords, getSearchPort, updateFtsRecord, deleteFtsRecord } from './fts.ts'
import { emit, timer } from '../logger.ts'
import { OAUTH_DDL } from '../oauth/db.ts'
import type { DatabasePort } from './ports.ts'
import { getDialect, type SqlDialect } from './dialect.ts'

let port: DatabasePort
let dialect: SqlDialect
const schemas = new Map<string, TableSchema>()

export function getDatabasePort(): DatabasePort {
  return port
}
export function getSqlDialect(): SqlDialect {
  return dialect
}

export function closeDatabase(): void {
  port?.close()
}

async function run(sql: string, params: unknown[] = []): Promise<void> {
  return port.execute(sql, params)
}

export async function runBatch(operations: Array<{ sql: string; params: unknown[] }>): Promise<void> {
  await port.beginTransaction()
  try {
    for (const op of operations) {
      try {
        await port.execute(op.sql, op.params)
      } catch {
        // Skip bad records, continue with rest of batch
      }
    }
    await port.commit()
  } catch {
    await port.rollback()
  }
}

async function all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  return port.query<T>(sql, params)
}

export async function initDatabase(
  adapter: DatabasePort,
  dbPath: string,
  tableSchemas: TableSchema[],
  ddlStatements: string[],
): Promise<void> {
  port = adapter
  dialect = getDialect(adapter.dialect)

  await port.open(dbPath)

  for (const schema of tableSchemas) {
    schemas.set(schema.collection, schema)
  }

  for (const ddl of ddlStatements) {
    await port.executeMultiple(ddl)
  }

  // Internal tables for backfill state
  await run(`CREATE TABLE IF NOT EXISTS _repos (
    did TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    handle TEXT,
    backfilled_at ${dialect.timestampType},
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
  if (dialect.supportsSequences) {
    await run(`CREATE SEQUENCE IF NOT EXISTS _labels_seq START 1`)
    await run(`CREATE TABLE IF NOT EXISTS _labels (
      id INTEGER PRIMARY KEY DEFAULT nextval('_labels_seq'),
      src TEXT NOT NULL,
      uri TEXT NOT NULL,
      val TEXT NOT NULL,
      neg ${dialect.typeMap.boolean} DEFAULT FALSE,
      cts ${dialect.timestampType} NOT NULL,
      exp ${dialect.timestampType}
    )`)
  } else {
    await run(`CREATE TABLE IF NOT EXISTS _labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src TEXT NOT NULL,
      uri TEXT NOT NULL,
      val TEXT NOT NULL,
      neg INTEGER DEFAULT 0,
      cts TEXT NOT NULL,
      exp TEXT
    )`)
  }
  await run(`CREATE INDEX IF NOT EXISTS idx_labels_uri ON _labels(uri)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_labels_src ON _labels(src)`)

  // Preferences table (generic key-value per user)
  await run(`CREATE TABLE IF NOT EXISTS _preferences (
    did TEXT NOT NULL,
    key TEXT NOT NULL,
    value ${dialect.jsonType} NOT NULL,
    updated_at ${dialect.timestampType} DEFAULT ${dialect.currentTimestamp},
    PRIMARY KEY (did, key)
  )`)

  // Reports table (user-submitted moderation reports)
  if (dialect.supportsSequences) {
    await run(`CREATE SEQUENCE IF NOT EXISTS _reports_seq START 1`)
    await run(`CREATE TABLE IF NOT EXISTS _reports (
      id INTEGER PRIMARY KEY DEFAULT nextval('_reports_seq'),
      subject_uri TEXT NOT NULL,
      subject_did TEXT NOT NULL,
      label TEXT NOT NULL,
      reason TEXT,
      reported_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT,
      resolved_at ${dialect.timestampType},
      created_at ${dialect.timestampType} NOT NULL
    )`)
  } else {
    await run(`CREATE TABLE IF NOT EXISTS _reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_uri TEXT NOT NULL,
      subject_did TEXT NOT NULL,
      label TEXT NOT NULL,
      reason TEXT,
      reported_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    )`)
  }
  await run(`CREATE INDEX IF NOT EXISTS idx_reports_status ON _reports(status)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_reports_subject_uri ON _reports(subject_uri)`)

  // Push notification tokens
  await run(`CREATE TABLE IF NOT EXISTS _push_tokens (
    did TEXT NOT NULL,
    token TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (did, token)
  )`)

  // OAuth tables
  await port.executeMultiple(OAUTH_DDL)

  // Migrations: add pds_auth_server to existing sessions tables
  try {
    await run(`ALTER TABLE _oauth_sessions ADD COLUMN pds_auth_server TEXT`)
  } catch {}
}

interface MigrationChange {
  table: string
  action: 'add' | 'drop' | 'retype'
  column: string
  type?: string
}

/** Normalize SQL type names to handle dialect differences (e.g. VARCHAR → TEXT) */
function normalizeType(type: string): string {
  const upper = type.toUpperCase()
  if (upper === 'VARCHAR' || upper === 'CHARACTER VARYING') return 'TEXT'
  if (upper === 'TIMESTAMP WITH TIME ZONE') return 'TIMESTAMPTZ'
  if (upper === 'BOOLEAN' || upper === 'BOOL') return 'BOOLEAN'
  if (upper === 'INT' || upper === 'INT4' || upper === 'INT8' || upper === 'BIGINT' || upper === 'SMALLINT')
    return 'INTEGER'
  return upper
}

async function getExistingColumns(tableName: string): Promise<Map<string, string>> {
  if (!/^[a-zA-Z0-9._]+$/.test(tableName)) {
    throw new Error(`Invalid table name for introspection: ${tableName}`)
  }
  const cols = new Map<string, string>()
  try {
    const query = dialect.introspectColumnsQuery(tableName)
    const rows = await all<{ column_name?: string; name?: string; data_type?: string; type?: string }>(query)
    for (const row of rows) {
      // SQLite PRAGMA returns { name, type }, DuckDB returns { column_name, data_type }
      const name = (row.column_name || row.name) as string
      const type = normalizeType((row.data_type || row.type || 'TEXT') as string)
      cols.set(name, type)
    }
  } catch {
    // Table doesn't exist yet
  }
  return cols
}

function diffColumns(
  tableName: string,
  existingCols: Map<string, string>,
  expectedCols: Map<string, string>,
  changes: MigrationChange[],
): void {
  for (const [colName, colType] of expectedCols) {
    if (!existingCols.has(colName)) {
      changes.push({ table: tableName, action: 'add', column: colName, type: colType })
    }
  }
  for (const [colName] of existingCols) {
    if (!expectedCols.has(colName)) {
      changes.push({ table: tableName, action: 'drop', column: colName })
    }
  }
  for (const [colName, colType] of expectedCols) {
    const existingType = existingCols.get(colName)
    if (existingType && normalizeType(existingType) !== normalizeType(colType)) {
      changes.push({ table: tableName, action: 'retype', column: colName, type: colType })
    }
  }
}

/** Build expected columns map for a child/union table */
function buildChildExpectedCols(columns: { name: string; sqlType: string }[]): Map<string, string> {
  const expected = new Map<string, string>()
  expected.set('parent_uri', 'TEXT')
  expected.set('parent_did', 'TEXT')
  for (const col of columns) {
    expected.set(col.name, normalizeType(col.sqlType))
  }
  return expected
}

export async function migrateSchema(tableSchemas: TableSchema[]): Promise<MigrationChange[]> {
  const changes: MigrationChange[] = []
  const newCollections = new Set<string>()

  for (const schema of tableSchemas) {
    if (schema.columns.length === 0) continue // generic JSON storage, skip

    const tableName = schema.collection
    const existingCols = await getExistingColumns(tableName)
    if (existingCols.size === 0) {
      newCollections.add(schema.collection)
      continue // table just created, nothing to migrate
    }

    // Expected columns: base columns (uri, cid, did, indexed_at) + schema columns
    const expectedCols = new Map<string, string>()
    expectedCols.set('uri', 'TEXT')
    expectedCols.set('cid', 'TEXT')
    expectedCols.set('did', 'TEXT')
    expectedCols.set('indexed_at', normalizeType(dialect.timestampType))
    for (const col of schema.columns) {
      expectedCols.set(col.name, normalizeType(col.sqlType))
    }

    diffColumns(tableName, existingCols, expectedCols, changes)

    // Diff child tables
    for (const child of schema.children) {
      const childTable = child.tableName.replace(/"/g, '')
      const existingChildCols = await getExistingColumns(childTable)
      if (existingChildCols.size === 0) continue
      diffColumns(childTable, existingChildCols, buildChildExpectedCols(child.columns), changes)
    }

    // Diff union branch tables
    for (const union of schema.unions) {
      for (const branch of union.branches) {
        const branchTable = branch.tableName.replace(/"/g, '')
        const existingBranchCols = await getExistingColumns(branchTable)
        if (existingBranchCols.size === 0) continue
        diffColumns(branchTable, existingBranchCols, buildChildExpectedCols(branch.columns), changes)
      }
    }
  }

  // Detect and drop orphaned child/union tables (query table list once)
  let allTableNames: string[] | null = null
  try {
    const rows = await all(dialect.listTablesQuery)
    allTableNames = rows.map((r: any) => r.table_name as string)
  } catch {}

  if (allTableNames) {
    for (const schema of tableSchemas) {
      if (schema.columns.length === 0) continue

      const expectedTables = new Set<string>()
      for (const child of schema.children) {
        expectedTables.add(child.tableName.replace(/"/g, ''))
      }
      for (const union of schema.unions) {
        for (const branch of union.branches) {
          expectedTables.add(branch.tableName.replace(/"/g, ''))
        }
      }

      for (const name of allTableNames) {
        if (name.startsWith(schema.collection + '__') && !expectedTables.has(name)) {
          await run(`DROP TABLE IF EXISTS "${name}"`)
          emit('migration', 'drop_table', { table: name })
        }
      }
    }
  }

  if (changes.length > 0) {
    await applyMigrationChanges(changes)
  }

  // Trigger backfill only for genuinely new collections (tables created this startup)
  // Previously this checked ALL empty tables, which caused infinite resync loops
  // for collections that are legitimately empty (e.g. blocks when nobody has blocked)
  if (newCollections.size > 0) {
    const [hasRepos] = await all(`SELECT 1 FROM _repos LIMIT 1`)
    if (hasRepos) {
      await run(`UPDATE _repos SET status = 'pending' WHERE status = 'active'`)
      for (const collection of newCollections) {
        emit('migration', 'new_collection', { collection })
      }
    }
  }

  return changes
}

async function applyMigrationChanges(changes: MigrationChange[]): Promise<void> {
  for (const change of changes) {
    const quotedTable = `"${change.table}"`
    const quotedColumn = `"${change.column}"`
    try {
      switch (change.action) {
        case 'add': {
          await run(`ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColumn} ${change.type}`)
          emit('migration', 'add_column', { table: change.table, column: change.column, type: change.type })
          const schema = schemas.get(change.table)
          if (schema?.refColumns.includes(change.column)) {
            const prefix = change.table.replace(/\./g, '_')
            await run(`CREATE INDEX IF NOT EXISTS idx_${prefix}_${change.column} ON ${quotedTable}(${quotedColumn})`)
          }
          break
        }
        case 'drop':
          await run(`ALTER TABLE ${quotedTable} DROP COLUMN ${quotedColumn}`)
          emit('migration', 'drop_column', { table: change.table, column: change.column })
          break
        case 'retype':
          await run(`ALTER TABLE ${quotedTable} DROP COLUMN ${quotedColumn}`)
          await run(`ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColumn} ${change.type}`)
          emit('migration', 'retype_column', { table: change.table, column: change.column, type: change.type })
          break
      }
    } catch (err: any) {
      console.warn(
        `[migration] failed to ${change.action} column "${change.column}" on "${change.table}": ${err.message}`,
      )
      emit('migration', 'error', {
        action: change.action,
        table: change.table,
        column: change.column,
        error: err.message,
      })
    }
  }
}

export async function getCursor(key: string): Promise<string | null> {
  const rows = await all<{ value: string }>(`SELECT value FROM _cursor WHERE key = $1`, [key])
  return rows[0]?.value || null
}

export async function setCursor(key: string, value: string): Promise<void> {
  await run(`INSERT OR REPLACE INTO _cursor (key, value) VALUES ($1, $2)`, [key, value])
}

export async function getRepoStatus(did: string): Promise<string | null> {
  const rows = await all<{ status: string }>(`SELECT status FROM _repos WHERE did = $1`, [did])
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
      [status, opts?.handle || null, new Date().toISOString(), rev || null, did],
    )
    // Insert if row didn't exist yet
    await run(
      `INSERT OR IGNORE INTO _repos (did, status, handle, backfilled_at, rev, retry_count, retry_after) VALUES ($1, $2, $3, $4, $5, 0, 0)`,
      [did, status, opts?.handle || null, new Date().toISOString(), rev || null],
    )
  } else if (status === 'failed' && opts) {
    await run(
      `UPDATE _repos SET status = $1, retry_count = $2, retry_after = $3, handle = COALESCE($4, handle) WHERE did = $5`,
      [status, opts.retryCount ?? 0, opts.retryAfter ?? 0, opts.handle || null, did],
    )
    // If row didn't exist yet, insert it
    await run(
      `INSERT OR IGNORE INTO _repos (did, status, handle, retry_count, retry_after) VALUES ($1, $2, $3, $4, $5)`,
      [did, status, opts.handle || null, opts.retryCount ?? 0, opts.retryAfter ?? 0],
    )
  } else {
    await run(`UPDATE _repos SET status = $1 WHERE did = $2`, [status, did])
    await run(`INSERT OR IGNORE INTO _repos (did, status) VALUES ($1, $2)`, [did, status])
  }
}

/** Update the handle for a DID if it exists in _repos. */
export async function updateRepoHandle(did: string, handle: string): Promise<void> {
  await run(`UPDATE _repos SET handle = $1 WHERE did = $2`, [handle, did])
}

export async function getRepoRev(did: string): Promise<string | null> {
  const rows = await all<{ rev: string }>(`SELECT rev FROM _repos WHERE did = $1`, [did])
  return rows[0]?.rev ?? null
}

export async function getRepoRetryInfo(did: string): Promise<{ retryCount: number; retryAfter: number } | null> {
  const rows = await all<{ retry_count: number; retry_after: number }>(`SELECT retry_count, retry_after FROM _repos WHERE did = $1`, [did])
  if (rows.length === 0) return null
  return { retryCount: Number(rows[0].retry_count), retryAfter: Number(rows[0].retry_after) }
}

export async function listRetryEligibleRepos(maxRetries: number): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000)
  const rows = await all<{ did: string }>(`SELECT did FROM _repos WHERE status = 'failed' AND retry_after <= $1 AND retry_count < $2`, [
    now,
    maxRetries,
  ])
  return rows.map((r) => r.did)
}

export async function listPendingRepos(): Promise<string[]> {
  const rows = await all<{ did: string }>(`SELECT did FROM _repos WHERE status = 'pending'`)
  return rows.map((r) => r.did)
}

export async function listActiveRepoDids(): Promise<string[]> {
  const rows = await all(`SELECT did FROM _repos WHERE status = 'active'`)
  return rows.map((r: any) => r.did)
}

export async function removeRepo(did: string): Promise<void> {
  await run(`DELETE FROM _repos WHERE did = $1`, [did])
}

export async function getRepoHandle(did: string): Promise<string | null> {
  const rows = await all<{ handle: string }>(`SELECT handle FROM _repos WHERE did = $1`, [did])
  return rows[0]?.handle ?? null
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
    conditions.push(`(did ${dialect.ilike} $${paramIdx} OR handle ${dialect.ilike} $${paramIdx})`)
    params.push(`%${q}%`)
    paramIdx++
  }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''

  const countRows = await all<{ total: number }>(`SELECT ${dialect.countAsInteger} as total FROM _repos${where}`, params)
  const total = Number(countRows[0]?.total || 0)

  const rows = await all(
    `SELECT did, handle, status, backfilled_at, rev FROM _repos${where} ORDER BY CASE WHEN backfilled_at IS NULL THEN 1 ELSE 0 END, backfilled_at DESC, did LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset],
  )

  return { repos: rows, total }
}

export async function getCollectionCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const [collection, schema] of schemas) {
    const rows = await all<{ count: number }>(`SELECT ${dialect.countAsInteger} as count FROM ${schema.tableName}`)
    counts[collection] = Number(rows[0]?.count || 0)
  }
  return counts
}

export async function getRepoStatusCounts(): Promise<Record<string, number>> {
  const rows = await all<{ status: string; count: number }>(`SELECT status, ${dialect.countAsInteger} as count FROM _repos GROUP BY status`)
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.status] = Number(row.count)
  return counts
}

export async function getDatabaseSize(): Promise<Record<string, string>> {
  if (dialect.supportsSequences) {
    // DuckDB: pragma_database_size returns pre-formatted strings
    const rows = await all('SELECT database_size, memory_usage, memory_limit FROM pragma_database_size()')
    return (rows[0] as Record<string, string>) ?? {}
  }
  // SQLite: compute from page_count * page_size
  const pages = await all<{ page_count: number }>('SELECT page_count FROM pragma_page_count()')
  const sizes = await all<{ page_size: number }>('SELECT page_size FROM pragma_page_size()')
  const pageCount = Number(pages[0]?.page_count ?? 0)
  const pageSize = Number(sizes[0]?.page_size ?? 0)
  const bytes = pageCount * pageSize
  const mib = (bytes / 1024 / 1024).toFixed(1)
  return { database_size: `${mib} MiB`, memory_usage: 'N/A', memory_limit: 'N/A' }
}

export async function getLabelCount(val: string): Promise<number> {
  const rows = await all<{ count: number }>(`SELECT ${dialect.countAsInteger} as count FROM _labels WHERE val = $1`, [val])
  return Number(rows[0]?.count || 0)
}

export async function deleteLabels(val: string): Promise<number> {
  const count = await getLabelCount(val)
  await run(`DELETE FROM _labels WHERE val = $1`, [val])
  return count
}

export async function getRecentRecords(collection: string, limit: number): Promise<any[]> {
  const schema = schemas.get(collection)
  if (!schema) return []
  const rows = await all(
    `SELECT t.* FROM ${schema.tableName} t JOIN _repos r ON t.did = r.did WHERE t.indexed_at > r.backfilled_at ORDER BY t.indexed_at DESC LIMIT $1`,
    [limit],
  )
  return rows
}

export async function getSchemaDump(): Promise<string> {
  let rows: any[]
  if (dialect.supportsSequences) {
    // DuckDB: use duckdb_tables() for full DDL
    rows = await all(`SELECT sql FROM duckdb_tables() ORDER BY table_name`)
  } else {
    // SQLite: use sqlite_master, skip FTS shadow/internal tables
    rows = await all(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_fts_%' AND sql IS NOT NULL ORDER BY name`,
    )
  }
  // Normalize indentation and formatting
  return rows
    .map((r: any) => {
      let sql = (r.sql as string).trim()
      // Remove quotes around column names (SQLite adds them for some columns)
      sql = sql.replace(/\n\s*"(\w+)"/g, '\n$1')
      // Ensure closing paren is on its own line
      sql = sql.replace(/([^(\s])\)$/, '$1\n)')
      // Normalize leading-comma columns added by ALTER TABLE into trailing commas
      sql = sql.replace(/\n\s*,\s*/g, ',\n')
      // Split into lines and re-indent consistently
      const lines = sql.split('\n').map((l) => l.trim())
      sql = lines
        .map((line, i) => {
          if (i === 0) return line // CREATE TABLE line
          if (line.startsWith(')')) return ')' // closing paren at top level
          return '  ' + line // indent columns
        })
        .join('\n')
      return sql + ';'
    })
    .join('\n\n')
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
    colNames.push(q(col.name))
    placeholders.push(`$${paramIdx++}`)

    if (rawValue === undefined || rawValue === null) {
      values.push(null)
    } else if (col.isJson) {
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
  await run(sql, params)

  // Insert child table rows
  for (const child of schema.children) {
    const items = record[child.fieldName]
    if (!Array.isArray(items)) continue

    // Delete existing child rows (handles INSERT OR REPLACE on main table)
    await run(`DELETE FROM ${child.tableName} WHERE parent_uri = $1`, [uri])

    for (const item of items) {
      const colNames = ['parent_uri', 'parent_did']
      const placeholders = ['$1', '$2']
      const values: any[] = [uri, authorDid]
      let idx = 3

      for (const col of child.columns) {
        colNames.push(q(col.name))
        placeholders.push(`$${idx++}`)
        const raw = item[col.originalName]
        if (raw === undefined || raw === null) {
          values.push(null)
        } else if (col.isJson) {
          values.push(JSON.stringify(raw))
        } else {
          values.push(raw)
        }
      }

      await run(`INSERT INTO ${child.tableName} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`, values)
    }
  }

  // Insert union branch rows
  for (const union of schema.unions) {
    const unionValue = record[union.fieldName]
    if (!unionValue || !unionValue.$type) continue

    const branch = union.branches.find((b) => b.type === unionValue.$type)
    if (!branch) continue

    // Delete existing branch rows (handles INSERT OR REPLACE)
    for (const b of union.branches) {
      await run(`DELETE FROM ${b.tableName} WHERE parent_uri = $1`, [uri])
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
          colNames.push(q(col.name))
          placeholders.push(`$${idx++}`)
          const raw = item[col.originalName]
          if (raw === undefined || raw === null) {
            values.push(null)
          } else if (col.isJson) {
            values.push(JSON.stringify(raw))
          } else {
            values.push(raw)
          }
        }
        await run(
          `INSERT INTO ${branch.tableName} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`,
          values,
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
        colNames.push(q(col.name))
        placeholders.push(`$${idx++}`)
        const raw = branchData[col.originalName]
        if (raw === undefined || raw === null) {
          values.push(null)
        } else if (col.isJson) {
          values.push(JSON.stringify(raw))
        } else {
          values.push(raw)
        }
      }
      await run(`INSERT INTO ${branch.tableName} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`, values)
    }
  }

  // Incrementally update FTS index for this record
  await updateFtsRecord(collection, uri)
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

  // Remove from FTS index before deleting the record data
  await deleteFtsRecord(collection, uri)

  for (const child of schema.children) {
    await run(`DELETE FROM ${child.tableName} WHERE parent_uri = $1`, [uri])
  }
  for (const union of schema.unions) {
    for (const branch of union.branches) {
      await run(`DELETE FROM ${branch.tableName} WHERE parent_uri = $1`, [uri])
    }
  }
  await run(`DELETE FROM ${schema.tableName} WHERE uri = $1`, [uri])
}

export async function insertLabels(
  labels: Array<{ src: string; uri: string; val: string; neg?: boolean; cts?: string; exp?: string }>,
): Promise<void> {
  if (labels.length === 0) return
  for (const label of labels) {
    // Skip if an active (non-negated, non-expired, not-superseded-by-negation) label already exists for this src+uri+val
    const existing = await all(
      `SELECT 1 FROM _labels l1 WHERE l1.src = $1 AND l1.uri = $2 AND l1.val = $3 AND l1.neg = false AND (l1.exp IS NULL OR l1.exp > CURRENT_TIMESTAMP) AND NOT EXISTS (SELECT 1 FROM _labels l2 WHERE l2.uri = l1.uri AND l2.val = l1.val AND l2.neg = true AND l2.id > l1.id) LIMIT 1`,
      [label.src, label.uri, label.val],
    )
    if (!label.neg && existing.length > 0) continue

    await run(`INSERT INTO _labels (src, uri, val, neg, cts, exp) VALUES ($1, $2, $3, $4, $5, $6)`, [
      label.src,
      label.uri,
      label.val,
      label.neg || false,
      label.cts || new Date().toISOString(),
      label.exp || null,
    ])
  }
}

export async function queryLabelsForUris(
  uris: string[],
): Promise<
  Map<string, Array<{ src: string; uri: string; val: string; neg: boolean; cts: string; exp: string | null }>>
> {
  if (uris.length === 0) return new Map()
  const placeholders = uris.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all<{ src: string; uri: string; val: string; neg: boolean; cts: string; exp: string | null }>(
    `SELECT src, uri, val, neg, cts, exp FROM _labels l1 WHERE uri IN (${placeholders}) AND (exp IS NULL OR exp > CURRENT_TIMESTAMP) AND neg = false AND NOT EXISTS (SELECT 1 FROM _labels l2 WHERE l2.uri = l1.uri AND l2.val = l1.val AND l2.neg = true AND l2.id > l1.id) GROUP BY uri, val`,
    uris,
  )
  const result = new Map<string, Array<any>>()
  for (const row of rows) {
    const key = row.uri
    if (!result.has(key)) result.set(key, [])
    result.get(key)!.push({
      src: row.src,
      uri: row.uri,
      val: row.val,
      neg: !!row.neg,
      cts: normalizeValue(row.cts),
      ...(row.exp ? { exp: String(row.exp) } : {}),
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
    const allCols = ['uri', 'cid', 'did', 'indexed_at', ...schema.columns.map((c) => q(c.name))]
    const colDefs = [
      'uri TEXT',
      'cid TEXT',
      'did TEXT',
      'indexed_at TEXT',
      ...schema.columns.map((c) => {
        const t = c.sqlType
        // Use TEXT for timestamp columns in staging (will cast on merge)
        return `${q(c.name)} ${t === 'TIMESTAMP' || t === 'TIMESTAMPTZ' ? 'TEXT' : t}`
      }),
    ]

    await port.execute(`DROP TABLE IF EXISTS ${stagingTable}`, [])
    await port.execute(`CREATE TABLE ${stagingTable} (${colDefs.join(', ')})`, [])

    const inserter = await port.createBulkInserter(stagingTable, allCols)
    const now = new Date().toISOString()

    for (const rec of recs) {
      try {
        const values: unknown[] = [rec.uri, rec.cid, rec.did, now]

        for (const col of schema.columns) {
          values.push(resolveColumnValue(col, rec.record))
        }
        inserter.append(values)
        inserted++
      } catch {
        // Skip bad records
      }
    }

    await inserter.close()

    // Merge into target, filtering rows that would violate NOT NULL
    const selectCols = allCols.map((name) => {
      const col = schema.columns.find((c) => q(c.name) === name)
      if (name === 'indexed_at' || (col && (col.sqlType === 'TIMESTAMP' || col.sqlType === 'TIMESTAMPTZ'))) {
        return `${dialect.tryCastTimestamp(name)} AS ${name}`
      }
      return name
    })
    const notNullChecks: string[] = ['uri IS NOT NULL', 'did IS NOT NULL']
    for (const col of schema.columns) {
      if (col.notNull) {
        if (col.sqlType === 'TIMESTAMP' || col.sqlType === 'TIMESTAMPTZ') {
          notNullChecks.push(`${dialect.tryCastTimestamp(q(col.name))} IS NOT NULL`)
        } else {
          notNullChecks.push(`${q(col.name)} IS NOT NULL`)
        }
      }
    }
    const whereClause = notNullChecks.length ? ` WHERE ${notNullChecks.join(' AND ')}` : ''
    await port.execute(
      `INSERT OR REPLACE INTO ${schema.tableName} (${allCols.join(', ')}) SELECT ${selectCols.join(', ')} FROM ${stagingTable}${whereClause}`,
      [],
    )
    await port.execute(`DROP TABLE ${stagingTable}`, [])

    // Populate child tables
    for (const child of schema.children) {
      const childStagingTable = `_staging_${collection.replace(/\./g, '_')}__${child.fieldName}`
      const childColDefs = [
        'parent_uri TEXT',
        'parent_did TEXT',
        ...child.columns.map((c) => {
          const t = c.sqlType
          return `${q(c.name)} ${t === 'TIMESTAMP' || t === 'TIMESTAMPTZ' ? 'TEXT' : t}`
        }),
      ]
      const childAllCols = ['parent_uri', 'parent_did', ...child.columns.map((c) => q(c.name))]

      await port.execute(`DROP TABLE IF EXISTS ${childStagingTable}`, [])
      await port.execute(`CREATE TABLE ${childStagingTable} (${childColDefs.join(', ')})`, [])

      const childInserter = await port.createBulkInserter(childStagingTable, childAllCols)

      for (const rec of recs) {
        const items = rec.record[child.fieldName]
        if (!Array.isArray(items)) continue

        for (const item of items) {
          try {
            const values: unknown[] = [rec.uri, rec.did]
            for (const col of child.columns) {
              values.push(resolveRawColumnValue(col, item))
            }
            childInserter.append(values)
          } catch {
            // Skip bad items
          }
        }
      }

      await childInserter.close()

      // Delete existing child rows for these URIs, then merge staging
      const uriPlaceholders = recs.map((_, i) => `$${i + 1}`).join(',')
      await port.execute(
        `DELETE FROM ${child.tableName} WHERE parent_uri IN (${uriPlaceholders})`,
        recs.map((r) => r.uri),
      )

      const childSelectCols = childAllCols.map((name) => {
        const col = child.columns.find((c) => q(c.name) === name)
        if (col && (col.sqlType === 'TIMESTAMP' || col.sqlType === 'TIMESTAMPTZ')) {
          return `${dialect.tryCastTimestamp(name)} AS ${name}`
        }
        return name
      })
      await port.execute(
        `INSERT INTO ${child.tableName} (${childAllCols.join(', ')}) SELECT ${childSelectCols.join(', ')} FROM ${childStagingTable} WHERE parent_uri IS NOT NULL`,
        [],
      )
      await port.execute(`DROP TABLE ${childStagingTable}`, [])
    }

    // Populate union branch tables
    for (const union of schema.unions) {
      for (const branch of union.branches) {
        const branchStagingTable = `_staging_${collection.replace(/\./g, '_')}__${toSnakeCase(union.fieldName)}_${branch.branchName}`
        const branchColDefs = [
          'parent_uri TEXT',
          'parent_did TEXT',
          ...branch.columns.map((c) => {
            const t = c.sqlType
            return `${q(c.name)} ${t === 'TIMESTAMP' || t === 'TIMESTAMPTZ' ? 'TEXT' : t}`
          }),
        ]
        const branchAllCols = ['parent_uri', 'parent_did', ...branch.columns.map((c) => q(c.name))]

        await port.execute(`DROP TABLE IF EXISTS ${branchStagingTable}`, [])
        await port.execute(`CREATE TABLE ${branchStagingTable} (${branchColDefs.join(', ')})`, [])

        const branchInserter = await port.createBulkInserter(branchStagingTable, branchAllCols)

        for (const rec of recs) {
          const unionValue = rec.record[union.fieldName]
          if (!unionValue || typeof unionValue !== 'object') continue
          if (unionValue.$type !== branch.type) continue

          if (branch.isArray && branch.arrayField) {
            const items = resolveBranchData(unionValue, branch)[branch.arrayField]
            if (!Array.isArray(items)) continue
            for (const item of items) {
              try {
                const values: unknown[] = [rec.uri, rec.did]
                for (const col of branch.columns) {
                  values.push(resolveRawColumnValue(col, item))
                }
                branchInserter.append(values)
              } catch {
                // Skip bad items
              }
            }
          } else {
            try {
              const branchData = resolveBranchData(unionValue, branch)
              const values: unknown[] = [rec.uri, rec.did]
              for (const col of branch.columns) {
                values.push(resolveRawColumnValue(col, branchData))
              }
              branchInserter.append(values)
            } catch {
              // Skip bad records
            }
          }
        }

        await branchInserter.close()

        // Delete existing branch rows for these URIs, then merge staging
        const uriPlaceholders = recs.map((_, i) => `$${i + 1}`).join(',')
        await port.execute(
          `DELETE FROM ${branch.tableName} WHERE parent_uri IN (${uriPlaceholders})`,
          recs.map((r) => r.uri),
        )

        const branchSelectCols = branchAllCols.map((name) => {
          const col = branch.columns.find((c) => q(c.name) === name)
          if (col && (col.sqlType === 'TIMESTAMP' || col.sqlType === 'TIMESTAMPTZ')) {
            return `${dialect.tryCastTimestamp(name)} AS ${name}`
          }
          return name
        })
        await port.execute(
          `INSERT INTO ${branch.tableName} (${branchAllCols.join(', ')}) SELECT ${branchSelectCols.join(', ')} FROM ${branchStagingTable} WHERE parent_uri IS NOT NULL`,
          [],
        )
        await port.execute(`DROP TABLE ${branchStagingTable}`, [])
      }
    }
  }

  return inserted
}

/** Extract a column value from a record, handling strongRef expansion and type coercion for bulk insert */
function resolveColumnValue(
  col: { name: string; originalName: string; sqlType: string; isRef: boolean },
  record: Record<string, any>,
): unknown {
  let rawValue = record[col.originalName]
  if (rawValue && typeof rawValue === 'object' && col.name.endsWith('_uri') && col.isRef) {
    rawValue = rawValue.uri
  } else if (col.originalName.endsWith('__cid') && record[col.originalName.replace('__cid', '')]) {
    rawValue = record[col.originalName.replace('__cid', '')].cid
  }
  return coerceValue(col.sqlType, rawValue)
}

/** Extract a raw column value from a data object and coerce for bulk insert */
function resolveRawColumnValue(col: { originalName: string; sqlType: string }, data: Record<string, any>): unknown {
  return coerceValue(col.sqlType, data[col.originalName])
}

/** Coerce a value to the appropriate type for insertion */
function coerceValue(sqlType: string, rawValue: any): unknown {
  if (rawValue === undefined || rawValue === null) return null
  // Objects and arrays always need JSON stringification regardless of sqlType
  // (on SQLite, JSON columns map to TEXT but still need stringification)
  if (typeof rawValue === 'object' && !(rawValue instanceof Uint8Array)) {
    return JSON.stringify(rawValue)
  }
  if (sqlType === 'JSON' || sqlType === 'TEXT') {
    return String(rawValue)
  }
  if (sqlType === 'INTEGER' || sqlType === 'BIGINT') {
    return typeof rawValue === 'number' ? rawValue : parseInt(rawValue)
  }
  if (sqlType === 'BOOLEAN') return !!rawValue
  return String(rawValue)
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

  const rows = await all(sql, params)
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
      ;(row as any).__childData = childData
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
      ;(row as any).__unionData = unionData
    }
  }

  const lastRow = rows[rows.length - 1] as Record<string, unknown> | undefined
  const nextCursor = hasMore && lastRow ? packCursor(lastRow[sortName] as string, lastRow.cid as string) : undefined

  return { records: rows, cursor: nextCursor }
}

export async function getRecordByUri(uri: string): Promise<any | null> {
  for (const [_collection, schema] of schemas) {
    const rows = await all(
      `SELECT t.*, r.handle FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did WHERE t.uri = $1 AND (r.status IS NULL OR r.status != 'takendown')`,
      [uri],
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
    uris,
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
    ;(row as any).__childData = childData
    if (unionData.size > 0) (row as any).__unionData = unionData
  }

  // Preserve ordering
  const byUri = new Map(rows.map((r: any) => [r.uri, r]))
  return uris.map((u) => byUri.get(u)).filter(Boolean)
}

/** Fetch records by URIs and return as a shaped Map keyed by URI. */
export async function getRecordsMap<R = unknown>(collection: string, uris: string[]): Promise<Map<string, Row<R>>> {
  if (uris.length === 0) return new Map()
  const records = await getRecordsByUris(collection, uris)
  const map = new Map<string, Row<R>>()
  for (const r of records) {
    const shaped = reshapeRow(r, r?.__childData, r?.__unionData)
    if (shaped) map.set(shaped.uri, shaped as Row<R>)
  }
  return map
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
  const { limit = 20, fuzzy = true } = opts
  const textCols = schema.columns.filter((c) => c.sqlType === 'TEXT')

  // Also check if FTS has indexed any columns (including derived JSON columns)
  const ftsSearchCols = getSearchColumns(collection)
  if (textCols.length === 0 && ftsSearchCols.length === 0) {
    throw new Error(`No searchable columns in ${collection}`)
  }

  // FTS shadow table name (dots replaced with underscores)
  const safeName = '_fts_' + collection.replace(/\./g, '_')

  const phaseErrors: string[] = []
  const phasesUsed: string[] = []

  // Phase 1: BM25 ranked search via SearchPort
  let bm25Results: any[] = []
  const sp = getSearchPort()
  if (sp)
    try {
      const ftsQuery = stripStopWords(query)
      const ftsSearchColNames = getSearchColumns(collection)

      // Get ranked URIs from the search port
      const hits = await sp.search(safeName, ftsQuery, ftsSearchColNames, limit + 1, 0)
      if (hits.length > 0) {
        const uriList = hits.map((h) => h.uri)
        const scoreMap = new Map(hits.map((h) => [h.uri, h.score]))

        // Fetch full records for matched URIs
        const placeholders = uriList.map((_, i) => `$${i + 1}`).join(', ')
        const rows = await all(
          `SELECT m.* FROM ${schema.tableName} m
          LEFT JOIN _repos r ON m.did = r.did
          WHERE m.uri IN (${placeholders})
          AND (r.status IS NULL OR r.status != 'takendown')`,
          uriList,
        )

        // Re-attach scores and sort
        bm25Results = rows
          .map((r: any) => ({ ...r, score: scoreMap.get(r.uri) ?? 0 }))
          .sort((a: any, b: any) => b.score - a.score)
      }
      phasesUsed.push('bm25')
    } catch (err: any) {
      phaseErrors.push(`bm25: ${err.message}`)
    }

  const bm25Count = bm25Results.length
  const hasMore = bm25Results.length > limit
  if (hasMore) bm25Results.pop()

  const existingUris = new Set(bm25Results.map((r: any) => r.uri))

  // Phase 2: Fuzzy fallback for typo tolerance (if still under limit)
  // Only available on dialects with jaro_winkler_similarity (DuckDB)
  let fuzzyCount = 0
  if (fuzzy && dialect.jaroWinklerSimilarity && bm25Results.length < limit) {
    const remaining = limit - bm25Results.length
    const jwFn = dialect.jaroWinklerSimilarity
    const simExprs = [
      ...textCols.map((c) => `${jwFn}(lower(t.${q(c.name)}), lower($1))`),
      `${jwFn}(lower(r.handle), lower($1))`,
    ]
    // Include child table TEXT columns via correlated subquery
    for (const child of schema.children) {
      for (const col of child.columns) {
        if (col.sqlType === 'TEXT') {
          simExprs.push(
            `COALESCE((SELECT MAX(${jwFn}(lower(c.${q(col.name)}), lower($1))) FROM ${child.tableName} c WHERE c.parent_uri = t.uri), 0)`,
          )
        }
      }
    }
    const greatestExpr = dialect.greatest(simExprs)
    const fuzzySQL = `SELECT t.*, ${greatestExpr} AS fuzzy_score
      FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did
      WHERE ${greatestExpr} >= 0.8
      ORDER BY fuzzy_score DESC
      LIMIT $2`

    try {
      const fuzzyRows = await all<Record<string, unknown>>(fuzzySQL, [query, remaining + existingUris.size])
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

  // Remove score columns and reshape into Row<T> with value
  const rawRecords = bm25Results.map(({ score: _score, fuzzy_score: _fuzzy_score, ...rest }: any) => rest)
  const records = rawRecords
    .map((r: any) => reshapeRow(r, r?.__childData, r?.__unionData))
    .filter((r: any): r is Row<unknown> => r != null)

  const lastRow = bm25Results[bm25Results.length - 1]
  const nextCursor = hasMore && lastRow?.score != null ? packCursor(lastRow.score, lastRow.cid) : undefined

  emit('search', 'query', {
    collection,
    query,
    bm25_count: bm25Count > limit ? bm25Count - 1 : bm25Count,
    fuzzy_count: fuzzyCount,
    total_results: records.length,
    duration_ms: elapsed(),
    phases_used: phasesUsed.join(','),
    error: phaseErrors.length > 0 ? phaseErrors.join('; ') : undefined,
  })

  return { records, cursor: nextCursor }
}

// Raw SQL for script feeds
export async function querySQL(sql: string, params: unknown[] = []): Promise<unknown[]> {
  return all(sql, params)
}

export async function runSQL(sql: string, params: unknown[] = []): Promise<void> {
  return run(sql, params)
}

export async function createBulkInserterSQL(
  table: string,
  columns: string[],
  options?: { onConflict?: 'ignore' | 'replace'; batchSize?: number },
): Promise<import('./ports.ts').BulkInserter> {
  return port.createBulkInserter(table, columns, options)
}

export function getSchema(collection: string): TableSchema | undefined {
  return schemas.get(collection)
}

export async function countByField(collection: string, field: string, value: string): Promise<number> {
  const schema = schemas.get(collection)
  if (!schema) return 0
  const rows = await all<{ count: number }>(`SELECT COUNT(*) as count FROM ${schema.tableName} WHERE ${field} = $1`, [value])
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
  const rows = await all<Record<string, unknown>>(
    `SELECT ${field}, COUNT(*) as count FROM ${schema.tableName} WHERE ${field} IN (${placeholders}) GROUP BY ${field}`,
    values,
  )
  const result = new Map<string, number>()
  for (const row of rows) {
    result.set(row[field] as string, Number(row.count))
  }
  return result
}

export async function findByField(collection: string, field: string, value: string): Promise<any | null> {
  const schema = schemas.get(collection)
  if (!schema) return null
  const rows = await all(`SELECT * FROM ${schema.tableName} WHERE ${field} = $1 LIMIT 1`, [value])
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
  const rows = await all<Record<string, any>>(
    `SELECT t.*, r.handle FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did WHERE t.${field} IN (${placeholders})`,
    values,
  )
  // Attach child data if this collection has decomposed arrays
  if (schema.children.length > 0 && rows.length > 0) {
    const uris = rows.map((r) => r.uri)
    const childData = new Map<string, Map<string, any[]>>()
    for (const child of schema.children) {
      const childRows = await getChildRows(child.tableName, uris)
      childData.set(child.fieldName, childRows)
    }
    for (const row of rows) {
      row.__childData = childData
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
  const rows = await all<{ uri: string }>(`SELECT uri FROM ${schema.tableName} WHERE ${where} LIMIT 1`, params)
  return rows[0]?.uri || null
}

const ENVELOPE_KEYS = new Set(['uri', 'cid', 'did', 'handle', 'indexed_at'])
const INTERNAL_KEYS = new Set(['__childData', '__unionData'])

export function normalizeValue(v: any): any {
  if (v && typeof v === 'object' && 'micros' in v) return new Date(Number(v.micros) / 1000).toISOString()
  if (typeof v === 'bigint') return Number(v)
  return v
}

export async function getChildRows(childTableName: string, parentUris: string[]): Promise<Map<string, any[]>> {
  if (parentUris.length === 0) return new Map()
  const placeholders = parentUris.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all<Record<string, any>>(`SELECT * FROM ${childTableName} WHERE parent_uri IN (${placeholders})`, parentUris)
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
      if (col.isJson) jsonCols.add(col.name)
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
  return all(`SELECT * FROM _labels WHERE uri LIKE $1 AND neg = false AND (exp IS NULL OR exp > CURRENT_TIMESTAMP)`, [
    `at://${did}/%`,
  ])
}

export async function searchAccounts(query: string, limit: number = 20): Promise<any[]> {
  return all(
    `SELECT did, handle, status FROM _repos WHERE did ${dialect.ilike} $1 OR handle ${dialect.ilike} $1 ORDER BY handle LIMIT $2`,
    [`%${query}%`, limit],
  )
}

export async function getAccountRecordCount(did: string): Promise<number> {
  let total = 0
  for (const [, schema] of schemas) {
    const rows = await all<{ count: number }>(`SELECT COUNT(*) as count FROM ${schema.tableName} WHERE did = $1`, [did])
    total += Number(rows[0]?.count || 0)
  }
  return total
}

export async function getAllRecordUrisForDid(did: string): Promise<string[]> {
  const uris: string[] = []
  for (const [, schema] of schemas) {
    const rows = await all<{ uri: string }>(`SELECT uri FROM ${schema.tableName} WHERE did = $1`, [did])
    uris.push(...rows.map((r) => r.uri))
  }
  return uris
}

export async function isTakendownDid(did: string): Promise<boolean> {
  const rows = await all(`SELECT 1 FROM _repos WHERE did = $1 AND status = 'takendown' LIMIT 1`, [did])
  return rows.length > 0
}

export async function getPreferences(did: string): Promise<Record<string, any>> {
  const rows = await all<{ key: string; value: string }>(`SELECT key, value FROM _preferences WHERE did = $1`, [did])
  const prefs: Record<string, any> = {}
  for (const row of rows) {
    try {
      prefs[row.key] = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
    } catch {
      prefs[row.key] = row.value
    }
  }
  return prefs
}

export async function putPreference(did: string, key: string, value: any): Promise<void> {
  await run(`INSERT OR REPLACE INTO _preferences (did, key, value, updated_at) VALUES ($1, $2, $3, $4)`, [
    did,
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  ])
}

export async function filterTakendownDids(dids: string[]): Promise<Set<string>> {
  if (dids.length === 0) return new Set()
  const placeholders = dids.map((_, i) => `$${i + 1}`).join(',')
  const rows = await all<{ did: string }>(`SELECT did FROM _repos WHERE did IN (${placeholders}) AND status = 'takendown'`, dids)
  return new Set(rows.map((r) => r.did))
}

export async function insertReport(report: {
  subjectUri: string
  subjectDid: string
  label: string
  reason?: string
  reportedBy: string
}): Promise<{ id: number }> {
  const createdAt = new Date().toISOString()
  const rows = await all<{ id: number }>(
    `INSERT INTO _reports (subject_uri, subject_did, label, reason, reported_by, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [report.subjectUri, report.subjectDid, report.label, report.reason || null, report.reportedBy, createdAt],
  )
  return { id: rows[0].id }
}

export async function queryReports(opts: {
  status?: string
  label?: string
  limit?: number
  offset?: number
}): Promise<{ reports: any[]; total: number }> {
  const conditions: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (opts.status) {
    conditions.push(`r.status = $${idx++}`)
    params.push(opts.status)
  }
  if (opts.label) {
    conditions.push(`r.label = $${idx++}`)
    params.push(opts.label)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit || 50
  const offset = opts.offset || 0

  const countRows = await all<{ count: number }>(
    `SELECT ${dialect.countAsInteger} as count FROM _reports r ${where}`,
    params,
  )
  const total = Number(countRows[0]?.count || 0)

  const rows = await all(
    `SELECT r.*, rp.handle as reported_by_handle FROM _reports r LEFT JOIN _repos rp ON r.reported_by = rp.did ${where} ORDER BY r.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  )

  return { reports: rows, total }
}

export async function resolveReport(
  id: number,
  action: 'resolved' | 'dismissed',
  resolvedBy: string,
): Promise<{ subjectUri: string; label: string } | null> {
  const rows = await all<{ subject_uri: string; label: string; status: string }>(
    `SELECT subject_uri, label, status FROM _reports WHERE id = $1`,
    [id],
  )
  if (!rows.length) return null
  if (rows[0].status !== 'open') return null

  await run(`UPDATE _reports SET status = $1, resolved_by = $2, resolved_at = $3 WHERE id = $4`, [
    action,
    resolvedBy,
    new Date().toISOString(),
    id,
  ])
  return { subjectUri: rows[0].subject_uri, label: rows[0].label }
}

export async function getOpenReportCount(): Promise<number> {
  const rows = await all<{ count: number }>(
    `SELECT ${dialect.countAsInteger} as count FROM _reports WHERE status = 'open'`,
  )
  return Number(rows[0]?.count || 0)
}
