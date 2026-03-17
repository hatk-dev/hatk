import { getSchema, runSQL, getSqlDialect, querySQL } from './db.ts'
import { getLexicon } from './schema.ts'
import { emit, timer } from '../logger.ts'
import type { SearchPort } from './ports.ts'

interface SearchColumn {
  expr: string // SQL expression for the shadow table SELECT
  alias: string // column name in the shadow table
}

/**
 * Resolve a lexicon ref like "#artist" to its definition.
 * Only handles local refs (same lexicon).
 */
function resolveRef(ref: string, lexicon: any): any | null {
  if (!ref.startsWith('#')) return null
  const defName = ref.slice(1)
  return lexicon.defs?.[defName] || null
}

/**
 * Given a JSON column and its lexicon property definition, produce
 * search column expressions that extract searchable text.
 */
function jsonSearchColumns(
  colName: string,
  prop: any,
  lexicon: any,
  dialect: import('./dialect.ts').SqlDialect,
): SearchColumn[] {
  const columns: SearchColumn[] = []
  // Strip table qualifier (e.g. "t.artists" → "artists") for use in aliases
  const aliasBase = colName.includes('.') ? colName.split('.').pop()! : colName

  if (prop.type === 'array' && prop.items) {
    const itemDef = prop.items.type === 'ref' && prop.items.ref ? resolveRef(prop.items.ref, lexicon) : prop.items

    if (!itemDef) return columns

    if (itemDef.type === 'string') {
      // array of strings — join into one text column
      columns.push({
        expr: dialect.jsonArrayStringAgg(colName, '$[*]'),
        alias: `${aliasBase}_text`,
      })
    } else if (itemDef.type === 'object' && itemDef.properties) {
      // array of objects — one column per string property
      for (const [field, fieldProp] of Object.entries(itemDef.properties as Record<string, any>)) {
        if (fieldProp.type === 'string') {
          columns.push({
            expr: dialect.jsonArrayStringAgg(colName, `$[*].${field}`),
            alias: `${aliasBase}_${field}`,
          })
        }
      }
    }
  } else if (prop.type === 'object' && prop.properties) {
    // plain object — one column per string property
    for (const [field, fieldProp] of Object.entries(prop.properties as Record<string, any>)) {
      if ((fieldProp as any).type === 'string') {
        columns.push({
          expr: dialect.jsonExtractString(colName, `$.${field}`),
          alias: `${aliasBase}_${field}`,
        })
      }
    }
  }
  // blob, union, unknown — skip (no useful text to extract)

  return columns
}

let searchPort: SearchPort | null = null

export function setSearchPort(port: SearchPort | null): void {
  searchPort = port
}

export function hasSearchPort(): boolean {
  return searchPort !== null
}

export function getSearchPort(): SearchPort | null {
  return searchPort
}

// Tracks when each collection's FTS index was last rebuilt
const lastRebuiltAt = new Map<string, string>()

// Cache of search column metadata per collection, populated during buildFtsIndex
const searchColumnCache = new Map<string, string[]>()

// Cache of computed FTS schemas per collection (deterministic, so compute once)
const ftsSchemaCache = new Map<string, { searchColNames: string[]; sourceQuery: string; safeName: string }>()

export function getSearchColumns(collection: string): string[] {
  return searchColumnCache.get(collection) || []
}

export function getLastRebuiltAt(collection: string): string | null {
  return lastRebuiltAt.get(collection) ?? null
}

/**
 * DuckDB FTS can't handle dots in table names (interprets them as catalog.schema.table).
 * We create a shadow table with underscored names for FTS indexing.
 */
export function ftsTableName(collection: string): string {
  return '_fts_' + collection.replace(/\./g, '_')
}

/**
 * Compute the FTS schema for a collection: search column names, source query, and safe table name.
 */
function computeFtsSchema(collection: string): { searchColNames: string[]; sourceQuery: string; safeName: string } {
  const cached = ftsSchemaCache.get(collection)
  if (cached) return cached
  const schema = getSchema(collection)
  if (!schema) throw new Error(`Unknown collection: ${collection}`)

  const lexicon = getLexicon(collection)
  const record = lexicon?.defs?.main?.record

  // Build column list for shadow table
  const dialect = getSqlDialect()
  const selectExprs: string[] = ['t.uri', 't.cid', 't.did', 't.indexed_at']
  const searchColNames: string[] = []

  for (const col of schema.columns) {
    if (col.sqlType === 'TEXT') {
      selectExprs.push(`t.${col.name}`)
      searchColNames.push(col.name)
    } else if ((col.sqlType === 'JSON' || col.sqlType === 'TEXT') && record?.properties) {
      const prop = record.properties[col.originalName]
      if (prop?.type === 'blob') continue // skip blobs
      if (prop && lexicon) {
        const derived = jsonSearchColumns(`t.${col.name}`, prop, lexicon, dialect)
        if (derived.length > 0) {
          for (const d of derived) {
            selectExprs.push(`${d.expr} AS ${d.alias}`)
            searchColNames.push(d.alias)
          }
          continue
        }
      }
      // Fallback: cast JSON to TEXT
      selectExprs.push(`CAST(t.${col.name} AS TEXT) AS ${col.name}`)
      searchColNames.push(col.name)
    }
  }

  // Include searchable text from child tables (decomposed array fields)
  for (const child of schema.children) {
    for (const col of child.columns) {
      if (col.sqlType === 'TEXT') {
        const alias = `${child.fieldName}_${col.name}`
        const agg = dialect.stringAgg(`c.${col.name}`, "' '")
        selectExprs.push(`(SELECT ${agg} FROM ${child.tableName} c WHERE c.parent_uri = t.uri) AS ${alias}`)
        searchColNames.push(alias)
      }
    }
  }

  // Include searchable text from union branch tables
  for (const union of schema.unions) {
    for (const branch of union.branches) {
      for (const col of branch.columns) {
        if (col.sqlType === 'TEXT') {
          const alias = `${union.fieldName}_${branch.branchName}_${col.name}`
          const agg = dialect.stringAgg(`c.${col.name}`, "' '")
          selectExprs.push(`(SELECT ${agg} FROM ${branch.tableName} c WHERE c.parent_uri = t.uri) AS ${alias}`)
          searchColNames.push(alias)
        }
      }
    }
  }

  // Include handle from _repos for people search
  selectExprs.push('r.handle')
  searchColNames.push('handle')

  const safeName = ftsTableName(collection)
  const sourceQuery = `SELECT ${selectExprs.join(', ')} FROM ${schema.tableName} t LEFT JOIN _repos r ON t.did = r.did`

  const result = { searchColNames, sourceQuery, safeName }
  ftsSchemaCache.set(collection, result)
  return result
}

/**
 * Build FTS index for a collection.
 * Creates a shadow table copy and indexes all TEXT NOT NULL columns
 * using Porter stemmer with English stopwords.
 */
export async function buildFtsIndex(collection: string): Promise<void> {
  if (!searchPort) return // No FTS support for this adapter

  const { searchColNames, sourceQuery, safeName } = computeFtsSchema(collection)
  if (searchColNames.length === 0) return

  // For incremental ports: skip rebuild if index already exists
  if (searchPort.indexExists) {
    const exists = await searchPort.indexExists(safeName)
    if (exists) {
      searchColumnCache.set(collection, searchColNames)
      lastRebuiltAt.set(collection, new Date().toISOString())
      return
    }
  }

  await searchPort.buildIndex(safeName, sourceQuery, searchColNames)
  searchColumnCache.set(collection, searchColNames)
  lastRebuiltAt.set(collection, new Date().toISOString())
}

export async function buildFtsRow(collection: string, uri: string): Promise<Record<string, string | null> | null> {
  const { searchColNames, sourceQuery } = computeFtsSchema(collection)
  if (searchColNames.length === 0) return null

  // Append WHERE clause to filter for single record
  const sql = sourceQuery + ' WHERE t.uri = $1'
  const rows = await querySQL(sql, [uri])
  if (!rows || rows.length === 0) return null

  const row = rows[0] as Record<string, any>
  const result: Record<string, string | null> = {}
  for (const col of searchColNames) {
    result[col] = row[col] != null ? String(row[col]) : null
  }
  return result
}

export async function updateFtsRecord(collection: string, uri: string): Promise<void> {
  if (!searchPort || !searchPort.updateIndex) return

  const searchCols = searchColumnCache.get(collection)
  if (!searchCols || searchCols.length === 0) return

  try {
    const row = await buildFtsRow(collection, uri)
    if (!row) return

    const safeName = ftsTableName(collection)
    await searchPort.updateIndex(safeName, uri, row, searchCols)
  } catch (err) {
    emit('fts', 'update_error', { collection, uri, error: (err as Error).message })
  }
}

export async function deleteFtsRecord(collection: string, uri: string): Promise<void> {
  if (!searchPort || !searchPort.deleteFromIndex) return

  const searchCols = searchColumnCache.get(collection)
  if (!searchCols || searchCols.length === 0) return

  try {
    const safeName = ftsTableName(collection)
    await searchPort.deleteFromIndex(safeName, uri, searchCols)
  } catch (err) {
    emit('fts', 'delete_error', { collection, uri, error: (err as Error).message })
  }
}

/**
 * Rebuild FTS indexes for all registered collections.
 */
// DuckDB's built-in English stop words (571 words) — must match stopwords='english' in create_fts_index
const ENGLISH_STOP_WORDS = new Set([
  'a',
  "a's",
  'able',
  'about',
  'above',
  'according',
  'accordingly',
  'across',
  'actually',
  'after',
  'afterwards',
  'again',
  'against',
  "ain't",
  'all',
  'allow',
  'allows',
  'almost',
  'alone',
  'along',
  'already',
  'also',
  'although',
  'always',
  'am',
  'among',
  'amongst',
  'an',
  'and',
  'another',
  'any',
  'anybody',
  'anyhow',
  'anyone',
  'anything',
  'anyway',
  'anyways',
  'anywhere',
  'apart',
  'appear',
  'appreciate',
  'appropriate',
  'are',
  "aren't",
  'around',
  'as',
  'aside',
  'ask',
  'asking',
  'associated',
  'at',
  'available',
  'away',
  'awfully',
  'b',
  'be',
  'became',
  'because',
  'become',
  'becomes',
  'becoming',
  'been',
  'before',
  'beforehand',
  'behind',
  'being',
  'believe',
  'below',
  'beside',
  'besides',
  'best',
  'better',
  'between',
  'beyond',
  'both',
  'brief',
  'but',
  'by',
  'c',
  "c'mon",
  "c's",
  'came',
  'can',
  "can't",
  'cannot',
  'cant',
  'cause',
  'causes',
  'certain',
  'certainly',
  'changes',
  'clearly',
  'co',
  'com',
  'come',
  'comes',
  'concerning',
  'consequently',
  'consider',
  'considering',
  'contain',
  'containing',
  'contains',
  'corresponding',
  'could',
  "couldn't",
  'course',
  'currently',
  'd',
  'definitely',
  'described',
  'despite',
  'did',
  "didn't",
  'different',
  'do',
  'does',
  "doesn't",
  'doing',
  "don't",
  'done',
  'down',
  'downwards',
  'during',
  'e',
  'each',
  'edu',
  'eg',
  'eight',
  'either',
  'else',
  'elsewhere',
  'enough',
  'entirely',
  'especially',
  'et',
  'etc',
  'even',
  'ever',
  'every',
  'everybody',
  'everyone',
  'everything',
  'everywhere',
  'ex',
  'exactly',
  'example',
  'except',
  'f',
  'far',
  'few',
  'fifth',
  'first',
  'five',
  'followed',
  'following',
  'follows',
  'for',
  'former',
  'formerly',
  'forth',
  'four',
  'from',
  'further',
  'furthermore',
  'g',
  'get',
  'gets',
  'getting',
  'given',
  'gives',
  'go',
  'goes',
  'going',
  'gone',
  'got',
  'gotten',
  'greetings',
  'h',
  'had',
  "hadn't",
  'happens',
  'hardly',
  'has',
  "hasn't",
  'have',
  "haven't",
  'having',
  'he',
  "he's",
  'hello',
  'help',
  'hence',
  'her',
  'here',
  "here's",
  'hereafter',
  'hereby',
  'herein',
  'hereupon',
  'hers',
  'herself',
  'hi',
  'him',
  'himself',
  'his',
  'hither',
  'hopefully',
  'how',
  'howbeit',
  'however',
  'i',
  "i'd",
  "i'll",
  "i'm",
  "i've",
  'ie',
  'if',
  'ignored',
  'immediate',
  'in',
  'inasmuch',
  'inc',
  'indeed',
  'indicate',
  'indicated',
  'indicates',
  'inner',
  'insofar',
  'instead',
  'into',
  'inward',
  'is',
  "isn't",
  'it',
  "it'd",
  "it'll",
  "it's",
  'its',
  'itself',
  'j',
  'just',
  'k',
  'keep',
  'keeps',
  'kept',
  'know',
  'known',
  'knows',
  'l',
  'last',
  'lately',
  'later',
  'latter',
  'latterly',
  'least',
  'less',
  'lest',
  'let',
  "let's",
  'like',
  'liked',
  'likely',
  'little',
  'look',
  'looking',
  'looks',
  'ltd',
  'm',
  'mainly',
  'many',
  'may',
  'maybe',
  'me',
  'mean',
  'meanwhile',
  'merely',
  'might',
  'more',
  'moreover',
  'most',
  'mostly',
  'much',
  'must',
  'my',
  'myself',
  'n',
  'name',
  'namely',
  'nd',
  'near',
  'nearly',
  'necessary',
  'need',
  'needs',
  'neither',
  'never',
  'nevertheless',
  'new',
  'next',
  'nine',
  'no',
  'nobody',
  'non',
  'none',
  'noone',
  'nor',
  'normally',
  'not',
  'nothing',
  'novel',
  'now',
  'nowhere',
  'o',
  'obviously',
  'of',
  'off',
  'often',
  'oh',
  'ok',
  'okay',
  'old',
  'on',
  'once',
  'one',
  'ones',
  'only',
  'onto',
  'or',
  'other',
  'others',
  'otherwise',
  'ought',
  'our',
  'ours',
  'ourselves',
  'out',
  'outside',
  'over',
  'overall',
  'own',
  'p',
  'particular',
  'particularly',
  'per',
  'perhaps',
  'placed',
  'please',
  'plus',
  'possible',
  'presumably',
  'probably',
  'provides',
  'q',
  'que',
  'quite',
  'qv',
  'r',
  'rather',
  'rd',
  're',
  'really',
  'reasonably',
  'regarding',
  'regardless',
  'regards',
  'relatively',
  'respectively',
  'right',
  's',
  'said',
  'same',
  'saw',
  'say',
  'saying',
  'says',
  'second',
  'secondly',
  'see',
  'seeing',
  'seem',
  'seemed',
  'seeming',
  'seems',
  'seen',
  'self',
  'selves',
  'sensible',
  'sent',
  'serious',
  'seriously',
  'seven',
  'several',
  'shall',
  'she',
  'should',
  "shouldn't",
  'since',
  'six',
  'so',
  'some',
  'somebody',
  'somehow',
  'someone',
  'something',
  'sometime',
  'sometimes',
  'somewhat',
  'somewhere',
  'soon',
  'sorry',
  'specified',
  'specify',
  'specifying',
  'still',
  'sub',
  'such',
  'sup',
  'sure',
  't',
  "t's",
  'take',
  'taken',
  'tell',
  'tends',
  'th',
  'than',
  'thank',
  'thanks',
  'thanx',
  'that',
  "that's",
  'thats',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'thence',
  'there',
  "there's",
  'thereafter',
  'thereby',
  'therefore',
  'therein',
  'theres',
  'thereupon',
  'these',
  'they',
  "they'd",
  "they'll",
  "they're",
  "they've",
  'think',
  'third',
  'this',
  'thorough',
  'thoroughly',
  'those',
  'though',
  'three',
  'through',
  'throughout',
  'thru',
  'thus',
  'to',
  'together',
  'too',
  'took',
  'toward',
  'towards',
  'tried',
  'tries',
  'truly',
  'try',
  'trying',
  'twice',
  'two',
  'u',
  'un',
  'under',
  'unfortunately',
  'unless',
  'unlikely',
  'until',
  'unto',
  'up',
  'upon',
  'us',
  'use',
  'used',
  'useful',
  'uses',
  'using',
  'usually',
  'uucp',
  'v',
  'value',
  'various',
  'very',
  'via',
  'viz',
  'vs',
  'w',
  'want',
  'wants',
  'was',
  "wasn't",
  'way',
  'we',
  "we'd",
  "we'll",
  "we're",
  "we've",
  'welcome',
  'well',
  'went',
  'were',
  "weren't",
  'what',
  "what's",
  'whatever',
  'when',
  'whence',
  'whenever',
  'where',
  "where's",
  'whereafter',
  'whereas',
  'whereby',
  'wherein',
  'whereupon',
  'wherever',
  'whether',
  'which',
  'while',
  'whither',
  'who',
  "who's",
  'whoever',
  'whole',
  'whom',
  'whose',
  'why',
  'will',
  'willing',
  'wish',
  'with',
  'within',
  'without',
  "won't",
  'wonder',
  'would',
  'would',
  "wouldn't",
  'x',
  'y',
  'yes',
  'yet',
  'you',
  "you'd",
  "you'll",
  "you're",
  "you've",
  'your',
  'yours',
  'yourself',
  'yourselves',
  'z',
  'zero',
])

/**
 * Strip English stop words from a search query, preserving non-stop-word terms.
 * Returns the cleaned query string. If all words are stop words, returns the original query.
 */
export function stripStopWords(query: string): string {
  const terms = query.trim().split(/\s+/)
  const filtered = terms.filter((t) => !ENGLISH_STOP_WORDS.has(t.toLowerCase()))
  return filtered.length > 0 ? filtered.join(' ') : query
}

export async function rebuildAllIndexes(collections: string[]): Promise<void> {
  const elapsed = timer()
  let rebuilt = 0
  const errors: string[] = []

  for (const collection of collections) {
    try {
      await buildFtsIndex(collection)
      rebuilt++
    } catch (err: any) {
      errors.push(`${collection}: ${err.message}`)
    }
  }

  // Compact WAL to free memory after heavy FTS operations (DuckDB only)
  try {
    const { getSqlDialect } = await import('./db.ts')
    const d = getSqlDialect()
    if (d.checkpointSQL) await runSQL(d.checkpointSQL)
  } catch {}

  emit('fts', 'rebuild', {
    collections_total: collections.length,
    collections_rebuilt: rebuilt,
    error_count: errors.length,
    duration_ms: elapsed(),
    errors: errors.length > 0 ? errors : undefined,
  })
}
