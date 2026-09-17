import { beforeAll, expect, test } from 'vitest'
import {
  columnName,
  generateCreateTableSQL,
  generateTableSchema,
  SQLITE_DIALECT,
  storeLexicons,
} from '../src/database/index.ts'
import { createAdapter } from '../src/database/adapter-factory.ts'
import { setSearchPort } from '../src/database/fts.ts'
import { getRecordByUri, initDatabase, insertRecord, reshapeRow } from '../src/database/db.ts'

// A record property named like an envelope column. fyi.opensocial.space has a
// `uri` — the space it points at — and a table cannot have two `uri` columns.
const NSID = 'test.hatk.pointer'
const lexicon = {
  lexicon: 1,
  id: NSID,
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['uri', 'type'],
        properties: {
          uri: { type: 'string', format: 'at-uri' },
          type: { type: 'string' },
          handle: { type: 'string' },
        },
      },
    },
  },
}

test('an envelope name is stored under a prefixed column, everything else as before', () => {
  expect(columnName('uri')).toBe('record_uri')
  expect(columnName('indexedAt')).toBe('record_indexed_at')
  expect(columnName('handle')).toBe('record_handle')
  expect(columnName('createdAt')).toBe('created_at')
})

test('the generated table has one uri column and creates without error', async () => {
  const lexicons = new Map([[NSID, lexicon]])
  const schema = generateTableSchema(NSID, lexicon, lexicons, SQLITE_DIALECT)
  const ddl = generateCreateTableSQL(schema, SQLITE_DIALECT)
  expect(ddl.match(/\buri TEXT PRIMARY KEY/g)).toHaveLength(1)
  expect(ddl).toContain('"record_uri" TEXT')
  expect(schema.columns.find((c) => c.originalName === 'uri')?.name).toBe('record_uri')

  const { adapter, searchPort } = await createAdapter('sqlite')
  setSearchPort(searchPort)
  await initDatabase(adapter, ':memory:', [schema], [ddl])
  storeLexicons(lexicons)
})

test('the field round-trips under its lexicon name', async () => {
  const uri = `at://did:plc:a/${NSID}/1`
  await insertRecord(NSID, uri, 'cid1', 'did:plc:a', {
    uri: 'at://did:plc:b/space/x/self',
    type: 'x',
    handle: 'b.test',
  })
  const row = await getRecordByUri(uri)
  expect(row.uri).toBe(uri)
  expect(row.record_uri).toBe('at://did:plc:b/space/x/self')
  const shaped = reshapeRow(row)!
  expect(shaped.uri).toBe(uri)
  expect(shaped.value).toEqual({ uri: 'at://did:plc:b/space/x/self', type: 'x', handle: 'b.test' })
})

beforeAll(() => {})
