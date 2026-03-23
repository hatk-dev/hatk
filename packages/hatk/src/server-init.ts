import { existsSync } from 'node:fs'
import { log } from './logger.ts'
import { scanServerDir } from './scanner.ts'
import { registerFeed, listFeeds } from './feeds.ts'
import { registerXrpcHandler, listXrpc } from './xrpc.ts'
import { registerLabelModule, getLabelDefinitions, clearLabels } from './labels.ts'
import { registerOgHandler } from './opengraph.ts'
import { registerHook } from './hooks.ts'
import { runSetupHandler } from './setup.ts'
import { registerRenderer } from './renderer.ts'

/**
 * Scan the server/ directory and register all discovered handlers.
 * Setup scripts run immediately (in sorted order).
 */
export async function initServer(serverDir: string, opts?: { skipSetup?: boolean }): Promise<void> {
  if (!existsSync(serverDir)) {
    log(`[server] No server/ directory found, skipping`)
    return
  }

  const scanned = await scanServerDir(serverDir)

  // 1. Run setup scripts first (sorted by name) — skipped in test context
  if (!opts?.skipSetup) {
    for (const entry of scanned.setup.sort((a, b) => a.name.localeCompare(b.name))) {
      await runSetupHandler(entry.name, entry.mod.handler)
    }
  }

  // 2. Register feeds
  for (const entry of scanned.feeds) {
    const feedName = entry.name.includes('/') ? entry.name.split('/').pop()! : entry.name
    registerFeed(feedName, entry.mod)
  }

  // 3. Register XRPC handlers
  for (const entry of scanned.queries) {
    registerXrpcHandler(entry.mod.nsid, entry.mod)
  }
  for (const entry of scanned.procedures) {
    registerXrpcHandler(entry.mod.nsid, entry.mod)
  }

  // 4. Register hooks
  for (const entry of scanned.hooks) {
    registerHook(entry.mod.event, entry.mod.handler)
  }

  // 5. Register labels (clear first for hot-reload)
  clearLabels()
  for (const entry of scanned.labels) {
    registerLabelModule(entry.name, entry.mod)
  }

  // 6. Register OG handlers
  for (const entry of scanned.og) {
    registerOgHandler(entry.mod)
  }

  // 7. Register renderer
  if (scanned.renderer) {
    registerRenderer(scanned.renderer.mod.handler)
  }

  log(`[server] Initialized from server/ directory:`)
  log(
    `  Feeds: ${
      listFeeds()
        .map((f) => f.name)
        .join(', ') || 'none'
    }`,
  )
  log(`  XRPC: ${listXrpc().join(', ') || 'none'}`)
  log(`  Labels: ${getLabelDefinitions().length} definitions`)
}
