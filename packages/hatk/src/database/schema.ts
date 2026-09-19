import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SqlDialect } from './dialect.ts'
import { DUCKDB_DIALECT } from './dialect.ts'

export interface ColumnDef {
  name: string // snake_case column name
  originalName: string // camelCase lexicon field name
  sqlType: string // dialect-specific SQL type (e.g. 'JSON' for DuckDB, 'TEXT' for SQLite)
  notNull: boolean
  isRef: boolean // true if this column holds an AT URI referencing another record
  isJson: boolean // true if this column stores JSON data (blobs, refs, arrays, objects, unions)
}

export interface UnionBranchSchema {
  type: string // full $type string (e.g., 'app.bsky.embed.images')
  branchName: string // short name for table suffix (e.g., 'images')
  tableName: string // quoted table name
  columns: ColumnDef[] // branch properties as columns
  isArray: boolean // true if the branch wraps an array of objects
  arrayField?: string // if isArray, the property name containing the array
  wrapperField?: string // if set, data is nested under this key (e.g., 'external' for embed.external)
}

export interface UnionFieldSchema {
  fieldName: string // original camelCase field name (e.g., 'embed')
  branches: UnionBranchSchema[]
}

export interface TableSchema {
  collection: string // NSID (e.g., "xyz.marketplace.listing")
  tableName: string // quoted NSID for SQL
  columns: ColumnDef[]
  refColumns: string[] // snake_case names of columns where isRef=true
  children: ChildTableSchema[]
  unions: UnionFieldSchema[]
}

export interface ChildTableSchema {
  parentCollection: string // parent NSID
  fieldName: string // original camelCase field name (e.g., "artists")
  tableName: string // quoted "{collection}__{fieldName}"
  columns: ColumnDef[] // columns from the item object properties
}

// Convert camelCase to snake_case
export function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase()
}

/**
 * The columns every generated table carries before any lexicon field. A record
 * property with one of these names — `fyi.opensocial.space` has a `uri` — would
 * otherwise produce a CREATE TABLE with a duplicate column and fail at boot.
 * It is stored under `record_<name>` instead; `originalName` still carries the
 * lexicon's spelling, which is what every reshaped row is keyed by.
 */
const ENVELOPE_COLUMNS = new Set(['uri', 'cid', 'did', 'space', 'indexed_at', 'handle'])
export function columnName(fieldName: string): string {
  const snake = toSnakeCase(fieldName)
  return ENVELOPE_COLUMNS.has(snake) ? `record_${snake}` : snake
}

// Quote a column name to avoid conflicts with SQL reserved words
export function q(name: string): string {
  return `"${name}"`
}

// Map lexicon property type to SQL type using dialect config
interface TypeMapping {
  sqlType: string
  isRef: boolean
  isJson: boolean
}

function mapType(prop: any, dialect: SqlDialect): TypeMapping {
  if (prop.type === 'string') {
    if (prop.format === 'datetime') return { sqlType: dialect.typeMap.timestamp, isRef: false, isJson: false }
    if (prop.format === 'at-uri') return { sqlType: dialect.typeMap.text, isRef: true, isJson: false }
    return { sqlType: dialect.typeMap.text, isRef: false, isJson: false }
  }
  if (prop.type === 'integer') return { sqlType: dialect.typeMap.integer, isRef: false, isJson: false }
  if (prop.type === 'boolean') return { sqlType: dialect.typeMap.boolean, isRef: false, isJson: false }
  if (prop.type === 'bytes') return { sqlType: dialect.typeMap.blob, isRef: false, isJson: false }
  if (prop.type === 'cid-link') return { sqlType: dialect.typeMap.text, isRef: false, isJson: false }
  if (prop.type === 'array') return { sqlType: dialect.jsonType, isRef: false, isJson: true }
  if (prop.type === 'blob') return { sqlType: dialect.jsonType, isRef: false, isJson: true }
  if (prop.type === 'union') return { sqlType: dialect.jsonType, isRef: false, isJson: true }
  if (prop.type === 'unknown') return { sqlType: dialect.jsonType, isRef: false, isJson: true }
  if (prop.type === 'object') return { sqlType: dialect.jsonType, isRef: false, isJson: true }
  if (prop.type === 'ref') {
    // strongRef contains { uri, cid } — handled specially in generateTableSchema
    if (prop.ref === 'com.atproto.repo.strongRef') return { sqlType: 'STRONG_REF', isRef: true, isJson: false }
    return { sqlType: dialect.jsonType, isRef: false, isJson: true }
  }
  return { sqlType: dialect.typeMap.text, isRef: false, isJson: false }
}

// Recursively find all .json files in a directory
function findJsonFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...findJsonFiles(full))
    } else if (entry.endsWith('.json')) {
      results.push(full)
    }
  }
  return results
}

// Load all lexicon files and index by NSID
export function loadLexicons(lexiconsDir: string): Map<string, any> {
  const lexicons = new Map<string, any>()
  for (const file of findJsonFiles(lexiconsDir)) {
    const content = JSON.parse(readFileSync(file, 'utf-8'))
    if (content.lexicon === 1 && content.id) {
      lexicons.set(content.id, content)
    }
  }
  return lexicons
}

/**
 * Lexicons the validator cannot model but hatk legitimately keeps.
 *
 * A space type is how the indexer learns which collections a space holds, and
 * a permission set is what an OAuth scope resolves through; both are real
 * lexicons an app vendors on purpose. `validateLexicons` reports each as an
 * unknown definition type, which would read as a fatal schema error at boot.
 * Only these two are set aside — anything else unknown is still a mistake the
 * validator should refuse.
 */
const UNMODELLED_DEF_TYPES = new Set(['space', 'permission-set'])
export function validatableLexicons(lexicons: Map<string, any>): any[] {
  return [...lexicons.values()].filter((lex) => !UNMODELLED_DEF_TYPES.has(lex.defs?.main?.type))
}

/**
 * Discover collections by scanning lexicons for record-type definitions.
 */
export function discoverCollections(lexicons: Map<string, any>): string[] {
  const collections: string[] = []
  for (const [nsid, lexicon] of lexicons) {
    const mainDef = lexicon.defs?.main
    if (mainDef?.type === 'record') {
      collections.push(nsid)
    }
  }
  return collections.sort()
}

const storedLexicons = new Map<string, any>()

export function storeLexicons(lexicons: Map<string, any>): void {
  for (const [nsid, lex] of lexicons) {
    storedLexicons.set(nsid, lex)
  }
}

export function getLexicon(nsid: string): any | undefined {
  return storedLexicons.get(nsid)
}

export function getAllLexicons(): Array<{ nsid: string; lexicon: any }> {
  return [...storedLexicons.entries()].map(([nsid, lexicon]) => ({ nsid, lexicon }))
}

/** Get all stored lexicons as a flat array (for @bigmoves/lexicon validators) */
export function getLexiconArray(): any[] {
  return [...storedLexicons.values()]
}

function resolveArrayItemProperties(items: any, defs: Record<string, any>): Record<string, any> | null {
  if (!items) return null

  // Inline object with properties
  if (items.type === 'object' && items.properties) {
    return items.properties
  }

  // Ref to a named def (e.g., "#artist")
  if (items.type === 'ref' && items.ref?.startsWith('#')) {
    const defName = items.ref.slice(1)
    const def = defs?.[defName]
    if (def?.type === 'object' && def.properties) {
      return def.properties
    }
  }

  return null
}

/** Resolve a ref string to its definition object */
function resolveRefDef(ref: string, defs: Record<string, any>, lexicons?: Map<string, any>): any | null {
  if (ref.startsWith('#')) {
    return defs?.[ref.slice(1)] || null
  }
  if (ref.includes('#')) {
    const [nsid, defName] = ref.split('#')
    return lexicons?.get(nsid)?.defs?.[defName] || null
  }
  return lexicons?.get(ref)?.defs?.main || null
}

/** Resolve a single union ref to a branch schema */
function resolveUnionBranch(
  ref: string,
  collection: string,
  fieldName: string,
  defs: Record<string, any>,
  lexicons: Map<string, any> | undefined,
  dialect: SqlDialect,
): UnionBranchSchema | null {
  let branchDef: any = null
  let branchName: string
  let fullType: string
  let branchDefs: Record<string, any> = defs // defs context for resolving inner refs

  if (ref.startsWith('#')) {
    const defName = ref.slice(1)
    branchDef = defs?.[defName]
    branchName = toSnakeCase(defName)
    fullType = `${collection}#${defName}`
  } else if (ref.includes('#')) {
    const [nsid, defName] = ref.split('#')
    const lex = lexicons?.get(nsid)
    branchDef = lex?.defs?.[defName]
    branchName = toSnakeCase(defName)
    fullType = ref
    branchDefs = lex?.defs || defs
  } else {
    const lex = lexicons?.get(ref)
    branchDef = lex?.defs?.main
    branchName = ref.split('.').pop()!
    fullType = ref
    branchDefs = lex?.defs || defs
  }

  if (!branchDef || branchDef.type !== 'object' || !branchDef.properties) return null

  let isArray = false
  let arrayField: string | undefined
  let wrapperField: string | undefined
  let propSource: Record<string, any> = branchDef.properties
  // `required` has to travel with propSource: once the columns come from the
  // item (or wrapper target) def, the outer branch's `required` describes the
  // wrapper property, not these columns.
  let branchRequired = new Set<string>(branchDef.required || [])

  // Check for single-property wrapper patterns
  const propEntries = Object.entries(branchDef.properties as Record<string, any>)
  if (propEntries.length === 1) {
    const [onlyField, onlyProp] = propEntries[0]
    if ((onlyProp as any).type === 'array' && (onlyProp as any).items) {
      // Single array property (like embed.images wrapping images[])
      const items = (onlyProp as any).items
      const itemDef = items.type === 'ref' && items.ref ? resolveRefDef(items.ref, branchDefs, lexicons) : items
      if (itemDef?.type === 'object' && itemDef.properties) {
        isArray = true
        arrayField = onlyField
        propSource = itemDef.properties
        branchRequired = new Set<string>(itemDef.required || [])
      }
    } else if ((onlyProp as any).type === 'ref' && (onlyProp as any).ref) {
      // Single ref property (like embed.external wrapping external{})
      const refDef = resolveRefDef((onlyProp as any).ref, branchDefs, lexicons)
      if (refDef?.type === 'object' && refDef.properties) {
        wrapperField = onlyField
        propSource = refDef.properties
        branchRequired = new Set<string>(refDef.required || [])
      }
    }
  }

  const snakeField = toSnakeCase(fieldName)
  const tableName = `"${collection}__${snakeField}_${branchName}"`

  const columns: ColumnDef[] = []
  for (const [propName, prop] of Object.entries(propSource)) {
    const { sqlType, isRef, isJson } = mapType(prop as any, dialect)
    // Skip STRONG_REF expansion in branch tables — treat as JSON
    const finalType = sqlType === 'STRONG_REF' ? dialect.jsonType : sqlType
    columns.push({
      name: toSnakeCase(propName),
      originalName: propName,
      sqlType: finalType,
      notNull: branchRequired.has(propName),
      isRef: finalType !== dialect.jsonType && isRef,
      isJson: isJson || sqlType === 'STRONG_REF',
    })
  }

  return { type: fullType, branchName, tableName, columns, isArray, arrayField, wrapperField }
}

// Generate a TableSchema from a lexicon record definition
export function generateTableSchema(
  nsid: string,
  lexicon: any,
  lexicons?: Map<string, any>,
  dialect: SqlDialect = DUCKDB_DIALECT,
): TableSchema {
  const mainDef = lexicon.defs?.main
  if (!mainDef || mainDef.type !== 'record') {
    throw new Error(`Lexicon ${nsid} does not define a record type`)
  }

  const record = mainDef.record
  if (!record || record.type !== 'object') {
    throw new Error(`Lexicon ${nsid} record is not an object type`)
  }

  const required = new Set(record.required || [])
  const columns: ColumnDef[] = []
  const children: ChildTableSchema[] = []
  const unions: UnionFieldSchema[] = []

  for (const [fieldName, prop] of Object.entries(record.properties || {})) {
    const p = prop as any

    // Check for union fields — decompose into branch child tables
    if (p.type === 'union' && p.refs) {
      const branches: UnionBranchSchema[] = []
      for (const ref of p.refs) {
        const branch = resolveUnionBranch(ref, nsid, fieldName, lexicon.defs, lexicons, dialect)
        if (branch) branches.push(branch)
      }
      if (branches.length > 0) {
        unions.push({ fieldName, branches })
      }
      // Still add the JSON column for the raw union value
      columns.push({
        name: columnName(fieldName),
        originalName: fieldName,
        sqlType: dialect.jsonType,
        notNull: required.has(fieldName),
        isRef: false,
        isJson: true,
      })
      continue
    }

    // Check if this is a decomposable array (array of structured objects)
    if (p.type === 'array') {
      const itemProps = resolveArrayItemProperties(p.items, lexicon.defs)
      if (itemProps) {
        const childColumns: ColumnDef[] = []
        const itemRequired = new Set(p.items?.required || lexicon.defs?.[p.items?.ref?.slice(1)]?.required || [])
        for (const [itemField, itemProp] of Object.entries(itemProps)) {
          const { sqlType, isRef, isJson } = mapType(itemProp as any, dialect)
          childColumns.push({
            name: toSnakeCase(itemField),
            originalName: itemField,
            sqlType,
            notNull: itemRequired.has(itemField),
            isRef,
            isJson,
          })
        }
        const snakeField = toSnakeCase(fieldName)
        children.push({
          parentCollection: nsid,
          fieldName,
          tableName: `"${nsid}__${snakeField}"`,
          columns: childColumns,
        })
        continue
      }
    }

    const { sqlType, isRef, isJson } = mapType(p, dialect)

    if (sqlType === 'STRONG_REF') {
      // Expand strongRef into two columns: {name}_uri and {name}_cid
      columns.push({
        name: toSnakeCase(fieldName) + '_uri',
        originalName: fieldName,
        sqlType: dialect.typeMap.text,
        notNull: required.has(fieldName),
        isRef: true,
        isJson: false,
      })
      columns.push({
        name: toSnakeCase(fieldName) + '_cid',
        originalName: fieldName + '__cid',
        sqlType: dialect.typeMap.text,
        notNull: required.has(fieldName),
        isRef: false,
        isJson: false,
      })
    } else {
      columns.push({
        name: columnName(fieldName),
        originalName: fieldName,
        sqlType,
        notNull: required.has(fieldName),
        isRef,
        isJson,
      })
    }
  }

  const refColumns = columns.filter((c) => c.isRef).map((c) => c.name)

  return {
    collection: nsid,
    tableName: `"${nsid}"`,
    columns,
    refColumns,
    children,
    unions,
  }
}

/**
 * The DDL for a schema, with the tables kept apart from their indexes.
 *
 * They have to be separable because they cannot always run together. An index
 * names a column, and on a database that predates that column the index is the
 * statement that fails — `CREATE TABLE IF NOT EXISTS` has already decided the
 * table is fine as it stands, and the column only arrives when `migrateSchema`
 * runs. So a boot against an existing database creates the tables, reconciles
 * the columns, and only then builds the indexes.
 */
export interface SchemaDDL {
  /** `CREATE TABLE` for the collection and its child and union-branch tables. */
  tables: string[]
  /** `CREATE INDEX` for all of them, safe to run only once the columns exist. */
  indexes: string[]
}

/** The DDL for a schema, split into the two passes {@link SchemaDDL} describes. */
export function generateSchemaDDL(schema: TableSchema, dialect: SqlDialect = DUCKDB_DIALECT): SchemaDDL {
  // `space` is the permissioned space a row came from, and NULL for everything
  // off the firehose. It is the only per-row visibility marker in the schema:
  // a space record is readable by whoever the space's authority admits, so no
  // read may serve one without knowing who is asking. NULL means "public repo
  // data", which is what every existing row is.
  const lines: string[] = [
    '  uri TEXT PRIMARY KEY',
    '  cid TEXT',
    '  did TEXT NOT NULL',
    '  space TEXT',
    `  indexed_at ${dialect.timestampType} NOT NULL`,
  ]

  for (const col of schema.columns) {
    const nullable = col.notNull ? ' NOT NULL' : ''
    lines.push(`  ${q(col.name)} ${col.sqlType}${nullable}`)
  }

  const createTable = `CREATE TABLE IF NOT EXISTS ${schema.tableName} (\n${lines.join(',\n')}\n);`

  const prefix = schema.collection.replace(/\./g, '_')
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_indexed ON ${schema.tableName}(indexed_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_author ON ${schema.tableName}(did);`,
    // Every read that serves space rows filters on this column, and every read
    // that does not still tests it for NULL.
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_space ON ${schema.tableName}(space);`,
  ]

  // Index ref columns for hydration lookups
  for (const refCol of schema.refColumns) {
    indexes.push(`CREATE INDEX IF NOT EXISTS idx_${prefix}_${refCol} ON ${schema.tableName}(${q(refCol)});`)
  }

  // Child and union-branch tables, kept apart from their indexes for the same
  // reason the top-level ones are.
  const childTables: string[] = []
  const childIndexes: string[] = []
  for (const child of schema.children) {
    const childLines: string[] = ['  parent_uri TEXT NOT NULL', '  parent_did TEXT NOT NULL']
    for (const col of child.columns) {
      const nullable = col.notNull ? ' NOT NULL' : ''
      childLines.push(`  ${q(col.name)} ${col.sqlType}${nullable}`)
    }
    childTables.push(`CREATE TABLE IF NOT EXISTS ${child.tableName} (\n${childLines.join(',\n')}\n);`)

    const childPrefix = `${prefix}__${toSnakeCase(child.fieldName)}`
    childIndexes.push(`CREATE INDEX IF NOT EXISTS idx_${childPrefix}_parent ON ${child.tableName}(parent_uri);`)
    childIndexes.push(`CREATE INDEX IF NOT EXISTS idx_${childPrefix}_did ON ${child.tableName}(parent_did);`)

    for (const col of child.columns) {
      if (col.isJson || col.sqlType === 'BLOB') continue
      childIndexes.push(
        `CREATE INDEX IF NOT EXISTS idx_${childPrefix}_${col.name} ON ${child.tableName}(${q(col.name)});`,
      )
    }
  }

  // Union branch table DDL
  for (const union of schema.unions) {
    for (const branch of union.branches) {
      const branchLines: string[] = ['  parent_uri TEXT NOT NULL', '  parent_did TEXT NOT NULL']
      for (const col of branch.columns) {
        const nullable = col.notNull ? ' NOT NULL' : ''
        branchLines.push(`  ${q(col.name)} ${col.sqlType}${nullable}`)
      }
      childTables.push(`CREATE TABLE IF NOT EXISTS ${branch.tableName} (\n${branchLines.join(',\n')}\n);`)

      const branchPrefix = branch.tableName.replace(/"/g, '').replace(/\./g, '_')
      childIndexes.push(`CREATE INDEX IF NOT EXISTS idx_${branchPrefix}_parent ON ${branch.tableName}(parent_uri);`)
      childIndexes.push(`CREATE INDEX IF NOT EXISTS idx_${branchPrefix}_did ON ${branch.tableName}(parent_did);`)

      for (const col of branch.columns) {
        if (col.isJson || col.sqlType === 'BLOB') continue
        childIndexes.push(
          `CREATE INDEX IF NOT EXISTS idx_${branchPrefix}_${col.name} ON ${branch.tableName}(${q(col.name)});`,
        )
      }
    }
  }

  return { tables: [createTable, ...childTables], indexes: [...indexes, ...childIndexes] }
}

/**
 * Both passes as one script, in an order that is valid on a fresh database.
 *
 * What every caller that builds a database from nothing wants — a test, a
 * fixture, the `hatk schema` dump. A boot that may meet an existing database
 * wants {@link generateSchemaDDL} instead, so the migration can run between
 * the two passes.
 */
export function generateCreateTableSQL(schema: TableSchema, dialect: SqlDialect = DUCKDB_DIALECT): string {
  const { tables, indexes } = generateSchemaDDL(schema, dialect)
  return [...tables, ...indexes].join('\n')
}

/**
 * Build table schemas and DDL from lexicons and collections.
 * Shared by main.ts (server boot) and cli.ts (hatk schema command).
 */
export function buildSchemas(
  lexicons: Map<string, any>,
  collections: string[],
  dialect: SqlDialect = DUCKDB_DIALECT,
): { schemas: TableSchema[]; ddlStatements: string[]; indexStatements: string[] } {
  const schemas: TableSchema[] = []
  const ddlStatements: string[] = []
  const indexStatements: string[] = []

  for (const nsid of collections) {
    const lexicon = lexicons.get(nsid)
    if (!lexicon) {
      const prefix = nsid.replace(/\./g, '_')
      ddlStatements.push(`CREATE TABLE IF NOT EXISTS "${nsid}" (
      uri TEXT PRIMARY KEY,
      cid TEXT,
      did TEXT NOT NULL,
      space TEXT,
      indexed_at ${dialect.timestampType} NOT NULL,
      data ${dialect.jsonType}
    );`)
      indexStatements.push(`CREATE INDEX IF NOT EXISTS idx_${prefix}_indexed ON "${nsid}"(indexed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_${prefix}_author ON "${nsid}"(did);
    CREATE INDEX IF NOT EXISTS idx_${prefix}_space ON "${nsid}"(space);`)
      schemas.push({ collection: nsid, tableName: `"${nsid}"`, columns: [], refColumns: [], children: [], unions: [] })
      continue
    }

    const schema = generateTableSchema(nsid, lexicon, lexicons, dialect)
    schemas.push(schema)
    const { tables, indexes } = generateSchemaDDL(schema, dialect)
    ddlStatements.push(tables.join('\n'))
    indexStatements.push(indexes.join('\n'))
  }

  return { schemas, ddlStatements, indexStatements }
}
