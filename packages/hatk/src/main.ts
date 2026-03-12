#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { log } from './logger.ts'
import { loadConfig } from './config.ts'
import {
  loadLexicons,
  storeLexicons,
  discoverCollections,
  generateTableSchema,
  generateCreateTableSQL,
} from './schema.ts'
import { discoverViews } from './views.ts'
import { initDatabase, getCursor, querySQL } from './db.ts'
import { initFeeds, listFeeds } from './feeds.ts'
import { initXrpc, listXrpc, configureRelay } from './xrpc.ts'
import { initOpengraph } from './opengraph.ts'
import { initLabels, getLabelDefinitions } from './labels.ts'
import { startIndexer } from './indexer.ts'
import { rebuildAllIndexes } from './fts.ts'
import { startServer } from './server.ts'
import { validateLexicons } from '@bigmoves/lexicon'
import { relayHttpUrl } from './config.ts'
import { runBackfill } from './backfill.ts'
import { initOAuth } from './oauth/server.ts'
import { loadOnLoginHook } from './oauth/hooks.ts'
import { initSetup } from './setup.ts'

function logMemory(phase: string): void {
  const mem = process.memoryUsage()
  log(`[mem] ${phase}: heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB rss=${Math.round(mem.rss / 1024 / 1024)}MB external=${Math.round(mem.external / 1024 / 1024)}MB arrayBuffers=${Math.round(mem.arrayBuffers / 1024 / 1024)}MB`)
}

const configPath = process.argv[2] || 'config.yaml'
const configDir = dirname(resolve(configPath))

logMemory('startup')

// 1. Load config
const config = loadConfig(configPath)
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
await loadOnLoginHook(resolve(configDir, 'hooks'))

const schemas = []
const ddlStatements = []

for (const nsid of collections) {
  const lexicon = lexicons.get(nsid)
  if (!lexicon) {
    log(`[main] No lexicon found for ${nsid}, using generic JSON storage`)
    const genericDDL = `CREATE TABLE IF NOT EXISTS "${nsid}" (
      uri TEXT PRIMARY KEY,
      cid TEXT,
      did TEXT NOT NULL,
      indexed_at TIMESTAMP NOT NULL,
      data JSON
    );
    CREATE INDEX IF NOT EXISTS idx_${nsid.replace(/\./g, '_')}_indexed ON "${nsid}"(indexed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_${nsid.replace(/\./g, '_')}_author ON "${nsid}"(did);`
    schemas.push({ collection: nsid, tableName: `"${nsid}"`, columns: [], refColumns: [], children: [], unions: [] })
    ddlStatements.push(genericDDL)
    continue
  }

  const schema = generateTableSchema(nsid, lexicon, lexicons)
  schemas.push(schema)
  ddlStatements.push(generateCreateTableSQL(schema))
  log(`[main] Schema for ${nsid}: ${schema.columns.length} columns, ${schema.unions.length} unions`)
}

// 3. Ensure data directory exists and initialize DuckDB
if (config.database !== ':memory:') {
  mkdirSync(dirname(config.database), { recursive: true })
}
await initDatabase(config.database, schemas, ddlStatements)
logMemory('after-db-init')
log(`[main] DuckDB initialized (${config.database === ':memory:' ? 'in-memory' : config.database})`)


// 3b. Run setup hooks (after DB init, before server)
await initSetup(resolve(configDir, 'setup'))

// Detect orphaned tables
try {
  const existingTables = await querySQL(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name NOT LIKE '\\_%' ESCAPE '\\'`,
  )
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

// 4. Initialize feeds, xrpc handlers, og, labels from directories
await initFeeds(resolve(configDir, 'feeds'))
log(
  `[main] Feeds initialized: ${
    listFeeds()
      .map((f) => f.name)
      .join(', ') || 'none'
  }`,
)

await initXrpc(resolve(configDir, 'xrpc'))
log(`[main] XRPC handlers initialized: ${listXrpc().join(', ') || 'none'}`)

await initOpengraph(resolve(configDir, 'og'))
log(`[main] OpenGraph initialized`)

await initLabels(resolve(configDir, 'labels'))
log(`[main] Labels initialized: ${getLabelDefinitions().length} definitions`)

if (config.oauth) {
  await initOAuth(config.oauth, config.plc, config.relay)
  log(`[main] OAuth initialized (issuer: ${config.oauth.issuer})`)
}

logMemory('before-server')

// 5. Start server immediately (don't wait for backfill)
const collectionSet = new Set(collections)
startServer(config.port, collections, config.publicDir, config.oauth, config.admins)

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
runBackfill({
  pdsUrl: relayHttpUrl(config.relay),
  plcUrl: config.plc,
  collections: collectionSet,
  config: config.backfill,
})
  .then(() => {
    log('[main] Backfill complete, rebuilding FTS indexes...')
    return rebuildAllIndexes(collections)
  })
  .then(() => {
    log('[main] FTS indexes ready')
  })
  .catch((err) => {
    console.error('[main] Backfill error:', err.message)
  })
