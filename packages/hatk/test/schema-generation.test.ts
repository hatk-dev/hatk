/**
 * generateTableSchema decides how every lexicon field is stored: a plain
 * column, a JSON blob, a strongRef pair, a decomposed child table, or a set
 * of union branch tables. The DDL and the insert/reshape code in db.ts both
 * trust that decision, so it is worth pinning field by field.
 */
import { describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSchemas,
  discoverCollections,
  generateCreateTableSQL,
  generateTableSchema,
  getAllLexicons,
  getLexicon,
  getLexiconArray,
  loadLexicons,
  q,
  storeLexicons,
  toSnakeCase,
} from '../src/database/schema.ts'
import { DUCKDB_DIALECT, SQLITE_DIALECT } from '../src/database/dialect.ts'

function recordLexicon(
  id: string,
  properties: Record<string, any>,
  extra: Record<string, any> = {},
  required?: string[],
) {
  return {
    lexicon: 1,
    id,
    defs: {
      main: { type: 'record', key: 'tid', record: { type: 'object', required, properties } },
      ...extra,
    },
  }
}

function column(schema: ReturnType<typeof generateTableSchema>, name: string) {
  const col = schema.columns.find((c) => c.name === name)
  if (!col) throw new Error(`no column ${name}; have ${schema.columns.map((c) => c.name).join(', ')}`)
  return col
}

describe('naming helpers', () => {
  test('toSnakeCase converts each capital into an underscore boundary', () => {
    expect(toSnakeCase('createdAt')).toBe('created_at')
    expect(toSnakeCase('likeCount')).toBe('like_count')
    expect(toSnakeCase('text')).toBe('text')
  })

  test('q double-quotes an identifier so SQL keywords survive as column names', () => {
    expect(q('order')).toBe('"order"')
  })
})

describe('generateTableSchema scalar fields', () => {
  const lex = recordLexicon(
    'test.scalar',
    {
      text: { type: 'string' },
      createdAt: { type: 'string', format: 'datetime' },
      replyTo: { type: 'string', format: 'at-uri' },
      count: { type: 'integer' },
      pinned: { type: 'boolean' },
      raw: { type: 'bytes' },
      link: { type: 'cid-link' },
      anything: { type: 'unknown' },
      meta: { type: 'object', properties: { mood: { type: 'string' } } },
      avatar: { type: 'blob' },
      tags: { type: 'array', items: { type: 'string' } },
      mystery: { type: 'made-up-type' },
    },
    {},
    ['text', 'createdAt'],
  )

  test('maps each lexicon type onto a DuckDB column type by default', () => {
    const schema = generateTableSchema('test.scalar', lex)
    expect(schema.tableName).toBe('"test.scalar"')
    expect(column(schema, 'text').sqlType).toBe('TEXT')
    expect(column(schema, 'created_at').sqlType).toBe('TIMESTAMP')
    expect(column(schema, 'count').sqlType).toBe('INTEGER')
    expect(column(schema, 'pinned').sqlType).toBe('BOOLEAN')
    expect(column(schema, 'raw').sqlType).toBe('BLOB')
    expect(column(schema, 'link').sqlType).toBe('TEXT')
    expect(column(schema, 'anything').sqlType).toBe('JSON')
    expect(column(schema, 'meta').sqlType).toBe('JSON')
    expect(column(schema, 'avatar').sqlType).toBe('JSON')
    expect(column(schema, 'tags').sqlType).toBe('JSON')
  })

  test('an unrecognized lexicon type degrades to TEXT rather than failing the boot', () => {
    const schema = generateTableSchema('test.scalar', lex)
    expect(column(schema, 'mystery').sqlType).toBe('TEXT')
  })

  test('the SQLite dialect stores JSON, timestamps and booleans as TEXT/INTEGER', () => {
    const schema = generateTableSchema('test.scalar', lex, undefined, SQLITE_DIALECT)
    expect(column(schema, 'created_at').sqlType).toBe('TEXT')
    expect(column(schema, 'pinned').sqlType).toBe('INTEGER')
    expect(column(schema, 'meta').sqlType).toBe('TEXT')
    // The JSON flag survives the type collapse — reshapeRow needs it to parse
    expect(column(schema, 'meta').isJson).toBe(true)
  })

  test('marks required fields NOT NULL and everything else nullable', () => {
    const schema = generateTableSchema('test.scalar', lex)
    expect(column(schema, 'text').notNull).toBe(true)
    expect(column(schema, 'created_at').notNull).toBe(true)
    expect(column(schema, 'count').notNull).toBe(false)
  })

  test('an at-uri string is a ref column and lands in refColumns for indexing', () => {
    const schema = generateTableSchema('test.scalar', lex)
    expect(column(schema, 'reply_to').isRef).toBe(true)
    expect(schema.refColumns).toEqual(['reply_to'])
  })

  test('arrays of strings stay a single JSON column rather than a child table', () => {
    const schema = generateTableSchema('test.scalar', lex)
    expect(column(schema, 'tags').isJson).toBe(true)
    expect(schema.children).toEqual([])
  })

  test('keeps the original camelCase name next to the snake_case column for reshaping', () => {
    const schema = generateTableSchema('test.scalar', lex)
    expect(column(schema, 'created_at').originalName).toBe('createdAt')
  })
})

describe('generateTableSchema refs', () => {
  test('a strongRef expands into a _uri ref column and a _cid column', () => {
    const lex = recordLexicon('test.like', { subject: { type: 'ref', ref: 'com.atproto.repo.strongRef' } }, {}, [
      'subject',
    ])
    const schema = generateTableSchema('test.like', lex)
    const uri = column(schema, 'subject_uri')
    const cid = column(schema, 'subject_cid')
    expect(uri).toMatchObject({ originalName: 'subject', isRef: true, notNull: true, sqlType: 'TEXT' })
    // The __cid suffix is what buildInsertOp keys on to read record.subject.cid
    expect(cid).toMatchObject({ originalName: 'subject__cid', isRef: false, notNull: true })
    expect(schema.refColumns).toEqual(['subject_uri'])
  })

  test('a ref to any other object def is stored as JSON', () => {
    const lex = recordLexicon(
      'test.ref',
      { location: { type: 'ref', ref: '#geo' } },
      { geo: { type: 'object', properties: { lat: { type: 'string' } } } },
    )
    const schema = generateTableSchema('test.ref', lex)
    expect(column(schema, 'location')).toMatchObject({ sqlType: 'JSON', isJson: true, isRef: false })
  })
})

describe('generateTableSchema decomposed arrays', () => {
  test('an array of inline objects becomes a child table with one column per item property', () => {
    const lex = recordLexicon('test.album', {
      artists: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, roleName: { type: 'string' }, born: { type: 'integer' } },
        },
      },
    })
    const schema = generateTableSchema('test.album', lex)
    expect(schema.columns).toEqual([]) // nothing left on the parent
    expect(schema.children).toHaveLength(1)
    const child = schema.children[0]
    expect(child.tableName).toBe('"test.album__artists"')
    expect(child.fieldName).toBe('artists')
    expect(child.parentCollection).toBe('test.album')
    expect(child.columns.map((c) => c.name)).toEqual(['name', 'role_name', 'born'])
    expect(child.columns[0].notNull).toBe(true)
    expect(child.columns[1].notNull).toBe(false)
  })

  test('an array of local #ref objects also decomposes, taking required from the referenced def', () => {
    const lex = recordLexicon(
      'test.album',
      { trackList: { type: 'array', items: { type: 'ref', ref: '#track' } } },
      {
        track: {
          type: 'object',
          required: ['title'],
          properties: { title: { type: 'string' }, secs: { type: 'integer' } },
        },
      },
    )
    const schema = generateTableSchema('test.album', lex)
    expect(schema.children[0].tableName).toBe('"test.album__track_list"')
    expect(schema.children[0].columns.find((c) => c.name === 'title')?.notNull).toBe(true)
    expect(schema.children[0].columns.find((c) => c.name === 'secs')?.notNull).toBe(false)
  })

  test('an array whose ref cannot be resolved to an object stays a JSON column', () => {
    // Cross-lexicon item refs are not decomposed; the data is still stored.
    const lex = recordLexicon('test.album', {
      credits: { type: 'array', items: { type: 'ref', ref: 'other.lex#credit' } },
    })
    const schema = generateTableSchema('test.album', lex)
    expect(schema.children).toEqual([])
    expect(column(schema, 'credits').isJson).toBe(true)
  })
})

describe('generateTableSchema unions', () => {
  const lexicons = new Map<string, any>()
  const postLex = recordLexicon(
    'test.post',
    { embed: { type: 'union', refs: ['#images', '#external', 'test.quote', 'test.other#card', '#notAnObject'] } },
    {
      images: { type: 'object', properties: { images: { type: 'array', items: { type: 'ref', ref: '#image' } } } },
      image: { type: 'object', required: ['alt'], properties: { alt: { type: 'string' }, img: { type: 'blob' } } },
      external: { type: 'object', properties: { external: { type: 'ref', ref: '#externalInfo' } } },
      externalInfo: { type: 'object', properties: { uri: { type: 'string' }, title: { type: 'string' } } },
      notAnObject: { type: 'string' },
    },
  )
  lexicons.set('test.post', postLex)
  lexicons.set('test.quote', {
    lexicon: 1,
    id: 'test.quote',
    defs: {
      main: { type: 'object', properties: { uri: { type: 'string', format: 'at-uri' }, note: { type: 'string' } } },
    },
  })
  lexicons.set('test.other', {
    lexicon: 1,
    id: 'test.other',
    defs: {
      card: {
        type: 'object',
        properties: { heading: { type: 'string' }, ref: { type: 'ref', ref: 'com.atproto.repo.strongRef' } },
      },
    },
  })

  const schema = generateTableSchema('test.post', postLex, lexicons)
  const branches = schema.unions[0].branches
  const branch = (name: string) => {
    const b = branches.find((b) => b.branchName === name)
    if (!b) throw new Error(`no branch ${name}; have ${branches.map((b) => b.branchName).join(', ')}`)
    return b
  }

  test('keeps the raw union value as a JSON column alongside the branch tables', () => {
    expect(column(schema, 'embed')).toMatchObject({ sqlType: 'JSON', isJson: true })
  })

  test('resolves branches that are objects and drops ones that are not', () => {
    expect(branches.map((b) => b.branchName).sort()).toEqual(['card', 'external', 'images', 'quote'])
  })

  test('a local #ref branch gets the collection-qualified $type', () => {
    expect(branch('images').type).toBe('test.post#images')
    expect(branch('images').tableName).toBe('"test.post__embed_images"')
  })

  test('a branch wrapping a single array of objects is flattened to one row per item', () => {
    const b = branch('images')
    expect(b.isArray).toBe(true)
    expect(b.arrayField).toBe('images')
    expect(b.columns.map((c) => c.name)).toEqual(['alt', 'img'])
  })

  test('a flattened array branch takes NOT NULL from the item def, as child tables do', () => {
    // The columns come from #image, so #image's `required` is what applies —
    // not the outer #images def, whose `required` describes the wrapper array.
    const b = branch('images')
    expect(b.columns.find((c) => c.name === 'alt')!.notNull).toBe(true)
    expect(b.columns.find((c) => c.name === 'img')!.notNull).toBe(false)
  })

  test('a wrapped-ref branch with no required properties leaves every column nullable', () => {
    expect(branch('external').columns.map((c) => c.notNull)).toEqual([false, false])
  })

  test('a branch wrapping a single ref object records the wrapper key for reshaping', () => {
    const b = branch('external')
    expect(b.isArray).toBe(false)
    expect(b.wrapperField).toBe('external')
    expect(b.columns.map((c) => c.name)).toEqual(['uri', 'title'])
  })

  test('a bare-NSID ref resolves through defs.main and keeps the full NSID as $type', () => {
    const b = branch('quote')
    expect(b.type).toBe('test.quote')
    expect(b.columns.map((c) => c.name)).toEqual(['uri', 'note'])
  })

  test('an nsid#def ref resolves in the other lexicon; strongRefs inside a branch stay JSON', () => {
    const b = branch('card')
    expect(b.type).toBe('test.other#card')
    const ref = b.columns.find((c) => c.name === 'ref')!
    // No _uri/_cid expansion in branch tables — one JSON column instead
    expect(ref).toMatchObject({ sqlType: 'JSON', isJson: true, isRef: false })
  })

  test('a union none of whose refs resolve produces no branch tables but keeps the column', () => {
    const lex = recordLexicon('test.empty', { embed: { type: 'union', refs: ['#missing'] } })
    const s = generateTableSchema('test.empty', lex)
    expect(s.unions).toEqual([])
    expect(column(s, 'embed').isJson).toBe(true)
  })
})

describe('generateTableSchema validation', () => {
  test('rejects a lexicon whose main def is not a record', () => {
    const lex = { lexicon: 1, id: 'test.query', defs: { main: { type: 'query' } } }
    expect(() => generateTableSchema('test.query', lex)).toThrow(/does not define a record type/)
  })

  test('rejects a record whose body is not an object', () => {
    const lex = { lexicon: 1, id: 'test.bad', defs: { main: { type: 'record', record: { type: 'string' } } } }
    expect(() => generateTableSchema('test.bad', lex)).toThrow(/record is not an object type/)
  })

  test('a record with no properties still gets the envelope columns', () => {
    const lex = { lexicon: 1, id: 'test.bare', defs: { main: { type: 'record', record: { type: 'object' } } } }
    const schema = generateTableSchema('test.bare', lex)
    expect(schema.columns).toEqual([])
    expect(generateCreateTableSQL(schema)).toContain('uri TEXT PRIMARY KEY')
  })
})

describe('generateCreateTableSQL', () => {
  const lex = recordLexicon(
    'app.demo.post',
    {
      text: { type: 'string' },
      replyTo: { type: 'string', format: 'at-uri' },
      artists: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, extra: { type: 'unknown' }, sig: { type: 'bytes' } },
        },
      },
      embed: { type: 'union', refs: ['#ext'] },
    },
    { ext: { type: 'object', properties: { title: { type: 'string' }, thumb: { type: 'blob' } } } },
    ['text'],
  )

  test('always emits the envelope columns and the indexed_at/author indexes', () => {
    const sql = generateCreateTableSQL(generateTableSchema('app.demo.post', lex))
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "app.demo.post" (')
    expect(sql).toContain('uri TEXT PRIMARY KEY')
    expect(sql).toContain('did TEXT NOT NULL')
    expect(sql).toContain('indexed_at TIMESTAMP NOT NULL')
    expect(sql).toContain('"text" TEXT NOT NULL')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_app_demo_post_indexed ON "app.demo.post"(indexed_at DESC);')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_app_demo_post_author ON "app.demo.post"(did);')
  })

  test('indexes every ref column so hydration lookups do not scan', () => {
    const sql = generateCreateTableSQL(generateTableSchema('app.demo.post', lex))
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_app_demo_post_reply_to ON "app.demo.post"("reply_to");')
  })

  test('uses the dialect timestamp type for indexed_at', () => {
    const schema = generateTableSchema('app.demo.post', lex, undefined, SQLITE_DIALECT)
    expect(generateCreateTableSQL(schema, SQLITE_DIALECT)).toContain('indexed_at TEXT NOT NULL')
  })

  test('child tables carry parent_uri/parent_did with indexes and skip indexing JSON/BLOB columns', () => {
    const sql = generateCreateTableSQL(generateTableSchema('app.demo.post', lex))
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "app.demo.post__artists" (')
    expect(sql).toContain('parent_uri TEXT NOT NULL')
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_app_demo_post__artists_parent ON "app.demo.post__artists"(parent_uri);',
    )
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_app_demo_post__artists_did ON "app.demo.post__artists"(parent_did);',
    )
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_app_demo_post__artists_name ON "app.demo.post__artists"("name");',
    )
    expect(sql).not.toContain('idx_app_demo_post__artists_extra')
    expect(sql).not.toContain('idx_app_demo_post__artists_sig')
  })

  test('union branch tables get the same treatment, keyed by the branch table name', () => {
    const sql = generateCreateTableSQL(generateTableSchema('app.demo.post', lex))
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "app.demo.post__embed_ext" (')
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_app_demo_post__embed_ext_parent ON "app.demo.post__embed_ext"(parent_uri);',
    )
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_app_demo_post__embed_ext_title ON "app.demo.post__embed_ext"("title");',
    )
    expect(sql).not.toContain('idx_app_demo_post__embed_ext_thumb')
  })

  test('quotes column names so a property called "order" or "group" is valid DDL', () => {
    const keywords = recordLexicon('test.kw', { order: { type: 'string' }, group: { type: 'string' } })
    const sql = generateCreateTableSQL(generateTableSchema('test.kw', keywords))
    expect(sql).toContain('"order" TEXT')
    expect(sql).toContain('"group" TEXT')
  })
})

describe('buildSchemas', () => {
  test('generates a schema and DDL for each collection with a lexicon', () => {
    const lexicons = new Map([['test.a', recordLexicon('test.a', { text: { type: 'string' } })]])
    const { schemas, ddlStatements } = buildSchemas(lexicons, ['test.a'], SQLITE_DIALECT)
    expect(schemas).toHaveLength(1)
    expect(schemas[0].columns.map((c) => c.name)).toEqual(['text'])
    expect(ddlStatements[0]).toContain('CREATE TABLE IF NOT EXISTS "test.a"')
  })

  test('a configured collection with no lexicon falls back to a generic data-column table', () => {
    // Lets an app index a collection it only knows by NSID; the empty
    // columns list is what tells migrateSchema to leave the table alone.
    const { schemas, ddlStatements, indexStatements } = buildSchemas(new Map(), ['test.unknown'], DUCKDB_DIALECT)
    expect(schemas[0]).toEqual({
      collection: 'test.unknown',
      tableName: '"test.unknown"',
      columns: [],
      refColumns: [],
      children: [],
      unions: [],
    })
    expect(ddlStatements[0]).toContain('data JSON')
    // The index is held back for the second pass, the same as any other table's:
    // it cannot run until the columns are reconciled.
    expect(ddlStatements[0]).not.toContain('CREATE INDEX')
    expect(indexStatements[0]).toContain('idx_test_unknown_indexed')
    expect(indexStatements[0]).toContain('idx_test_unknown_space')
  })
})

describe('lexicon loading and registry', () => {
  test('loadLexicons walks nested directories and skips JSON that is not a lexicon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hatk-lex-'))
    mkdirSync(join(dir, 'app', 'demo'), { recursive: true })
    writeFileSync(join(dir, 'app', 'demo', 'post.json'), JSON.stringify(recordLexicon('app.demo.post', {})))
    writeFileSync(join(dir, 'app', 'defs.json'), JSON.stringify({ lexicon: 1, id: 'app.demo.defs', defs: {} }))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'not-a-lexicon' }))
    writeFileSync(join(dir, 'README.md'), '# ignored')

    const lexicons = loadLexicons(dir)
    expect([...lexicons.keys()].sort()).toEqual(['app.demo.defs', 'app.demo.post'])
  })

  test('discoverCollections returns only record-type lexicons, sorted', () => {
    const lexicons = new Map<string, any>([
      ['zz.last', recordLexicon('zz.last', {})],
      ['aa.first', recordLexicon('aa.first', {})],
      ['mm.query', { lexicon: 1, id: 'mm.query', defs: { main: { type: 'query' } } }],
      ['mm.defs', { lexicon: 1, id: 'mm.defs', defs: {} }],
    ])
    expect(discoverCollections(lexicons)).toEqual(['aa.first', 'zz.last'])
  })

  test('storeLexicons accumulates across calls and is readable by NSID or as arrays', () => {
    storeLexicons(new Map([['test.one', recordLexicon('test.one', {})]]))
    storeLexicons(new Map([['test.two', recordLexicon('test.two', {})]]))
    expect(getLexicon('test.one')?.id).toBe('test.one')
    expect(getLexicon('test.nope')).toBeUndefined()
    expect(
      getAllLexicons()
        .map((l) => l.nsid)
        .sort(),
    ).toEqual(['test.one', 'test.two'])
    expect(
      getLexiconArray()
        .map((l) => l.id)
        .sort(),
    ).toEqual(['test.one', 'test.two'])
  })
})
