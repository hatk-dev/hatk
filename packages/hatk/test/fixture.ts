import {
  createAdapter,
  initDatabase,
  generateTableSchema,
  generateCreateTableSQL,
  SQLITE_DIALECT,
} from '../src/database/index.ts'
import { setSearchPort } from '../src/database/fts.ts'

/**
 * hatk itself has no `hatk.config.ts` or `lexicons/` directory (those belong to
 * apps built on top of hatk), so `createTestContext` from `src/test.ts` can't be
 * used here — it walks up from cwd looking for exactly that config. This fixture
 * is the minimal direct equivalent: hand-written lexicons plus the same
 * generateTableSchema -> generateCreateTableSQL -> createAdapter -> initDatabase
 * pipeline `createTestContext` runs internally (see src/test.ts:73-110).
 *
 * A REGISTERED collection matters because `getSchema(collection)` is the thing
 * hatk's generic record endpoints already fall back on to 404 an unrecognized
 * collection. Without a registered schema, every collection looks "unknown" and
 * every endpoint 404s for that reason alone, before a private-collection guard
 * ever gets a chance to run. Registering a schema here removes that confound.
 */

export const PRIVATE_COLLECTION = 'social.switchback.activity'
export const PUBLIC_COLLECTION = 'app.bsky.actor.profile'

/** Minimal record lexicon with one required, searchable (TEXT) field. */
function minimalLexicon(nsid: string) {
  return {
    lexicon: 1,
    id: nsid,
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
          },
        },
      },
    },
  }
}

/**
 * Stand up an in-memory SQLite-backed hatk database with schemas registered for
 * PRIVATE_COLLECTION and PUBLIC_COLLECTION. Call once per test file (module-level
 * state in src/database/db.ts is process-global, and each vitest file already runs
 * in its own process under the default `forks` pool — see the note on
 * `createTestContext` in src/test.ts).
 */
export async function setupFixtureDatabase(): Promise<void> {
  const nsids = [PRIVATE_COLLECTION, PUBLIC_COLLECTION]
  const lexicons = new Map<string, any>(nsids.map((nsid) => [nsid, minimalLexicon(nsid)]))

  const tableSchemas = []
  const ddlStatements = []
  for (const nsid of nsids) {
    const schema = generateTableSchema(nsid, lexicons.get(nsid), lexicons, SQLITE_DIALECT)
    tableSchemas.push(schema)
    ddlStatements.push(generateCreateTableSQL(schema, SQLITE_DIALECT))
  }

  const { adapter, searchPort } = await createAdapter('sqlite')
  setSearchPort(searchPort)
  await initDatabase(adapter, ':memory:', tableSchemas, ddlStatements)
}
