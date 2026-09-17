/**
 * Setup scripts run once on boot and are how apps create tables hatk's lexicon
 * schema generator can't express. Order and discovery are the whole contract:
 * a script that runs before the table it depends on, or never runs at all,
 * produces a server that boots fine and then 500s on the first query.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSetup, initSetup, runSetupHandler, type SetupContext } from '../src/setup.ts'
import { querySQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// src/logger.ts silences log()/emit() when DEBUG=0, and these tests assert on
// that output. Clear it so a developer's ambient DEBUG=0 can't fail the suite.
const originalDebug = process.env.DEBUG
beforeAll(() => void delete process.env.DEBUG)
afterAll(() => {
  if (originalDebug !== undefined) process.env.DEBUG = originalDebug
})

let root: string

beforeAll(async () => {
  // A real database, so the context handed to a setup script is the real one.
  await setupFixtureDatabase()
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hatk-setup-')))
  ;(globalThis as any).__setupCalls = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete (globalThis as any).__setupCalls
  vi.restoreAllMocks()
})

/** Write a setup script that records its own name when it runs. */
function writeScript(relPath: string, body?: string): void {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(
    full,
    body ?? `export default async function () {\n  globalThis.__setupCalls.push(${JSON.stringify(relPath)})\n}\n`,
  )
}

/** Names recorded by the scripts written with writeScript. */
function ran(): string[] {
  return (globalThis as any).__setupCalls
}

describe('initSetup', () => {
  test('does nothing when the setup directory does not exist', async () => {
    await expect(initSetup(join(root, 'nope'))).resolves.toBeUndefined()
  })

  test('does nothing for an empty setup directory', async () => {
    await expect(initSetup(root)).resolves.toBeUndefined()
    expect(ran()).toEqual([])
  })

  test('runs scripts in sorted filename order', async () => {
    // Numeric prefixes are the documented way to sequence dependent scripts.
    writeScript('02-views.ts')
    writeScript('01-tables.ts')
    writeScript('10-indexes.ts')
    await initSetup(root)

    expect(ran()).toEqual(['01-tables.ts', '02-views.ts', '10-indexes.ts'])
  })

  test('ignores files prefixed with an underscore', async () => {
    // `_helpers.ts` is a shared module imported by real scripts, not a script.
    writeScript('01-tables.ts')
    writeScript('_helpers.ts')
    await initSetup(root)

    expect(ran()).toEqual(['01-tables.ts'])
  })

  test('ignores files that are neither .ts nor .js', async () => {
    writeScript('01-tables.ts')
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE nope (x INT)')
    writeFileSync(join(root, 'README.md'), '# setup')
    await initSetup(root)

    expect(ran()).toEqual(['01-tables.ts'])
  })

  test('descends into subdirectories', async () => {
    writeScript('nested/01-inner.ts')
    writeScript('00-outer.ts')
    await initSetup(root)

    expect(ran()).toEqual(['00-outer.ts', 'nested/01-inner.ts'])
  })

  test('runs a .js script as happily as a .ts one', async () => {
    writeScript('01-plain.js')
    await initSetup(root)
    expect(ran()).toEqual(['01-plain.js'])
  })

  test('accepts a defineSetup-shaped default export', async () => {
    // defineSetup wraps the function as { __type, handler }; both shapes must work.
    writeScript(
      '01-wrapped.ts',
      `export default { __type: 'setup', handler: async () => { globalThis.__setupCalls.push('wrapped') } }\n`,
    )
    await initSetup(root)

    expect(ran()).toEqual(['wrapped'])
  })

  test('warns about a script with no handler and keeps going', async () => {
    // One malformed script must not block the rest of boot.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeScript('01-broken.ts', `export const notDefault = 1\n`)
    writeScript('02-fine.ts')
    await initSetup(root)

    expect(warn.mock.calls[0][0]).toContain('01-broken: no handler function found, skipping')
    expect(ran()).toEqual(['02-fine.ts'])
  })

  test('names a nested script by its path relative to the setup directory', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    writeScript('nested/01-inner.ts')
    await initSetup(root)

    const lines = log.mock.calls.map((c) => c.join(' '))
    expect(lines).toContain('[setup] running: nested/01-inner')
    expect(lines).toContain('[setup] done: nested/01-inner')
  })

  test('lets a failing script abort boot rather than continuing half-migrated', async () => {
    writeScript('01-explodes.ts', `export default async function () { throw new Error('bad migration') }\n`)
    writeScript('02-never.ts')

    await expect(initSetup(root)).rejects.toThrow('bad migration')
    expect(ran()).toEqual([])
  })

  test('hands the script a database it can actually write through', async () => {
    writeScript(
      '01-table.ts',
      `export default async function (ctx) {
         await ctx.db.run('CREATE TABLE IF NOT EXISTS leaderboard (did TEXT PRIMARY KEY, score INTEGER DEFAULT 0)')
         await ctx.db.run("INSERT INTO leaderboard (did, score) VALUES ('did:plc:alice', 7)")
       }\n`,
    )
    await initSetup(root)

    const rows = (await querySQL('SELECT did, score FROM leaderboard')) as Array<{ did: string; score: number }>
    expect(rows).toEqual([{ did: 'did:plc:alice', score: 7 }])
  })
})

describe('runSetupHandler', () => {
  test('runs a handler with a full database context', async () => {
    let ctx: SetupContext | null = null
    await runSetupHandler('inline', async (c) => {
      ctx = c
      await c.db.run('CREATE TABLE IF NOT EXISTS inline_table (id TEXT)')
    })

    expect(typeof ctx!.db.query).toBe('function')
    expect(typeof ctx!.db.runBatch).toBe('function')
    expect(typeof ctx!.db.createBulkInserter).toBe('function')
    expect(await querySQL('SELECT * FROM inline_table')).toEqual([])
  })

  test('brackets the run with named log lines', async () => {
    // These lines are how you tell which setup script hung a boot.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runSetupHandler('01-leaderboard', async () => {})

    const lines = log.mock.calls.map((c) => c.join(' '))
    expect(lines).toEqual(['[setup] running: 01-leaderboard', '[setup] done: 01-leaderboard'])
  })

  test('propagates a handler failure to the caller', async () => {
    await expect(
      runSetupHandler('boom', async () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
  })
})

describe('defineSetup', () => {
  test('tags the handler so the scanner can classify the module', async () => {
    const handler = async () => {}
    const defined = defineSetup(handler)
    expect(defined).toEqual({ __type: 'setup', handler })
  })
})
