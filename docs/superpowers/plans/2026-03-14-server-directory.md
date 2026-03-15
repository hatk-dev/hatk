# Server Directory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate all server-side code (feeds, xrpc, hooks, labels, og, setup) into a single `server/` directory scanned by export type, with Vite SSR HMR for handler code.

**Architecture:** A new `scanner.ts` module recursively walks `server/`, imports each file, inspects default exports for type tags (`__type: 'feed' | 'query' | 'procedure' | ...`), and routes them to existing subsystem registration. The Vite plugin replaces the `tsx watch` child process with `ssrLoadModule()` for true HMR. Define functions that don't exist yet (`defineSetup`, `defineHook`, `defineLabels`, `defineOG`) are added as thin typed wrappers.

**Tech Stack:** TypeScript, Vite SSR API (`ssrLoadModule`), existing hatk subsystems

**Working directory:** `/Users/chadmiller/code/hatk/.worktrees/server-directory`

---

### Task 1: Add type tags to existing define functions

The scanner needs to distinguish what kind of handler a file exports. We add a `__type` property to the objects returned by `defineFeed`, `defineQuery`, and `defineProcedure`.

**Files:**
- Modify: `packages/hatk/src/feeds.ts:136-138`
- Modify: `packages/hatk/src/cli.ts:1666-1677` (the generated defineQuery/defineProcedure)

**Step 1: Add `__type` to defineFeed**

In `packages/hatk/src/feeds.ts`, change the `defineFeed` function at line 136:

```typescript
export function defineFeed(opts: FeedOpts) {
  return { __type: 'feed' as const, ...opts, generate: (ctx: any) => opts.generate({ ...ctx, ok: (v: any) => v }) }
}
```

**Step 2: Add `__type` to generated defineQuery and defineProcedure**

In `packages/hatk/src/cli.ts`, update the code generation (around line 1666) so the emitted `defineQuery` returns `{ __type: 'query', nsid, handler }` and `defineProcedure` returns `{ __type: 'procedure', nsid, handler }`:

Change the `defineQuery` template from:
```typescript
out += `  return { handler: (ctx: any) => handler({ ...ctx, ok: (v: any) => v }) }\n`
```
to:
```typescript
out += `  return { __type: 'query' as const, nsid, handler: (ctx: any) => handler({ ...ctx, ok: (v: any) => v }) }\n`
```

Same for `defineProcedure` — change to:
```typescript
out += `  return { __type: 'procedure' as const, nsid, handler: (ctx: any) => handler({ ...ctx, ok: (v: any) => v }) }\n`
```

**Step 3: Verify build**

Run: `cd packages/hatk && npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/hatk/src/feeds.ts packages/hatk/src/cli.ts
git commit -m "feat: add __type tags to defineFeed/defineQuery/defineProcedure"
```

---

### Task 2: Create defineSetup, defineHook, defineLabels, defineOG

New thin define functions for handler types that currently use raw exports.

**Files:**
- Modify: `packages/hatk/src/setup.ts` (add `defineSetup`)
- Modify: `packages/hatk/src/hooks.ts` (add `defineHook`)
- Modify: `packages/hatk/src/labels.ts` (add `defineLabels`)
- Modify: `packages/hatk/src/opengraph.ts` (add `defineOG`)

**Step 1: Add `defineSetup` to setup.ts**

Add after the `SetupContext` interface (after line 43):

```typescript
export type SetupHandler = (ctx: SetupContext) => Promise<void>

export function defineSetup(handler: SetupHandler) {
  return { __type: 'setup' as const, handler }
}
```

**Step 2: Add `defineHook` to hooks.ts**

Add after the `OnLoginCtx` type (after line 36):

```typescript
export function defineHook(event: 'on-login', handler: (ctx: OnLoginCtx) => Promise<void>) {
  return { __type: 'hook' as const, event, handler }
}
```

**Step 3: Add `defineLabels` to labels.ts**

First read the `LabelDefinition` type from `config.ts`. Add after the `LabelRuleContext` interface (after line 48):

```typescript
export interface LabelModule {
  definition?: LabelDefinition
  evaluate?: (ctx: LabelRuleContext) => Promise<string[]>
}

export function defineLabels(module: LabelModule) {
  return { __type: 'labels' as const, ...module }
}
```

**Step 4: Add `defineOG` to opengraph.ts**

Add after the `OpengraphContext` interface (after line 39). First read the full file to find `OpengraphResult` type, then add:

```typescript
export function defineOG(
  path: string,
  generate: (ctx: OpengraphContext) => Promise<OpengraphResult>,
) {
  return { __type: 'og' as const, path, generate }
}
```

**Step 5: Verify build**

Run: `cd packages/hatk && npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add packages/hatk/src/setup.ts packages/hatk/src/hooks.ts packages/hatk/src/labels.ts packages/hatk/src/opengraph.ts
git commit -m "feat: add defineSetup, defineHook, defineLabels, defineOG"
```

---

### Task 3: Create the server scanner module

This is the core new module. It recursively walks a directory, imports each file, inspects the `__type` of the default export, and returns categorized results.

**Files:**
- Create: `packages/hatk/src/scanner.ts`

**Step 1: Write scanner.ts**

```typescript
import { resolve, relative } from 'node:path'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { log } from './logger.ts'

export interface ScannedModule {
  path: string
  name: string
  mod: any
}

export interface ScanResult {
  feeds: ScannedModule[]
  queries: ScannedModule[]
  procedures: ScannedModule[]
  hooks: ScannedModule[]
  setup: ScannedModule[]
  labels: ScannedModule[]
  og: ScannedModule[]
  unknown: ScannedModule[]
}

/** Recursively collect .ts/.js files, skipping _ prefixed files */
function walkDir(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue
      const full = resolve(dir, entry)
      if (statSync(full).isDirectory()) {
        results.push(...walkDir(full))
      } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        results.push(full)
      }
    }
  } catch {}
  return results.sort()
}

/**
 * Scan a directory for hatk server modules.
 * Each file's default export is inspected for a `__type` tag.
 * Files without a __type tag are checked for legacy export shapes
 * (raw handler functions, objects with `generate`/`evaluate`/`path` fields).
 */
export async function scanServerDir(serverDir: string): Promise<ScanResult> {
  const result: ScanResult = {
    feeds: [],
    queries: [],
    procedures: [],
    hooks: [],
    setup: [],
    labels: [],
    og: [],
    unknown: [],
  }

  if (!existsSync(serverDir)) return result

  const files = walkDir(serverDir)

  for (const filePath of files) {
    const name = relative(serverDir, filePath).replace(/\.(ts|js)$/, '')
    const mod = await import(filePath)
    const exported = mod.default

    if (!exported) {
      log(`[scanner] ${name}: no default export, skipping`)
      continue
    }

    const entry: ScannedModule = { path: filePath, name, mod: exported }

    if (exported.__type) {
      switch (exported.__type) {
        case 'feed':
          result.feeds.push(entry)
          break
        case 'query':
          result.queries.push(entry)
          break
        case 'procedure':
          result.procedures.push(entry)
          break
        case 'hook':
          result.hooks.push(entry)
          break
        case 'setup':
          result.setup.push(entry)
          break
        case 'labels':
          result.labels.push(entry)
          break
        case 'og':
          result.og.push(entry)
          break
        default:
          log(`[scanner] ${name}: unknown __type '${exported.__type}'`)
          result.unknown.push(entry)
      }
    } else {
      log(`[scanner] ${name}: no __type tag, skipping`)
      result.unknown.push(entry)
    }
  }

  return result
}
```

**Step 2: Verify build**

Run: `cd packages/hatk && npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/hatk/src/scanner.ts
git commit -m "feat: add server directory scanner module"
```

---

### Task 4: Add registration functions to subsystems

Each subsystem needs a function to register a handler from a scanned module, so the scanner results can be wired up without duplicating the init logic.

**Files:**
- Modify: `packages/hatk/src/feeds.ts` (add `registerFeed`)
- Modify: `packages/hatk/src/xrpc.ts` (add `registerXrpcHandler`)
- Modify: `packages/hatk/src/labels.ts` (add `registerLabelModule`)
- Modify: `packages/hatk/src/opengraph.ts` (add `registerOgHandler`)
- Modify: `packages/hatk/src/hooks.ts` (add `registerHook`)
- Modify: `packages/hatk/src/setup.ts` (add `runSetupHandler`)

**Step 1: Add `registerFeed` to feeds.ts**

Read `feeds.ts` fully to understand the `FeedHandler` type and how `initFeeds` builds one from a module's default export. Add a new exported function that does the same thing for a single module:

```typescript
/** Register a single feed from a scanned module. */
export function registerFeed(name: string, generator: ReturnType<typeof defineFeed>): void {
  const handler: FeedHandler = {
    name,
    label: generator.label || name,
    collection: generator.collection,
    view: generator.view,
    generate: async (params, cursor, limit, viewer) => {
      const paginateDeps = { db: { query: querySQL }, cursor, limit, packCursor, unpackCursor }
      const ctx: FeedContext = {
        db: { query: querySQL },
        params,
        cursor,
        limit,
        viewer,
        packCursor,
        unpackCursor,
        isTakendown: isTakendownDid,
        filterTakendownDids,
        paginate: createPaginate(paginateDeps),
      }
      return generator.generate(ctx)
    },
    hydrate: generator.hydrate
      ? async (items, viewer) => {
          const ctx = buildHydrateContext(items, viewer, querySQL, resolveRecords)
          return generator.hydrate!(ctx)
        }
      : undefined,
  }
  feeds.set(name, handler)
}
```

Note: Copy the handler construction logic from `initFeeds` exactly — read the file to get the full context including `paginate` construction and `hydrate` wrapping.

**Step 2: Add `registerXrpcHandler` to xrpc.ts**

Read `xrpc.ts` fully to understand how `initXrpc` registers a handler with its NSID. Add:

```typescript
/** Register a single XRPC handler from a scanned module. */
export function registerXrpcHandler(nsid: string, handlerModule: { handler: Function }): void {
  // Use the same registration logic as initXrpc — look up lexicon params, wrap handler
  const handler = handlerModule.handler
  xrpcHandlers.set(nsid, { nsid, handler, params: extractLexiconParams(nsid) })
}
```

The exact shape depends on what `initXrpc` does internally — read the file and mirror the logic.

**Step 3: Add `registerLabelModule` to labels.ts**

```typescript
/** Register a single label module from a scanned module. */
export function registerLabelModule(name: string, labelMod: LabelModule): void {
  if (labelMod.definition) {
    labelDefs.push(labelMod.definition)
  }
  if (labelMod.evaluate) {
    rules.push({ name, evaluate: labelMod.evaluate })
  }
}
```

**Step 4: Add `registerOgHandler` to opengraph.ts**

Read `opengraph.ts` fully to understand how handlers are stored and matched. Add a function that registers a single OG handler with its compiled path pattern.

**Step 5: Add `registerHook` to hooks.ts**

```typescript
/** Register a hook from a scanned module. */
export function registerHook(event: string, handler: Function): void {
  if (event === 'on-login') {
    onLoginHook = handler as OnLoginHook
    log('[hooks] on-login hook registered')
  }
}
```

**Step 6: Add `runSetupHandler` to setup.ts**

```typescript
/** Run a single setup handler with a SetupContext. */
export async function runSetupHandler(name: string, handler: SetupHandler): Promise<void> {
  const ctx: SetupContext = {
    db: { query: querySQL, run: runSQL, runBatch, createBulkInserter: createBulkInserterSQL },
  }
  log(`[setup] running: ${name}`)
  await handler(ctx)
  log(`[setup] done: ${name}`)
}
```

**Step 7: Verify build**

Run: `cd packages/hatk && npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git add packages/hatk/src/feeds.ts packages/hatk/src/xrpc.ts packages/hatk/src/labels.ts packages/hatk/src/opengraph.ts packages/hatk/src/hooks.ts packages/hatk/src/setup.ts
git commit -m "feat: add register functions to each subsystem for scanner integration"
```

---

### Task 5: Create `initServer` that ties scanner to subsystems

This replaces the 6 individual init calls in `main.ts` with one call.

**Files:**
- Create: `packages/hatk/src/server-init.ts`

**Step 1: Write server-init.ts**

```typescript
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { log } from './logger.ts'
import { scanServerDir } from './scanner.ts'
import { registerFeed, listFeeds } from './feeds.ts'
import { registerXrpcHandler, listXrpc } from './xrpc.ts'
import { registerLabelModule, getLabelDefinitions } from './labels.ts'
import { registerOgHandler } from './opengraph.ts'
import { registerHook } from './hooks.ts'
import { runSetupHandler } from './setup.ts'

/**
 * Scan the server/ directory and register all discovered handlers.
 * Setup scripts run immediately (in sorted order).
 * Returns the scan result for logging.
 */
export async function initServer(serverDir: string): Promise<void> {
  if (!existsSync(serverDir)) {
    log(`[server] No server/ directory found, skipping`)
    return
  }

  const scanned = await scanServerDir(serverDir)

  // 1. Run setup scripts first (sorted by name)
  for (const entry of scanned.setup.sort((a, b) => a.name.localeCompare(b.name))) {
    await runSetupHandler(entry.name, entry.mod.handler)
  }

  // 2. Register feeds
  for (const entry of scanned.feeds) {
    const feedName = entry.mod.label ? entry.name : entry.name
    registerFeed(feedName, entry.mod)
    log(`[server] Feed registered: ${feedName}`)
  }

  // 3. Register XRPC handlers
  for (const entry of scanned.queries) {
    registerXrpcHandler(entry.mod.nsid, entry.mod)
    log(`[server] Query registered: ${entry.mod.nsid}`)
  }
  for (const entry of scanned.procedures) {
    registerXrpcHandler(entry.mod.nsid, entry.mod)
    log(`[server] Procedure registered: ${entry.mod.nsid}`)
  }

  // 4. Register hooks
  for (const entry of scanned.hooks) {
    registerHook(entry.mod.event, entry.mod.handler)
  }

  // 5. Register labels
  for (const entry of scanned.labels) {
    registerLabelModule(entry.name, entry.mod)
  }

  // 6. Register OG handlers
  for (const entry of scanned.og) {
    registerOgHandler(entry.mod)
  }

  log(`[server] Initialized from server/ directory:`)
  log(`  Feeds: ${listFeeds().map((f) => f.name).join(', ') || 'none'}`)
  log(`  XRPC: ${listXrpc().join(', ') || 'none'}`)
  log(`  Labels: ${getLabelDefinitions().length} definitions`)
}
```

**Step 2: Verify build**

Run: `cd packages/hatk && npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/hatk/src/server-init.ts
git commit -m "feat: add initServer to tie scanner to subsystem registration"
```

---

### Task 6: Wire `initServer` into main.ts

Replace the individual init calls with `initServer()`, keeping backward compatibility with the old directory-based init calls as a fallback.

**Files:**
- Modify: `packages/hatk/src/main.ts`

**Step 1: Add server/ directory scanning**

In `main.ts`, add the import:
```typescript
import { initServer } from './server-init.ts'
```

Then, after the setup/schema section (around line 97), replace the block from `initSetup` through `initLabels` (lines 97-142) with:

```typescript
// 3b. Initialize from server/ directory (or fall back to legacy directories)
const serverDir = resolve(configDir, 'server')
if (existsSync(serverDir)) {
  await initServer(serverDir)
} else {
  // Legacy: separate directories
  await initSetup(resolve(configDir, 'setup'))
  await initFeeds(resolve(configDir, 'feeds'))
  await initXrpc(resolve(configDir, 'xrpc'))
  await initOpengraph(resolve(configDir, 'og'))
  await initLabels(resolve(configDir, 'labels'))
  await loadOnLoginHook(resolve(configDir, 'hooks'))
}
```

Add `existsSync` import from `node:fs` (it's already imported on line 1 as `mkdirSync, writeFileSync` — add `existsSync`).

**Step 2: Move schema.sql write after initServer**

The schema.sql write (lines 100-109) should remain after initServer since setup scripts may create tables.

**Step 3: Verify build**

Run: `cd packages/hatk && npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/hatk/src/main.ts
git commit -m "feat: wire initServer into main.ts with legacy fallback"
```

---

### Task 7: Export new define functions from package

Users need to import `defineSetup`, `defineHook`, `defineLabels`, `defineOG` from the hatk package.

**Files:**
- Modify: `packages/hatk/package.json` (add exports if needed)
- Modify: `packages/hatk/src/cli.ts` (update `hatk.generated.ts` code generation to re-export new defines)

**Step 1: Update generated file template in cli.ts**

Find where `hatk.generated.ts` emits its imports and re-exports. Add re-exports for the new define functions:

```typescript
out += `export { defineSetup } from '@hatk/hatk/setup'\n`
out += `export { defineHook } from '@hatk/hatk/hooks'\n`
out += `export { defineLabels } from '@hatk/hatk/labels'\n`
out += `export { defineOG } from '@hatk/hatk/opengraph'\n`
```

These should go near the existing re-exports (around the XRPC Helpers section, line 1654-1656).

**Step 2: Add `./hooks` export to package.json if missing**

Check `packages/hatk/package.json` exports. If `./hooks` isn't listed, add it. Same for `./setup`, `./labels`, `./opengraph` — most of these already exist.

**Step 3: Verify build**

Run: `cd packages/hatk && npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/hatk/src/cli.ts packages/hatk/package.json
git commit -m "feat: export new define functions from hatk.generated.ts"
```

---

### Task 8: Replace `tsx watch` with Vite SSR in the plugin

This is the biggest change — the Vite plugin no longer spawns a child process. Instead, it boots hatk's core runtime and uses `ssrLoadModule()` for handler code.

**Files:**
- Modify: `packages/hatk/src/vite-plugin.ts`

**Step 1: Understand the current plugin**

Read `packages/hatk/src/vite-plugin.ts` completely. Currently it:
- Spawns `npx tsx watch` with `main.js` as the entry
- Proxies backend routes to the child process
- Kills child on server close

**Step 2: Rewrite configureServer hook**

Replace the `spawn`-based approach with Vite SSR module loading:

```typescript
async configureServer(server) {
  // Boot hatk core runtime (database, indexer, OAuth) once
  const mainModule = await server.ssrLoadModule(
    resolve(import.meta.dirname!, 'main.js')
  )
  // The main module's side effects boot the runtime

  // For HMR: watch server/ directory and re-scan on changes
  server.watcher.on('change', async (file) => {
    if (file.includes('/server/')) {
      // Invalidate the module in Vite's module graph
      const mod = server.moduleGraph.getModuleById(file)
      if (mod) {
        server.moduleGraph.invalidateModule(mod)
      }
      // Re-scan and re-register handlers
      // ... (call initServer again)
    }
  })
}
```

**Important considerations:**
- `main.ts` currently does `process.exit(1)` after backfill — that needs to be skipped in dev mode (already handled by `DEV_MODE` env)
- The proxy rules can be removed since the server runs in-process
- Need to handle the case where ssrLoadModule resolves the module but hatk's main.ts is designed as a script, not a module that exports anything

**Step 3: Alternative approach — middleware mode**

A simpler approach that preserves more of the current architecture: instead of running main.ts through ssrLoadModule, have the Vite plugin register middleware that intercepts backend routes and passes them to hatk's server handler directly. This avoids the complexity of running the full main.ts through Vite's SSR pipeline.

Read `server.ts` to understand the request handler shape. The plugin can import `startServer` or the underlying handler function and mount it as Vite middleware.

**NOTE:** This task requires careful investigation of the Vite SSR API and hatk's server module. The implementing engineer should:
1. Read Vite's SSR documentation on `ssrLoadModule` and `server.middlewares`
2. Read `packages/hatk/src/server.ts` fully to understand the request handler
3. Decide between full SSR module loading vs middleware mounting
4. The key goal is: edits to files in `server/` should trigger re-import without restarting the database/indexer

**Step 4: Verify the dev server starts**

Run: `cd /path/to/template && npm run dev`
Expected: Vite dev server starts, backend routes work, editing a feed handler triggers HMR

**Step 5: Commit**

```bash
git add packages/hatk/src/vite-plugin.ts
git commit -m "feat: replace tsx watch with Vite SSR for handler HMR"
```

---

### Task 9: Update `hatk new` CLI scaffolding

The `hatk new` command scaffolds a new project. It needs to create `server/` instead of `feeds/`, `xrpc/`, `hooks/`, etc.

**Files:**
- Modify: `packages/hatk/src/cli.ts` (the `new` command scaffolding section)

**Step 1: Find the scaffolding code**

Search `cli.ts` for where it creates the project directory structure (look for `mkdirSync` calls creating `feeds/`, `xrpc/`, etc.).

**Step 2: Update directory creation**

Replace:
```
feeds/
xrpc/
hooks/
labels/
og/
setup/
```

With:
```
server/
```

**Step 3: Update template files**

Update any template feed/xrpc/hook files that get scaffolded to use the new import paths and live in `server/`.

**Step 4: Verify**

Run: `cd /tmp && hatk new test-app` (or the equivalent CLI command)
Expected: Project created with `server/` directory instead of separate directories

**Step 5: Commit**

```bash
git add packages/hatk/src/cli.ts
git commit -m "feat: update hatk new to scaffold server/ directory"
```

---

### Task 10: Update build output

`vite build` needs to produce a server entry point alongside static assets.

**Files:**
- Modify: `packages/hatk/src/vite-plugin.ts` (add build config)

**Step 1: Add SSR build configuration**

In the `config()` hook of the Vite plugin, add build configuration:

```typescript
build: {
  ssrManifest: true,
  rollupOptions: {
    input: {
      // Include main.ts as SSR entry
    },
  },
},
ssr: {
  // External node modules that shouldn't be bundled
  external: ['better-sqlite3', '@duckdb/node-api'],
},
```

**Step 2: Add a production entry point**

Create a file that boots hatk in production mode (no HMR, serves static files from dist/).

**Step 3: Verify build**

Run: `cd /path/to/template && npm run build && node dist/server.js`
Expected: Server starts, serves static assets and handles XRPC/feed routes

**Step 4: Commit**

```bash
git add packages/hatk/src/vite-plugin.ts
git commit -m "feat: add vite build SSR output for production"
```

---

### Task 11: Test with statusphere template

Convert the statusphere template to the new `server/` layout and verify everything works.

**Files:**
- Work in: `/Users/chadmiller/code/hatk-template-statusphere`

**Step 1: Create server/ directory and move files**

```
server/
  recent.ts          ← was feeds/recent.ts
  get-profile.ts     ← was xrpc/xyz/statusphere/getProfile.ts
  on-login.ts        ← was hooks/on-login.ts
```

**Step 2: Update imports in moved files**

Change `from '../hatk.generated.ts'` to `from '../hatk.generated.ts'` (path may change depending on new location).

Update define function usage:
- `recent.ts`: already uses `defineFeed` — no change needed
- `get-profile.ts`: already uses `defineQuery` — no change needed
- `on-login.ts`: change from raw export to `defineHook`:
  ```typescript
  import { defineHook } from '../hatk.generated.ts'

  export default defineHook('on-login', async ({ did, ensureRepo }) => {
    await ensureRepo(did)
  })
  ```

**Step 3: Remove old directories**

Delete `feeds/`, `xrpc/`, `hooks/` directories.

**Step 4: Test**

Run: `npm run dev`
Expected: App starts, feeds work, XRPC queries work, login hook fires

**Step 5: Commit in template repo**

```bash
git add -A
git commit -m "feat: migrate to server/ directory layout"
```

---

### Task 12: Test with teal template

Convert the teal template — this is the more complex case with shared hydration, multiple feeds, OG generators, and setup scripts.

**Files:**
- Work in: `/Users/chadmiller/code/hatk-template-teal`

**Step 1: Create server/ directory structure**

```
server/
  feeds/
    recent.ts
    actor.ts
    artist.ts
    bookmarks.ts
    following.ts
    genre.ts
    release.ts
    track.ts
    _hydrate.ts        ← shared helper, _ prefix means scanner skips it
  xrpc/
    getActorProfile.ts
    getPlay.ts
    getStats.ts
    getTrendingArtists.ts
    searchArtists.ts
    ... (all other handlers)
  og/
    artist.ts
    release.ts
    track.ts
  setup/
    import-genres.ts
  on-login.ts
```

**Step 2: Update imports and define functions**

- Feed files: update relative import paths, already use `defineFeed`
- XRPC files: update relative import paths, already use `defineQuery`
- OG files: wrap with `defineOG`:
  ```typescript
  import { defineOG } from '../../hatk.generated.ts'

  export default defineOG('/og/artist/:artist', async (ctx) => {
    // ... existing generate logic
  })
  ```
- Setup files: wrap with `defineSetup`:
  ```typescript
  import { defineSetup } from '../../hatk.generated.ts'

  export default defineSetup(async (ctx) => {
    // ... existing handler logic
  })
  ```
- Hook: wrap with `defineHook`

**Step 3: Remove old directories**

Delete `feeds/`, `xrpc/`, `hooks/`, `og/`, `setup/` at project root.

**Step 4: Test**

Run: `npm run dev`
Expected: All feeds, queries, OG images, labels, setup scripts work as before

**Step 5: Commit in template repo**

```bash
git add -A
git commit -m "feat: migrate to server/ directory layout"
```
