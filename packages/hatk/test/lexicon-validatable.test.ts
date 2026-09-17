import { expect, test } from 'vitest'
import { validatableLexicons } from '../src/database/schema.ts'
import { validateLexicons } from '@bigmoves/lexicon'

const record = {
  lexicon: 1,
  id: 'a.b.rec',
  defs: { main: { type: 'record', key: 'tid', record: { type: 'object', properties: {} } } },
}
const query = { lexicon: 1, id: 'a.b.q', defs: { main: { type: 'query', output: { encoding: 'application/json' } } } }
const space = { lexicon: 1, id: 'a.b.space', defs: { main: { type: 'space', key: 'any', collections: ['a.b.rec'] } } }
const permissions = { lexicon: 1, id: 'a.b.perms', defs: { main: { type: 'permission-set', permissions: [] } } }
const defsOnly = { lexicon: 1, id: 'a.b.defs', defs: { thing: { type: 'object', properties: {} } } }

test('a space type and a permission set are kept but not handed to the validator', () => {
  // Both are real lexicons hatk needs — a space type is how the indexer learns
  // which collections a space holds — and the validator reports both as an
  // unknown definition type, which read as a fatal schema error at boot.
  const all = new Map([record, query, space, permissions, defsOnly].map((l) => [l.id, l as any]))
  const ids = validatableLexicons(all).map((l) => l.id)
  expect(ids).toEqual(['a.b.rec', 'a.b.q', 'a.b.defs'])
  expect(validateLexicons(validatableLexicons(all))).toBeNull()
  expect(validateLexicons([space as any])).not.toBeNull()
})

test('a genuinely unknown def type is still handed to the validator', () => {
  // Only the two types hatk knows to be real are set aside. A typo'd type is a
  // broken lexicon, and booting on it would produce a table nobody intended.
  const broken = { lexicon: 1, id: 'a.b.broken', defs: { main: { type: 'notAThing' } } }
  const kept = validatableLexicons(new Map([[broken.id, broken as any]]))
  expect(kept.map((l) => l.id)).toEqual(['a.b.broken'])
  expect(validateLexicons(kept)).not.toBeNull()
})
