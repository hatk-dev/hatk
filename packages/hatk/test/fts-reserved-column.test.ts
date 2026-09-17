/**
 * A lexicon may name a property `group`, `order`, `from` — all legal NSID
 * property names, all SQL keywords. The FTS shadow/virtual tables must quote
 * every column or the index build fails with a syntax error and search for
 * that collection silently never works.
 */
import { beforeAll, expect, test } from 'vitest'
import { setupFixtureDatabase } from './fixture.ts'
import { storeLexicons, loadLexicons } from '../src/database/schema.ts'
import { buildSchemas, discoverCollections } from '../src/database/schema.ts'
import { getDialect } from '../src/database/dialect.ts'
import { initDatabase, migrateSchema, runSQL } from '../src/database/db.ts'
import { createAdapter } from '../src/database/adapter-factory.ts'
import { setSearchPort, buildFtsIndex, updateFtsRecord } from '../src/database/fts.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NSID = 'test.fts.submission'

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hatk-fts-'))
  mkdirSync(join(dir, 'test', 'fts'), { recursive: true })
  writeFileSync(
    join(dir, 'test', 'fts', 'submission.json'),
    JSON.stringify({
      lexicon: 1,
      id: NSID,
      defs: {
        main: {
          type: 'record',
          key: 'tid',
          record: {
            type: 'object',
            required: ['group', 'order', 'createdAt'],
            properties: {
              group: { type: 'string', format: 'did' },
              order: { type: 'string' },
              createdAt: { type: 'string', format: 'datetime' },
            },
          },
        },
      },
    }),
  )
  const lexicons = loadLexicons(dir)
  storeLexicons(lexicons)
  const collections = discoverCollections(lexicons)
  const { schemas, ddlStatements } = buildSchemas(lexicons, collections, getDialect('sqlite'))
  const { adapter, searchPort } = await createAdapter('sqlite')
  setSearchPort(searchPort)
  await initDatabase(adapter, ':memory:', schemas, ddlStatements)
  await migrateSchema(schemas)
})

test('an FTS index builds and updates for a collection whose columns are SQL keywords', async () => {
  await runSQL(
    `INSERT INTO "${NSID}" (uri, cid, did, indexed_at, "group", "order", created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'at://did:plc:a/test.fts.submission/1',
      'cid1',
      'did:plc:a',
      '2026-01-01T00:00:00Z',
      'did:plc:g',
      'first',
      '2026-01-01T00:00:00Z',
    ],
  )
  await expect(buildFtsIndex(NSID)).resolves.toBeUndefined()
  await expect(updateFtsRecord(NSID, 'at://did:plc:a/test.fts.submission/1')).resolves.toBeUndefined()
})
