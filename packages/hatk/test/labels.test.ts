import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearLabels,
  defineLabel,
  getLabelDefinitions,
  initLabels,
  registerLabelModule,
  rescanLabels,
  runLabelRules,
} from '../src/labels.ts'
import { insertRecord, queryLabelsForUris, runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase, PRIVATE_COLLECTION, PUBLIC_COLLECTION } from './fixture.ts'

// Label rules run on every indexed record. The two properties that matter:
// a rule's verdict is persisted exactly once per record, and a broken rule
// never stops the others (or the indexer) from doing their work.

const ALICE = 'did:plc:alice'
const uri = (n: number | string, col = PUBLIC_COLLECTION) => `at://${ALICE}/${col}/${n}`
const record = (n: number, text: string) => ({
  uri: uri(n),
  cid: `cid${n}`,
  did: ALICE,
  collection: PUBLIC_COLLECTION,
  value: { text },
})

const spamDef = { identifier: 'spam', severity: 'alert', blurs: 'content', defaultSetting: 'warn' } as const

beforeAll(async () => {
  await setupFixtureDatabase()
})

beforeEach(async () => {
  clearLabels()
  await runSQL(`DELETE FROM _labels`)
})

test('defineLabel tags the module for the scanner and keeps its parts', () => {
  const evaluate = async () => []
  expect(defineLabel({ definition: spamDef, evaluate })).toEqual({ __type: 'labels', definition: spamDef, evaluate })
})

test('with no rules loaded, evaluating a record writes nothing', async () => {
  await runLabelRules(record(1, 'anything'))
  expect(await queryLabelsForUris([uri(1)])).toEqual(new Map())
})

test('a definition-only module is listed but adds no rule', async () => {
  registerLabelModule('spam', { definition: spamDef })
  expect(getLabelDefinitions()).toEqual([spamDef])
  await runLabelRules(record(1, 'buy now'))
  expect(await queryLabelsForUris([uri(1)])).toEqual(new Map())
})

test('a rule verdict is persisted as a self label on the record', async () => {
  registerLabelModule('spam', {
    definition: spamDef,
    evaluate: async ({ record }) => (record.value.text.includes('buy') ? ['spam'] : []),
  })
  await runLabelRules(record(1, 'buy now'))
  await runLabelRules(record(2, 'hello'))

  const labels = await queryLabelsForUris([uri(1), uri(2)])
  expect(labels.get(uri(1))).toEqual([expect.objectContaining({ src: 'self', uri: uri(1), val: 'spam', neg: false })])
  expect(labels.has(uri(2))).toBe(false)
})

test('re-evaluating the same record does not duplicate its label', async () => {
  registerLabelModule('spam', { evaluate: async () => ['spam'] })
  await runLabelRules(record(1, 'x'))
  await runLabelRules(record(1, 'x'))
  expect(await queryLabelsForUris([uri(1)])).toEqual(new Map([[uri(1), [expect.objectContaining({ val: 'spam' })]]]))
})

test('a rule that throws is skipped and the remaining rules still apply', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  registerLabelModule('broken', {
    evaluate: async () => {
      throw new Error('rule bug')
    },
  })
  registerLabelModule('fine', { evaluate: async () => ['ok'] })
  await runLabelRules(record(1, 'x'))
  stdout.mockRestore()
  expect((await queryLabelsForUris([uri(1)])).get(uri(1))?.map((l) => l.val)).toEqual(['ok'])
})

test('rules see the record and can query the database', async () => {
  let ctxSeen: any
  registerLabelModule('inspect', {
    evaluate: async (ctx) => {
      ctxSeen = ctx
      const rows = await ctx.db.query(`SELECT COUNT(*) AS n FROM _repos`)
      return rows.length === 1 ? ['queried'] : []
    },
  })
  await runLabelRules(record(1, 'x'))
  expect(ctxSeen.record).toEqual(record(1, 'x'))
  expect((await queryLabelsForUris([uri(1)])).get(uri(1))?.map((l) => l.val)).toEqual(['queried'])
})

test('a rescan walks every stored record in the named collections and counts what it added', async () => {
  await insertRecord(PUBLIC_COLLECTION, uri('r1'), 'c1', ALICE, { text: 'buy this' })
  await insertRecord(PUBLIC_COLLECTION, uri('r2'), 'c2', ALICE, { text: 'hello' })
  await insertRecord(PRIVATE_COLLECTION, uri('r3', PRIVATE_COLLECTION), 'c3', ALICE, { text: 'buy that' })

  const seen: Array<{ collection: string; text: string }> = []
  registerLabelModule('spam', {
    evaluate: async ({ record }) => {
      seen.push({ collection: record.collection, text: record.value.text })
      return record.value.text.startsWith('buy') ? ['spam'] : []
    },
  })

  // An unknown collection has no table and is skipped, not an error.
  const first = await rescanLabels([PUBLIC_COLLECTION, PRIVATE_COLLECTION, 'xyz.unknown'])
  expect(first).toEqual({ scanned: 3, labeled: 2 })
  // Rules see the record value under its lexicon field names.
  expect(seen).toContainEqual({ collection: PUBLIC_COLLECTION, text: 'buy this' })
  expect(seen).toContainEqual({ collection: PRIVATE_COLLECTION, text: 'buy that' })

  // Running again scans everything but adds nothing new.
  expect(await rescanLabels([PUBLIC_COLLECTION, PRIVATE_COLLECTION])).toEqual({ scanned: 3, labeled: 0 })
})

test('clearLabels drops definitions and rules together', async () => {
  registerLabelModule('spam', { definition: spamDef, evaluate: async () => ['spam'] })
  clearLabels()
  expect(getLabelDefinitions()).toEqual([])
  await runLabelRules(record(9, 'x'))
  expect(await queryLabelsForUris([uri(9)])).toEqual(new Map())
})

// --- Discovery from a labels/ directory ---

let dir: string
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('initLabels loads definitions and rules from disk, skipping underscore-prefixed files', async () => {
  dir = await mkdtemp(join(tmpdir(), 'hatk-labels-'))
  await writeFile(
    join(dir, 'nsfw.ts'),
    `export default {
      definition: { identifier: 'nsfw', severity: 'alert', blurs: 'media', defaultSetting: 'warn' },
      async evaluate(ctx) { return ctx.record.value.text === 'nsfw' ? ['nsfw'] : [] },
    }\n`,
  )
  await writeFile(
    join(dir, 'meta.js'),
    `export default { definition: { identifier: 'meta', severity: 'inform', blurs: 'none', defaultSetting: 'ignore' } }\n`,
  )
  await writeFile(join(dir, '_util.ts'), `export default { evaluate: async () => ['from-helper'] }\n`)

  await initLabels(dir)
  expect(getLabelDefinitions().map((d) => d.identifier)).toEqual(['meta', 'nsfw'])

  await runLabelRules(record(1, 'nsfw'))
  expect((await queryLabelsForUris([uri(1)])).get(uri(1))?.map((l) => l.val)).toEqual(['nsfw'])
})

test('a missing labels directory is not an error', async () => {
  await expect(initLabels(join(tmpdir(), 'hatk-labels-does-not-exist'))).resolves.toBeUndefined()
  expect(getLabelDefinitions()).toEqual([])
})
