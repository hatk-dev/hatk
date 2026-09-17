/**
 * src/main.ts is the production entry point: a script with no exports that boots
 * a whole hatk server on import. It is exercised here by importing it with a
 * scratch project on disk and every outward-facing boundary stubbed — no port is
 * bound (`serve`), no firehose is opened (`startIndexer`, `startJetstreamIndexer`),
 * and no repo is fetched (`runBackfill`). Everything else — config resolution,
 * lexicon validation, schema build, cursor selection, handler registration — is
 * the real code path a deploy runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// src/logger.ts silences log()/emit() when DEBUG=0, and these tests assert on
// that output. Clear it so a developer's ambient DEBUG=0 can't fail the suite.
const originalDebug = process.env.DEBUG
beforeAll(() => void delete process.env.DEBUG)
afterAll(() => {
  if (originalDebug !== undefined) process.env.DEBUG = originalDebug
})

const mocks = vi.hoisted(() => ({
  serve: vi.fn(),
  startIndexer: vi.fn(),
  startAuxIndexer: vi.fn(),
  startJetstreamIndexer: vi.fn(),
  runBackfill: vi.fn(async (..._args: any[]) => 0),
  rebuildAllIndexes: vi.fn(async () => {}),
  initOAuth: vi.fn(async (..._args: any[]) => {}),
  initPush: vi.fn(),
  isPushEnabled: vi.fn(() => true),
  enabledPushTransports: vi.fn(() => ['apns']),
}))

vi.mock('../src/adapter.ts', async (orig) => ({ ...(await orig<object>()), serve: mocks.serve }))
vi.mock('../src/indexer.ts', async (orig) => ({
  ...(await orig<object>()),
  startIndexer: mocks.startIndexer,
  startAuxIndexer: mocks.startAuxIndexer,
}))
vi.mock('../src/jetstream.ts', async (orig) => ({
  ...(await orig<object>()),
  startJetstreamIndexer: mocks.startJetstreamIndexer,
}))
vi.mock('../src/backfill.ts', async (orig) => ({ ...(await orig<object>()), runBackfill: mocks.runBackfill }))
vi.mock('../src/database/fts.ts', async (orig) => ({
  ...(await orig<object>()),
  rebuildAllIndexes: mocks.rebuildAllIndexes,
}))
vi.mock('../src/oauth/server.ts', async (orig) => ({ ...(await orig<object>()), initOAuth: mocks.initOAuth }))
vi.mock('../src/push.ts', async (orig) => ({
  ...(await orig<object>()),
  initPush: mocks.initPush,
  isPushEnabled: mocks.isPushEnabled,
  enabledPushTransports: mocks.enabledPushTransports,
}))

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hatk-main-')))
  for (const m of Object.values(mocks)) m.mockClear()
  mocks.runBackfill.mockResolvedValue(0)
  mocks.isPushEnabled.mockReturnValue(true)
  mocks.enabledPushTransports.mockReturnValue(['apns'])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  process.removeAllListeners('SIGTERM')
  delete (globalThis as any).__hatk_callXrpc
  delete (globalThis as any).__hatk_parseSessionCookie
  delete (globalThis as any).__hatk_sessionCookieName
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// --- harness -------------------------------------------------------------

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

interface MainRun {
  out: string[]
  err: string[]
  warn: string[]
  exits: number[]
  thrown: Error | null
}

/**
 * Boot main.ts against the scratch project. Backfill finishes on a detached
 * promise chain, so `throwOnExit: false` is needed whenever a test cares about
 * the restart-after-backfill exit — throwing there would escape as an uncaught
 * exception instead of unwinding the boot.
 */
async function boot(opts: { throwOnExit?: boolean } = {}): Promise<MainRun> {
  const run: MainRun = { out: [], err: [], warn: [], exits: [], thrown: null }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void run.out.push(a.join(' '))),
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void run.err.push(a.join(' '))),
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void run.warn.push(a.join(' '))),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      run.exits.push(code ?? 0)
      if (opts.throwOnExit !== false) throw new ExitError(code ?? 0)
      return undefined
    }) as never),
  ]
  const originalArgv = process.argv
  process.argv = ['node', '/fake/dist/main.js', join(root, 'hatk.config.ts')]
  try {
    vi.resetModules()
    await import('../src/main.ts')
  } catch (e) {
    if (!(e instanceof ExitError)) run.thrown = e as Error
  } finally {
    // Let the detached backfill chain settle before assertions.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    for (const s of spies) s.mockRestore()
    process.argv = originalArgv
  }
  return run
}

function all(run: MainRun): string {
  return [...run.out, ...run.err, ...run.warn].join('\n')
}

function writeConfig(body: string): void {
  writeFileSync(join(root, 'hatk.config.ts'), body)
}

function writeLexicon(nsid: string, lexicon: unknown): void {
  const parts = nsid.split('.')
  const dir = join(root, 'lexicons', ...parts.slice(0, -1))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${parts.at(-1)}.json`), JSON.stringify(lexicon))
}

function recordLexicon(nsid: string, props: Record<string, unknown> = {}) {
  return {
    lexicon: 1,
    id: nsid,
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: {
          type: 'object',
          required: ['createdAt'],
          properties: { createdAt: { type: 'string', format: 'datetime' }, ...props },
        },
      },
    },
  }
}

/** A project with one record lexicon and an in-memory database. */
function minimalProject(config = 'export default { port: 4999 }\n'): void {
  writeConfig(config)
  writeLexicon('com.example.widget', recordLexicon('com.example.widget', { name: { type: 'string' } }))
}

// --- boot ----------------------------------------------------------------

describe('boot', () => {
  test('serves on the configured port and reports what it started', async () => {
    minimalProject()
    const run = await boot()

    expect(run.thrown).toBeNull()
    expect(mocks.serve).toHaveBeenCalledTimes(1)
    expect(typeof mocks.serve.mock.calls[0][0]).toBe('function')
    expect(mocks.serve.mock.calls[0][1]).toBe(4999)
    expect(all(run)).toContain('API: http://localhost:4999')
    expect(all(run)).toContain('Collections: com.example.widget')
  })

  test('lets the PORT environment variable win over the config file', async () => {
    // Platforms like Railway inject PORT; a hard-coded config must not fight it.
    minimalProject()
    vi.stubEnv('PORT', '8080')
    await boot()
    expect(mocks.serve.mock.calls[0][1]).toBe(8080)
  })

  test('publishes the SSR bridges so a framework can call XRPC in-process', async () => {
    minimalProject()
    await boot()

    expect((globalThis as any).__hatk_callXrpc).toBeTypeOf('function')
    expect((globalThis as any).__hatk_parseSessionCookie).toBeTypeOf('function')
    expect((globalThis as any).__hatk_sessionCookieName).toBeTypeOf('string')
  })

  test('builds a table schema from each record lexicon', async () => {
    minimalProject()
    const run = await boot()
    expect(all(run)).toMatch(/Schema for com\.example\.widget: \d+ columns/)
  })

  test('dumps the live schema to db/schema.sql for review', async () => {
    // This file is how a schema change shows up in a pull request diff.
    minimalProject()
    await boot()

    const dump = readFileSync(join(root, 'db', 'schema.sql'), 'utf-8')
    expect(dump).toContain('auto-generated by hatk on startup')
    expect(dump).toContain('com.example.widget')
  })

  test('runs API-only when a project has no record lexicons', async () => {
    // A project of pure query lexicons is legal; it just indexes nothing.
    writeConfig('export default {}\n')
    writeLexicon('com.example.getWidgets', {
      lexicon: 1,
      id: 'com.example.getWidgets',
      defs: {
        main: {
          type: 'query',
          parameters: { type: 'params', properties: {} },
          output: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
        },
      },
    })
    const run = await boot()

    expect(all(run)).toContain('running in API-only mode')
    expect(mocks.serve).toHaveBeenCalled()
  })

  test('refuses to boot on an invalid lexicon, naming the offender', async () => {
    // Booting anyway would produce a table whose shape nobody intended.
    writeConfig('export default {}\n')
    writeLexicon('com.example.broken', { lexicon: 1, id: 'com.example.broken', defs: { main: { type: 'notAThing' } } })
    const run = await boot()

    expect(run.exits).toEqual([1])
    expect(all(run)).toContain('[main] Invalid lexicon com.example.broken')
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  test('honours an explicit collections list over lexicon discovery', async () => {
    minimalProject(`export default { collections: ['com.example.widget'] }\n`)
    const run = await boot()
    expect(all(run)).toContain('[main] Loaded config: 1 collections')
  })

  test('warns about a table that no longer has a lexicon', async () => {
    // A table named like a collection but with no lexicon behind it is what a
    // deleted lexicon leaves on disk. The warning depends on
    // dialect.listTablesQuery running at all; a broken one is swallowed by
    // main.ts's bare catch and the whole check goes quiet.
    minimalProject()
    mkdirSync(join(root, 'server'), { recursive: true })
    writeFileSync(
      join(root, 'server', '01-orphan.ts'),
      `export default { __type: 'setup', handler: async (ctx) => { await ctx.db.run('CREATE TABLE IF NOT EXISTS "com.example.gone" (uri TEXT)') } }\n`,
    )
    const run = await boot()

    expect(run.warn.join('\n')).toContain('Table "com.example.gone" exists but has no lexicon')
    // The live collection and internal tables are not flagged
    expect(run.warn.join('\n')).not.toContain('com.example.widget')
    expect(run.warn.join('\n')).not.toContain('_repos')
  })

  test('survives a setup script creating tables outside the lexicon schema', async () => {
    // Custom tables are the documented reason setup scripts exist; boot must
    // not trip over one it has no lexicon for.
    minimalProject()
    mkdirSync(join(root, 'server'), { recursive: true })
    writeFileSync(
      join(root, 'server', '01-custom.ts'),
      `export default { __type: 'setup', handler: async (ctx) => { await ctx.db.run('CREATE TABLE IF NOT EXISTS "com.example.gone" (uri TEXT)') } }\n`,
    )
    const run = await boot()

    expect(run.thrown).toBeNull()
    expect(mocks.serve).toHaveBeenCalled()
    // The custom table lands in the committed schema dump.
    expect(readFileSync(join(root, 'db', 'schema.sql'), 'utf-8')).toContain('com.example.gone')
  })

  test('installs a SIGTERM handler that exits cleanly', async () => {
    // Container platforms send SIGTERM first; exiting 0 avoids a crash-loop alert.
    minimalProject()
    const run = await boot({ throwOnExit: false })
    const handlers = process.listeners('SIGTERM')
    expect(handlers.length).toBeGreaterThan(0)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    ;(handlers.at(-1) as () => void)()
    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(run.thrown).toBeNull()
  })
})

// --- handler discovery ---------------------------------------------------

describe('handler discovery', () => {
  test('uses the server/ directory when one exists', async () => {
    minimalProject()
    mkdirSync(join(root, 'server'), { recursive: true })
    writeFileSync(
      join(root, 'server', 'trending.ts'),
      `export default { __type: 'feed', label: 'Trending', collection: 'com.example.widget', async generate() { return { uris: [] } } }\n`,
    )
    const run = await boot()

    expect(all(run)).toContain('[server] Initialized from server/ directory:')
    expect(all(run)).toContain('Feeds: trending')
    // The legacy per-directory boot must not also run.
    expect(all(run)).not.toContain('[main] Feeds initialized')
  })

  test('stores a configured collection with no lexicon as generic JSON', async () => {
    // Indexing a collection you have no lexicon for is legal — you just get an
    // untyped JSON column instead of real ones.
    minimalProject(`export default { collections: ['com.example.widget', 'com.nolexicon.thing'] }\n`)
    const run = await boot()

    expect(all(run)).toContain('[main] No lexicon found for com.nolexicon.thing, using generic JSON storage')
    expect(mocks.serve).toHaveBeenCalled()
  })

  test('lists the feeds it loaded from the legacy feeds/ directory', async () => {
    minimalProject()
    mkdirSync(join(root, 'feeds'), { recursive: true })
    writeFileSync(
      join(root, 'feeds', 'trending.ts'),
      `export default { __type: 'feed', label: 'Trending', collection: 'com.example.widget', async generate() { return { uris: [] } } }\n`,
    )
    const run = await boot()

    expect(all(run)).toContain('[main] Feeds initialized: trending')
    expect(all(run)).toContain('Feeds: trending')
  })

  test('falls back to the legacy per-type directories', async () => {
    minimalProject()
    const run = await boot()

    expect(all(run)).toContain('[main] Feeds initialized: none')
    expect(all(run)).toContain('[main] XRPC handlers initialized:')
    expect(all(run)).toContain('[main] OpenGraph initialized')
    expect(all(run)).toContain('[main] Labels initialized: 0 definitions')
  })

  test('loads a SvelteKit build output as the fallback handler', async () => {
    // Without this, every non-hatk route 404s in production even though the
    // SvelteKit build is sitting right there.
    minimalProject()
    mkdirSync(join(root, 'build'), { recursive: true })
    writeFileSync(join(root, 'build', 'handler.js'), `export const handler = (req, res, next) => next()\n`)
    const run = await boot()

    expect(all(run)).toContain('[main] SvelteKit handler loaded from build/handler.js')
    expect(mocks.serve.mock.calls[0][3]).toBeTypeOf('function')
  })

  test('passes no fallback when there is no build output', async () => {
    minimalProject()
    await boot()
    expect(mocks.serve.mock.calls[0][3]).toBeUndefined()
  })
})

// --- optional subsystems -------------------------------------------------

describe('optional subsystems', () => {
  test('leaves OAuth uninitialized when the config does not ask for it', async () => {
    minimalProject()
    await boot()
    expect(mocks.initOAuth).not.toHaveBeenCalled()
  })

  test('initializes OAuth with the configured issuer, PLC and relay', async () => {
    minimalProject(
      `export default { oauth: { issuer: 'https://app.test', clients: [] }, plc: 'https://plc.test', relay: 'wss://relay.test' }\n`,
    )
    const run = await boot()

    expect(run.thrown).toBeNull()
    expect(mocks.initOAuth).toHaveBeenCalledTimes(1)
    expect(mocks.initOAuth.mock.calls[0][1]).toBe('https://plc.test')
    expect(mocks.initOAuth.mock.calls[0][2]).toBe('wss://relay.test')
    expect(all(run)).toContain('[main] OAuth initialized (issuer: https://app.test)')
  })

  test('initializes push and reports the usable transports', async () => {
    minimalProject(`export default { push: { apns: { keyPath: './key.p8' } } }\n`)
    const run = await boot()

    expect(mocks.initPush).toHaveBeenCalledTimes(1)
    expect(mocks.initPush.mock.calls[0][1]).toBe(root)
    expect(all(run)).toContain('[main] Push initialized (apns)')
  })

  test('says so when push is configured but has no usable credential', async () => {
    // Silently disabling push is how notifications quietly stop in production.
    mocks.isPushEnabled.mockReturnValue(false)
    minimalProject(`export default { push: { apns: { keyPath: './missing.p8' } } }\n`)
    const run = await boot()

    expect(all(run)).toContain('[main] Push configured but no usable credential')
  })
})

// --- indexer wiring ------------------------------------------------------

describe('indexer wiring', () => {
  test('tails the configured relay by default', async () => {
    minimalProject(`export default { relay: 'wss://relay.example.test' }\n`)
    await boot()

    expect(mocks.startJetstreamIndexer).not.toHaveBeenCalled()
    const opts = mocks.startIndexer.mock.calls[0][0]
    expect(opts.relayUrl).toBe('wss://relay.example.test')
    expect([...opts.collections]).toEqual(['com.example.widget'])
    expect(opts.cursor).toBeNull()
  })

  test('uses Jetstream instead of the relay when configured', async () => {
    // Relay and Jetstream sequence numbers are different coordinate systems, so
    // exactly one of the two may run.
    minimalProject(`export default { jetstream: { url: 'wss://jetstream.example.test/subscribe' } }\n`)
    await boot()

    expect(mocks.startIndexer).not.toHaveBeenCalled()
    expect(mocks.startJetstreamIndexer.mock.calls[0][0].jetstreamUrl).toBe('wss://jetstream.example.test/subscribe')
  })

  test('starts one auxiliary indexer per extra relay', async () => {
    minimalProject(`export default { relays: ['wss://pds-a.test', 'wss://pds-b.test'] }\n`)
    await boot()

    expect(mocks.startAuxIndexer).toHaveBeenCalledTimes(2)
    expect(mocks.startAuxIndexer.mock.calls.map((c) => c[0].relayUrl)).toEqual(['wss://pds-a.test', 'wss://pds-b.test'])
  })

  test('resumes the relay from its saved cursor across restarts', async () => {
    // Restarting from zero would make the relay replay its whole retention window.
    minimalProject(`export default { database: './db/app.db', relay: 'wss://relay.example.test' }\n`)
    await boot()
    expect(mocks.startIndexer.mock.calls[0][0].cursor).toBeNull()

    const { setCursor } = await import('../src/database/db.ts')
    await setCursor('relay', '918273')

    await boot()
    expect(mocks.startIndexer.mock.calls[1][0].cursor).toBe('918273')
  })

  test('HATK_IGNORE_SAVED_CURSOR starts from live instead of the saved cursor', async () => {
    minimalProject(`export default { database: './db/app.db', relay: 'wss://relay.example.test' }\n`)
    await boot()
    const { setCursor } = await import('../src/database/db.ts')
    await setCursor('relay', '918273')

    vi.stubEnv('HATK_IGNORE_SAVED_CURSOR', '1')
    const run = await boot()

    expect(all(run)).toContain('HATK_IGNORE_SAVED_CURSOR set')
    expect(mocks.startIndexer.mock.calls[1][0].cursor).toBeNull()
  })

  test('forwards the backfill tuning knobs to the indexer', async () => {
    minimalProject(
      `export default { backfill: { parallelism: 7, fetchTimeout: 1234, maxRetries: 2, signalCollections: ['com.example.widget'], repos: ['did:plc:alice'] } }\n`,
    )
    await boot()

    const opts = mocks.startIndexer.mock.calls[0][0]
    expect(opts.parallelism).toBe(7)
    expect(opts.fetchTimeout).toBe(1234)
    expect(opts.maxRetries).toBe(2)
    expect([...opts.signalCollections]).toEqual(['com.example.widget'])
    expect([...opts.pinnedRepos]).toEqual(['did:plc:alice'])
  })
})

// --- backfill ------------------------------------------------------------

describe('background backfill', () => {
  test('rebuilds the search indexes once backfill finishes', async () => {
    // FTS is built after backfill rather than per-record; skipping it leaves
    // search returning nothing on a fresh deploy.
    minimalProject()
    mocks.runBackfill.mockResolvedValue(12)
    const run = await boot({ throwOnExit: false })

    expect(mocks.rebuildAllIndexes).toHaveBeenCalledWith(['com.example.widget'])
    expect(all(run)).toContain('[main] FTS indexes ready')
  })

  test('restarts the process after a backfill that actually indexed something', async () => {
    // Backfill leaves the heap fragmented; production restarts to reclaim it.
    minimalProject()
    mocks.runBackfill.mockResolvedValue(12)
    const run = await boot({ throwOnExit: false })

    expect(all(run)).toContain('[main] Restarting to reclaim memory...')
    expect(run.exits).toEqual([1])
  })

  test('does not restart in dev mode', async () => {
    // Restarting under `hatk dev` would fight the file watcher.
    minimalProject()
    vi.stubEnv('DEV_MODE', '1')
    mocks.runBackfill.mockResolvedValue(12)
    const run = await boot({ throwOnExit: false })

    expect(run.exits).toEqual([])
  })

  test('does not restart when backfill indexed nothing', async () => {
    minimalProject()
    mocks.runBackfill.mockResolvedValue(0)
    const run = await boot({ throwOnExit: false })
    expect(run.exits).toEqual([])
  })

  test('logs a backfill failure without taking the server down', async () => {
    // The server is already serving by then; a failed backfill is not fatal.
    minimalProject()
    mocks.runBackfill.mockRejectedValue(new Error('relay unreachable'))
    const run = await boot({ throwOnExit: false })

    expect(all(run)).toContain('[main] Backfill error: relay unreachable')
    expect(run.exits).toEqual([])
    expect(mocks.serve).toHaveBeenCalled()
  })

  test('points backfill at the relay over HTTP, including the extra relays', async () => {
    minimalProject(`export default { relay: 'wss://relay.example.test', relays: ['wss://pds-a.test'] }\n`)
    await boot({ throwOnExit: false })

    const opts = mocks.runBackfill.mock.calls[0][0]
    expect(opts.pdsUrl).toBe('https://relay.example.test')
    expect(opts.extraPdsUrls).toEqual(['https://pds-a.test'])
  })
})

// --- migrations ----------------------------------------------------------

describe('schema migration', () => {
  test('adds a column to an existing database when a lexicon grows a field', async () => {
    // Deploys run against a live database; a new optional field must not require
    // a manual migration.
    writeConfig(`export default { database: './db/app.db' }\n`)
    writeLexicon('com.example.widget', recordLexicon('com.example.widget'))
    await boot()

    writeLexicon('com.example.widget', recordLexicon('com.example.widget', { nickname: { type: 'string' } }))
    const run = await boot()

    expect(all(run)).toContain('schema migration(s)')
    expect(existsSync(join(root, 'db', 'app.db'))).toBe(true)
  })
})
