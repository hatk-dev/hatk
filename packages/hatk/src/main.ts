#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { log } from './logger.ts'
import { loadConfig } from './config.ts'
import { loadLexicons, storeLexicons, discoverCollections, buildSchemas } from './database/schema.ts'
import { discoverViews } from './views.ts'
import { initDatabase, getCursor, querySQL, getSqlDialect, getSchemaDump, migrateSchema } from './database/db.ts'
import { createAdapter } from './database/adapter-factory.ts'
import { getDialect } from './database/dialect.ts'
import { setSearchPort } from './database/fts.ts'
import { initFeeds, listFeeds } from './feeds.ts'
import { initXrpc, listXrpc, configureRelay } from './xrpc.ts'
import { initOpengraph } from './opengraph.ts'
import { initLabels, getLabelDefinitions } from './labels.ts'
import { startIndexer } from './indexer.ts'
import { rebuildAllIndexes } from './database/fts.ts'
import { createHandler, registerCoreHandlers } from './server.ts'
import { serve } from './adapter.ts'
import { validateLexicons } from '@bigmoves/lexicon'
import { relayHttpUrl } from './config.ts'
import { runBackfill } from './backfill.ts'
import { initOAuth } from './oauth/server.ts'
import { loadOnLoginHook } from './hooks.ts'
import { initSetup } from './setup.ts'
import { initServer } from './server-init.ts'

function logMemory(phase: string): void {
  const mem = process.memoryUsage()
  log(
    `[mem] ${phase}: heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB rss=${Math.round(mem.rss / 1024 / 1024)}MB external=${Math.round(mem.external / 1024 / 1024)}MB arrayBuffers=${Math.round(mem.arrayBuffers / 1024 / 1024)}MB`,
  )
}

const configPath = process.argv[2] || 'hatk.config.ts'
const configDir = dirname(resolve(configPath))

logMemory('startup')

// 1. Load config
const config = await loadConfig(configPath)
configureRelay(config.relay)

// 2. Load lexicons, validate schemas, and discover collections
const lexicons = loadLexicons(resolve(configDir, 'lexicons'))
const lexiconErrors = validateLexicons([...lexicons.values()])
if (lexiconErrors) {
  for (const [nsid, errors] of Object.entries(lexiconErrors)) {
    for (const err of errors) {
      console.error(`[main] Invalid lexicon ${nsid}: ${err}`)
    }
  }
  process.exit(1)
}
storeLexicons(lexicons)

// Auto-discover collections from record-type lexicons, fall back to config
const collections = config.collections.length > 0 ? config.collections : discoverCollections(lexicons)

if (collections.length === 0) {
  log(`[main] No record collections found — running in API-only mode. Add record lexicons to start indexing.`)
}

log(`[main] Loaded config: ${collections.length} collections`)

// Discover view defs from lexicons
discoverViews()

const engineDialect = getDialect(config.databaseEngine)
const { schemas, ddlStatements } = buildSchemas(lexicons, collections, engineDialect)
for (const s of schemas) {
  if (s.columns.length === 0) {
    log(`[main] No lexicon found for ${s.collection}, using generic JSON storage`)
  } else {
    log(`[main] Schema for ${s.collection}: ${s.columns.length} columns, ${s.unions.length} unions`)
  }
}

// 3. Ensure data directory exists and initialize database
if (config.database !== ':memory:') {
  mkdirSync(dirname(config.database), { recursive: true })
}
const { adapter, searchPort } = await createAdapter(config.databaseEngine)
setSearchPort(searchPort)
await initDatabase(adapter, config.database, schemas, ddlStatements)
logMemory('after-db-init')
log(
  `[main] Database initialized (${config.databaseEngine}, ${config.database === ':memory:' ? 'in-memory' : config.database})`,
)

// Auto-migrate schema if lexicons changed
const migrationChanges = await migrateSchema(schemas)
if (migrationChanges.length > 0) {
  log(`[main] Applied ${migrationChanges.length} schema migration(s)`)
}

// 3b. Run setup hooks, feeds, xrpc, og, labels
const serverDir = resolve(configDir, 'server')
if (existsSync(serverDir)) {
  // New: single server/ directory
  await initServer(serverDir)
} else {
  // Legacy: separate directories
  await initSetup(resolve(configDir, 'setup'))
  await loadOnLoginHook(resolve(configDir, 'hooks'))
  await initFeeds(resolve(configDir, 'feeds'))
  log(`[main] Feeds initialized: ${listFeeds().map((f) => f.name).join(', ') || 'none'}`)
  await initXrpc(resolve(configDir, 'xrpc'))
  log(`[main] XRPC handlers initialized: ${listXrpc().join(', ') || 'none'}`)
  await initOpengraph(resolve(configDir, 'og'))
  log(`[main] OpenGraph initialized`)
  await initLabels(resolve(configDir, 'labels'))
  log(`[main] Labels initialized: ${getLabelDefinitions().length} definitions`)
}

// Register built-in dev.hatk.* handlers so callXrpc() can find them
registerCoreHandlers(collections, config.oauth)

// Write db/schema.sql (after setup, so setup-created tables are included)
try {
  const schemaDir = resolve(configDir, 'db')
  mkdirSync(schemaDir, { recursive: true })
  const schemaDump = await getSchemaDump()
  writeFileSync(
    resolve(schemaDir, 'schema.sql'),
    `-- This file is auto-generated by hatk on startup. Do not edit.\n-- Database engine: ${config.databaseEngine}\n\n${schemaDump}\n`,
  )
  log(`[main] Schema written to db/schema.sql`)
} catch {}

// Detect orphaned tables
try {
  const existingTables = await querySQL(getSqlDialect().listTablesQuery)
  for (const row of existingTables) {
    const tableName = row.table_name
    const isChildTable = collections.some((c) => tableName.startsWith(c + '__'))
    if (tableName.includes('.') && !collections.includes(tableName) && !isChildTable) {
      console.warn(
        `[warn] Table "${tableName}" exists but has no lexicon. Run 'hatk destroy collection ${tableName}' to clean up.`,
      )
    }
  }
} catch {}

if (config.oauth) {
  await initOAuth(config.oauth, config.plc, config.relay)
  log(`[main] OAuth initialized (issuer: ${config.oauth.issuer})`)
}

logMemory('before-server')

// 5. Start server immediately (don't wait for backfill)
const collectionSet = new Set(collections)

const backfillOpts = {
  pdsUrl: relayHttpUrl(config.relay),
  plcUrl: config.plc,
  collections: collectionSet,
  config: config.backfill,
}

function runBackfillAndRestart() {
  runBackfill(backfillOpts)
    .then((recordCount) => {
      log('[main] Backfill complete, rebuilding FTS indexes...')
      return rebuildAllIndexes(collections).then(() => recordCount)
    })
    .then((recordCount) => {
      log('[main] FTS indexes ready')
      if (recordCount > 0 && !process.env.DEV_MODE) {
        logMemory('after-backfill')
        log('[main] Restarting to reclaim memory...')
        process.exit(1)
      }
    })
    .catch((err) => {
      console.error('[main] Backfill error:', err.message)
    })
}

const handler = createHandler({
  collections,
  publicDir: config.publicDir,
  oauth: config.oauth,
  admins: config.admins,
  onResync: runBackfillAndRestart,
})

// Detect SvelteKit build output and use it as fallback handler
let fallback: any = undefined
const sveltekitHandler = resolve(configDir, 'build', 'handler.js')
if (existsSync(sveltekitHandler)) {
  const sk = await import(/* @vite-ignore */ sveltekitHandler)
  fallback = sk.handler
  log(`[main] SvelteKit handler loaded from build/handler.js`)
}

serve(handler, config.port, undefined, fallback)

log(`\nhatk running:`)
log(`  Relay: ${config.relay}`)
log(`  Database: ${config.database}`)
log(`  API: http://localhost:${config.port}`)
log(`  Collections: ${collections.join(', ')}`)
log(
  `  Feeds: ${listFeeds()
    .map((f) => f.name)
    .join(', ')}`,
)

logMemory('after-server')

// 6. Start indexer with cursor
const cursor = await getCursor('relay')
startIndexer({
  relayUrl: config.relay,
  collections: collectionSet,
  signalCollections: config.backfill.signalCollections ? new Set(config.backfill.signalCollections) : undefined,
  pinnedRepos: config.backfill.repos ? new Set(config.backfill.repos) : undefined,
  cursor,
  fetchTimeout: config.backfill.fetchTimeout,
  maxRetries: config.backfill.maxRetries,
  parallelism: config.backfill.parallelism,
  ftsRebuildInterval: config.ftsRebuildInterval,
})

// 7. Run backfill in background
runBackfillAndRestart()

// Graceful shutdown
process.on('SIGTERM', () => {
  log('[main] Received SIGTERM, shutting down...')
  process.exit(0)
})
