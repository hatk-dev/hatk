import { resolve, dirname } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { registerHatkResolveHook } from './resolve-hatk.ts'
import YAML from 'yaml'
import { loadConfig, type HatkConfig } from './config.ts'
import {
  loadLexicons,
  storeLexicons,
  discoverCollections,
  generateTableSchema,
  generateCreateTableSQL,
} from './database/schema.ts'
import { initDatabase, querySQL, runSQL, insertRecord, closeDatabase } from './database/db.ts'
import { createAdapter } from './database/adapter-factory.ts'
import { SQLITE_DIALECT } from './database/dialect.ts'
import { setSearchPort } from './database/fts.ts'
import { executeFeed, listFeeds, createPaginate } from './feeds.ts'
import { executeXrpc, listXrpc, configureRelay, configureCdn } from './xrpc.ts'
import { initServer } from './server-init.ts'
import { discoverViews } from './views.ts'
import { validateLexicons } from '@bigmoves/lexicon'
import { packCursor, unpackCursor, isTakendownDid, filterTakendownDids } from './database/db.ts'
import { seed as createSeedHelpers, type SeedOpts } from './seed.ts'
import type { FeedContext } from './feeds.ts'

export interface TestContext {
  db: {
    query: (sql: string, params?: any[]) => Promise<any[]>
    run: (sql: string, params?: any[]) => Promise<void>
  }
  loadFixtures: (dir?: string) => Promise<void>
  loadFeed: (name: string) => { generate: (ctx: FeedContext) => Promise<any> }
  loadXrpc: (name: string) => { handler: (ctx: any) => Promise<any> }
  feedContext: (opts?: {
    limit?: number
    cursor?: string
    viewer?: { did: string } | null
    params?: Record<string, string>
  }) => FeedContext
  close: () => Promise<void>
  /** @internal */ _config: HatkConfig
  /** @internal */ _collections: string[]
}

export interface TestServer extends TestContext {
  url: string
  port: number
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  fetchAs: (did: string, path: string, init?: RequestInit) => Promise<Response>
  seed: (opts?: SeedOpts) => ReturnType<typeof createSeedHelpers>
  waitForRecord: (uri: string, timeoutMs?: number) => Promise<void>
}

/**
 * Find the project's hatk.config.ts by walking up from cwd.
 * Returns the resolved config path, or falls back to 'hatk.config.ts'.
 */
function findConfigPath(): string {
  const explicit = process.env.APPVIEW_CONFIG
  if (explicit) return resolve(explicit)
  return resolve('hatk.config.ts')
}

/**
 * Boot an in-memory hatk context for unit tests.
 * Loads lexicons, creates in-memory DuckDB, discovers feeds/xrpc/labels.
 * No HTTP server, no PDS, no indexer.
 *
 * Note: uses module-level singletons (DB, feeds, xrpc, labels).
 * Each vitest worker runs in its own process so this is safe by default,
 * but it will NOT work with --pool=threads (multiple tests sharing a process).
 */
export async function createTestContext(): Promise<TestContext> {
  registerHatkResolveHook()

  const configPath = findConfigPath()
  const config = await loadConfig(configPath)
  const configDir = dirname(resolve(configPath))

  configureRelay(config.relay)
  configureCdn(config.cdn)

  // Load and validate lexicons
  const lexicons = loadLexicons(resolve(configDir, 'lexicons'))
  const lexiconErrors = validateLexicons([...lexicons.values()])
  if (lexiconErrors) {
    const messages = Object.entries(lexiconErrors).flatMap(([nsid, errs]) => errs.map((e) => `${nsid}: ${e}`))
    throw new Error(`Invalid lexicons:\n${messages.join('\n')}`)
  }
  storeLexicons(lexicons)

  // Discover collections
  const collections = config.collections.length > 0 ? config.collections : discoverCollections(lexicons)

  // Generate schemas
  const schemas = []
  const ddlStatements = []
  for (const nsid of collections) {
    const lexicon = lexicons.get(nsid)
    if (!lexicon) continue
    const schema = generateTableSchema(nsid, lexicon, lexicons)
    schemas.push(schema)
    ddlStatements.push(generateCreateTableSQL(schema, SQLITE_DIALECT))
  }

  // In-memory SQLite — faster startup, no native module issues in Vite's module runner
  const { adapter, searchPort } = await createAdapter('sqlite')
  setSearchPort(searchPort)
  await initDatabase(adapter, ':memory:', schemas, ddlStatements)

  // Discover views
  discoverViews()

  // Discover feeds, xrpc, labels, hooks, og from server/ directory (skip setup scripts in tests)
  await initServer(resolve(configDir, 'server'), { skipSetup: true })

  return {
    db: { query: querySQL, run: runSQL },
    _config: config,
    _collections: collections,
    loadFixtures: async (dir?: string) => {
      const fixturesDir = resolve(dir || 'test/fixtures')
      let files: string[]
      try {
        files = readdirSync(fixturesDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      } catch {
        throw new Error(`Fixtures directory not found: ${fixturesDir}`)
      }
      // Load _repos.yaml first if it exists, so handles are registered before records
      const reposFile = files.find((f) => f.replace(/\.ya?ml$/, '') === '_repos')
      if (reposFile) {
        const content = readFileSync(resolve(fixturesDir, reposFile), 'utf-8')
        const records = YAML.parse(content) as Array<Record<string, any>>
        if (Array.isArray(records)) {
          for (const rec of records) {
            const row = interpolateHelpers(rec)
            await runSQL(`INSERT OR IGNORE INTO _repos (did, status, handle, backfilled_at) VALUES ($1, $2, $3, $4)`, [
              row.did,
              row.status || 'active',
              row.handle || row.did.split(':').pop() + '.test',
              new Date().toISOString(),
            ])
          }
        }
      }

      const seenDids = new Set<string>()
      for (const file of files) {
        const tableName = file.replace(/\.ya?ml$/, '')
        if (tableName === '_repos') continue
        const content = readFileSync(resolve(fixturesDir, file), 'utf-8')
        const records = YAML.parse(content) as Array<Record<string, any>>
        if (!Array.isArray(records)) continue

        const isCollection = collections.includes(tableName)

        if (!isCollection) {
          // Custom table: auto-create from first record's keys, then INSERT
          if (records.length === 0) continue
          const keys = Object.keys(interpolateHelpers(records[0]))
          const colDefs = keys.map((k) => `"${k}" VARCHAR`).join(', ')
          await runSQL(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
          for (const rec of records) {
            const row = interpolateHelpers(rec)
            const vals = keys.map((k) => row[k])
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
            await runSQL(
              `INSERT INTO "${tableName}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders})`,
              vals,
            )
          }
          continue
        }

        for (let i = 0; i < records.length; i++) {
          const rec = interpolateHelpers(records[i])
          const did = rec.did || 'did:plc:test'
          const rkey = rec.rkey || rec.uri?.split('/').pop() || String(i)
          const uri = rec.uri || `at://${did}/${tableName}/${rkey}`
          const cid = rec.cid || `cid${i}`
          const fields = Object.fromEntries(
            Object.entries(rec).filter(([k]) => !['uri', 'cid', 'did', 'rkey'].includes(k)),
          )
          // Auto-register DID in _repos if not already present
          if (!seenDids.has(did)) {
            seenDids.add(did)
            await runSQL(`INSERT OR IGNORE INTO _repos (did, status, handle, backfilled_at) VALUES ($1, $2, $3, $4)`, [
              did,
              'active',
              did.split(':').pop() + '.test',
              new Date().toISOString(),
            ])
          }
          await insertRecord(tableName, uri, cid, did, fields)
        }
      }
    },
    loadFeed: (name) => {
      const feedList = listFeeds()
      if (!feedList.find((f) => f.name === name))
        throw new Error(`Feed "${name}" not found. Available: ${feedList.map((f) => f.name).join(', ')}`)
      return {
        generate: (ctx: FeedContext) => executeFeed(name, ctx.params || {}, ctx.cursor, ctx.limit, ctx.viewer),
      }
    },
    loadXrpc: (name) => {
      const xrpcList = listXrpc()
      if (!xrpcList.includes(name))
        throw new Error(`XRPC handler "${name}" not found. Available: ${xrpcList.join(', ')}`)
      return {
        handler: (ctx: any) => {
          const params = { ...ctx.params }
          if (ctx.cursor != null && params.cursor == null) params.cursor = ctx.cursor
          if (ctx.limit != null && params.limit == null) params.limit = String(ctx.limit)
          return executeXrpc(name, params, ctx.cursor, ctx.limit ?? 30, ctx.viewer)
        },
      }
    },
    feedContext: (opts) => {
      const paginateDeps = {
        db: { query: querySQL },
        cursor: opts?.cursor,
        limit: opts?.limit || 30,
        packCursor,
        unpackCursor,
      }
      return {
        db: { query: querySQL },
        params: opts?.params || {},
        cursor: opts?.cursor,
        limit: opts?.limit || 30,
        viewer: opts?.viewer ?? null,
        packCursor,
        unpackCursor,
        isTakendown: isTakendownDid,
        filterTakendownDids,
        paginate: createPaginate(paginateDeps),
      }
    },
    close: async () => {
      closeDatabase()
    },
  }
}

/**
 * Boot a full hatk HTTP server on a random port for integration tests.
 * Includes everything from createTestContext plus an HTTP server.
 */
const NOW_RE = /^\$now(?:\(([+-]?\d+)([smhd])\))?$/

function interpolateHelpers(value: any): any {
  if (typeof value === 'string') {
    const m = value.match(NOW_RE)
    if (m) {
      const offset = m[1] ? parseInt(m[1]) : 0
      const unit = m[2] || 's'
      const ms = offset * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!
      return new Date(Date.now() + ms).toISOString()
    }
    return value
  }
  if (Array.isArray(value)) return value.map(interpolateHelpers)
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateHelpers(v)
    }
    return out
  }
  return value
}

export async function startTestServer(): Promise<TestServer> {
  const ctx = await createTestContext()

  // Import startServer — it creates the HTTP server and returns it
  const { startServer } = await import('./server.ts')

  // Start server on port 0 (random available port)
  const resolveViewer = (request: Request) => {
    const did = request.headers.get('x-test-viewer')
    return typeof did === 'string' ? { did } : null
  }
  const httpServer = startServer(
    0,
    ctx._collections,
    ctx._config.publicDir,
    ctx._config.oauth,
    ctx._config.admins,
    resolveViewer,
  )
  await new Promise<void>((resolve) => httpServer.on('listening', resolve))
  const port = (httpServer.address() as any).port
  const url = `http://127.0.0.1:${port}`

  return {
    ...ctx,
    url,
    port,
    fetch: (path, init) => fetch(`${url}${path}`, init),
    fetchAs: (did, path, init) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: { ...init?.headers, 'x-test-viewer': did },
      }),
    seed: (seedOpts) => createSeedHelpers(seedOpts),
    waitForRecord: async (uri, timeoutMs = 10_000) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const record = await querySQL(`SELECT uri FROM "${uri.split('/')[3]}" WHERE uri = $1`, [uri]).catch(() => [])
        if (record.length > 0) return
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(`Timed out waiting for record: ${uri}`)
    },
    close: async () => {
      httpServer.close()
      await ctx.close()
    },
  }
}
