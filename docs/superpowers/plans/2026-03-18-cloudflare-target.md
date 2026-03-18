# Cloudflare Target Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `target: 'cloudflare'` to hatk so apps deploy to Cloudflare Workers + Containers with D1 as the database.

**Architecture:** Worker handles HTTP (XRPC, SvelteKit SSR, OAuth, admin). Container handles firehose + backfill. Both share D1. Worker calls Container via Service Binding RPC for resync.

**Tech Stack:** Cloudflare Workers, Cloudflare Containers, D1, Service Bindings RPC, `@sveltejs/adapter-cloudflare`

**Design doc:** `docs/superpowers/specs/2026-03-18-cloudflare-target-design.md`

---

## Batch 1: Config + D1 Adapter

### Task 1: Add `target` field to config

**Files:**
- Modify: `packages/hatk/src/config.ts`

**Step 1: Add `target` to `HatkConfig` and `HatkConfigInput`**

In `HatkConfig` interface, add after `databaseEngine`:

```ts
target: 'node' | 'cloudflare'
```

In `HatkConfigInput`, `target` is already optional via the `Partial<>` wrapping.

In `loadConfig()`, add to the `config` object construction (after the `databaseEngine` line):

```ts
target: (env.HATK_TARGET || parsed.target || 'node') as HatkConfig['target'],
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add packages/hatk/src/config.ts
git commit -m "feat: add target field to HatkConfig (node | cloudflare)"
```

### Task 2: Add `Dialect` type for D1

**Files:**
- Modify: `packages/hatk/src/database/ports.ts`

**Step 1: Add `d1` to Dialect union**

Change line 1 from:

```ts
export type Dialect = 'duckdb' | 'sqlite' | 'postgres'
```

To:

```ts
export type Dialect = 'duckdb' | 'sqlite' | 'd1' | 'postgres'
```

**Step 2: Commit**

```bash
git add packages/hatk/src/database/ports.ts
git commit -m "feat: add d1 to Dialect type"
```

### Task 3: Create D1 database adapter

**Files:**
- Create: `packages/hatk/src/database/adapters/d1.ts`

This is the core of the Cloudflare support. The adapter implements `DatabasePort` using Cloudflare's D1 binding API. It fakes transactions by buffering statements and flushing as `d1.batch()`.

**Step 1: Write the adapter**

```ts
import type { DatabasePort, BulkInserter, Dialect } from '../ports.ts'

/**
 * D1 database adapter for Cloudflare Workers/Containers.
 *
 * D1 is SQLite under the hood but accessed via an HTTP-based binding API.
 * Key differences from the SQLite adapter:
 * - No raw transactions — uses d1.batch() for atomic multi-statement execution
 * - No prepared statement reuse — each query is a fresh prepare+bind
 * - Bulk inserts use batched INSERT statements instead of native appenders
 */

/** Minimal D1 type definitions (matches Cloudflare's D1Database binding) */
interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(sql: string): Promise<D1ExecResult>
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
}

interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: Record<string, unknown>
}

interface D1ExecResult {
  count: number
  duration: number
}

/**
 * Translate DuckDB-style $1, $2 placeholders to ? placeholders.
 * Same logic as the SQLite adapter — D1 uses ? style.
 */
function translateParams(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  if (params.length === 0) return { sql, params }

  const expandedParams: unknown[] = []
  const translated = sql.replace(/\$(\d+)/g, (_match, numStr) => {
    const idx = parseInt(numStr) - 1
    expandedParams.push(params[idx])
    return '?'
  })

  return { sql: translated, params: expandedParams }
}

export class D1Adapter implements DatabasePort {
  dialect: Dialect = 'd1'

  private db!: D1Database
  private txBuffer: D1PreparedStatement[] | null = null

  /**
   * Initialize with an existing D1 binding (from env.DB in Worker/Container).
   * The `path` argument is ignored — D1 bindings are configured in wrangler.jsonc.
   */
  async open(path: string): Promise<void> {
    // D1 binding is injected via initWithBinding(), not opened by path.
    // This is a no-op if already initialized.
    if (!this.db) {
      throw new Error('D1Adapter requires initWithBinding(db) before use')
    }
  }

  /** Set the D1 binding directly (called before open). */
  initWithBinding(db: D1Database): void {
    this.db = db
  }

  close(): void {
    // D1 bindings don't need explicit cleanup
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const t = translateParams(sql, params)
    const stmt = this.db.prepare(t.sql).bind(...t.params)
    const result = await stmt.all<T>()
    return result.results
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const t = translateParams(sql, params)
    const stmt = this.db.prepare(t.sql).bind(...t.params)

    // If inside a transaction, buffer instead of executing
    if (this.txBuffer !== null) {
      this.txBuffer.push(stmt)
      return
    }

    await stmt.run()
  }

  async executeMultiple(sql: string): Promise<void> {
    // D1's exec() handles multi-statement SQL
    await this.db.exec(sql)
  }

  async beginTransaction(): Promise<void> {
    this.txBuffer = []
  }

  async commit(): Promise<void> {
    if (this.txBuffer === null) return
    const statements = this.txBuffer
    this.txBuffer = null
    if (statements.length > 0) {
      await this.db.batch(statements)
    }
  }

  async rollback(): Promise<void> {
    this.txBuffer = null
  }

  async createBulkInserter(
    table: string,
    columns: string[],
    options?: { onConflict?: 'ignore' | 'replace'; batchSize?: number },
  ): Promise<BulkInserter> {
    const placeholders = columns.map(() => '?').join(', ')
    const conflict =
      options?.onConflict === 'ignore' ? ' OR IGNORE' : options?.onConflict === 'replace' ? ' OR REPLACE' : ''
    const sqlTemplate = `INSERT${conflict} INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
    const buffer: D1PreparedStatement[] = []
    const batchSize = options?.batchSize ?? 200 // smaller batches for D1 CPU limits
    const db = this.db

    const flush = async () => {
      if (buffer.length > 0) {
        await db.batch(buffer)
        buffer.length = 0
      }
    }

    return {
      append(values: unknown[]) {
        buffer.push(db.prepare(sqlTemplate).bind(...values))
        if (buffer.length >= batchSize) {
          // Fire and forget — next append or flush will await
          flush()
        }
      },
      async flush() {
        await flush()
      },
      async close() {
        await flush()
      },
    }
  }
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add packages/hatk/src/database/adapters/d1.ts
git commit -m "feat: add D1 database adapter for Cloudflare"
```

### Task 4: Add D1 to adapter factory and dialect

**Files:**
- Modify: `packages/hatk/src/database/adapter-factory.ts`
- Modify: `packages/hatk/src/database/dialect.ts`

**Step 1: Add `d1` case to adapter factory**

Read `packages/hatk/src/database/adapter-factory.ts`. Add a new case after the `sqlite` case:

```ts
case 'd1': {
  const { D1Adapter } = await import('./adapters/d1.ts')
  const { SQLiteSearchPort } = await import('./adapters/sqlite-search.ts')
  const adapter = new D1Adapter()
  // D1 uses SQLite FTS5, same search port
  const searchPort = new SQLiteSearchPort(adapter)
  return { adapter, searchPort }
}
```

Also update the function signature to accept `'d1'`:

```ts
export async function createAdapter(engine: 'duckdb' | 'sqlite' | 'd1'): Promise<{
```

**Step 2: Add D1 dialect to dialect.ts**

Read `packages/hatk/src/database/dialect.ts` to understand the `SqlDialect` shape. Add a D1 dialect entry that reuses the SQLite dialect's values (D1 is SQLite under the hood). The D1 dialect should be identical to the SQLite dialect.

**Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add packages/hatk/src/database/adapter-factory.ts packages/hatk/src/database/dialect.ts
git commit -m "feat: wire D1 into adapter factory and dialect"
```

---

## Batch 2: Worker Entry

### Task 5: Create Worker entry point

**Files:**
- Create: `packages/hatk/src/cloudflare/worker.ts`

This is the Cloudflare Worker fetch handler. It wires together the same XRPC handlers, OAuth, and admin routes that `server.ts` provides, but in a Worker context with D1.

**Step 1: Read existing server code for reference**

Read these files to understand the current request handling:
- `packages/hatk/src/server.ts` — the `createHandler()` function and route matching
- `packages/hatk/src/server-init.ts` — server directory initialization
- `packages/hatk/src/adapter.ts` — HTTP serving
- `packages/hatk/src/main.ts` — full startup sequence

**Step 2: Write the Worker entry**

Create `packages/hatk/src/cloudflare/worker.ts` that:

1. Defines an `Env` interface with `DB: D1Database`, `CONTAINER: ContainerBinding`
2. Exports a default fetch handler
3. On first request, initializes the D1 adapter via `initWithBinding(env.DB)`
4. Runs XRPC route matching (reuse `createHandler()` from server.ts)
5. For admin resync routes, calls `env.CONTAINER.resync(did)` via RPC instead of `triggerAutoBackfill`
6. Falls through to SvelteKit for non-API routes

Note: The exact SvelteKit integration depends on `@sveltejs/adapter-cloudflare` output. For now, create a placeholder that handles XRPC + admin + OAuth, and marks where SvelteKit would slot in.

**Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add packages/hatk/src/cloudflare/worker.ts
git commit -m "feat: add Cloudflare Worker entry point"
```

---

## Batch 3: Container Entry

### Task 6: Create Container entry point

**Files:**
- Create: `packages/hatk/src/cloudflare/container.ts`

This is the Cloudflare Container entry — a long-lived Node process that runs the firehose and backfill, writing to D1.

**Step 1: Read existing entry points for reference**

Read these files:
- `packages/hatk/src/main.ts` — full startup (we need firehose + backfill parts)
- `packages/hatk/src/indexer.ts` — firehose subscription (the `startIndexer` function)
- `packages/hatk/src/backfill.ts` — repo backfill

**Step 2: Write the Container entry**

Create `packages/hatk/src/cloudflare/container.ts` that:

1. Initializes the D1 adapter (Container gets D1 binding from env)
2. Loads lexicons, builds schemas, initializes database tables
3. Initializes feeds, XRPC, labels (same as main.ts)
4. Starts the firehose indexer (`startIndexer`)
5. Starts the backfill loop (`runBackfill`)
6. Exposes RPC methods: `resync(did)`, `resyncAll()`, `getStatus()`

The Container does NOT start an HTTP server — communication is via RPC only.

**Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add packages/hatk/src/cloudflare/container.ts
git commit -m "feat: add Cloudflare Container entry point"
```

---

## Batch 4: Build Command

### Task 7: Add `--target cloudflare` to build command

**Files:**
- Modify: `packages/hatk/src/cli.ts`

**Step 1: Read the existing build command**

Read `packages/hatk/src/cli.ts` and find the `hatk build` command handler. Understand what it currently does (likely runs Vite build for SvelteKit).

**Step 2: Add cloudflare build path**

When `target === 'cloudflare'` in config (or `--target cloudflare` CLI flag):

1. Run `@sveltejs/adapter-cloudflare` build for SvelteKit (this may require swapping the adapter in svelte.config.js or generating a cloudflare-specific one)
2. Bundle `packages/hatk/src/cloudflare/worker.ts` into `dist/worker/index.js`
3. Bundle `packages/hatk/src/cloudflare/container.ts` into `dist/container/index.js`
4. Generate `dist/wrangler.jsonc` with:
   - D1 database binding (`DB`)
   - Service Binding to Container (`CONTAINER`)
   - Container configuration

Example wrangler.jsonc structure:

```jsonc
{
  "name": "my-app",
  "main": "worker/index.js",
  "compatibility_date": "2026-03-18",
  "d1_databases": [
    { "binding": "DB", "database_name": "hatk", "database_id": "TODO" }
  ],
  "services": [
    { "binding": "CONTAINER", "service": "my-app-container" }
  ]
}
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors (the cloudflare build path won't run unless target is set)

**Step 4: Commit**

```bash
git add packages/hatk/src/cli.ts
git commit -m "feat: add --target cloudflare to build command"
```

---

## Batch 5: Integration & Docs

### Task 8: Update `databaseEngine` handling for cloudflare target

**Files:**
- Modify: `packages/hatk/src/config.ts`
- Modify: `packages/hatk/src/main.ts`

**Step 1: Auto-set databaseEngine to 'd1' when target is cloudflare**

In `loadConfig()`, after constructing the config object, add:

```ts
if (config.target === 'cloudflare') {
  config.databaseEngine = 'd1' as any
}
```

Update `HatkConfig.databaseEngine` type to include `'d1'`:

```ts
databaseEngine: 'duckdb' | 'sqlite' | 'd1'
```

**Step 2: Skip file-based operations in main.ts for cloudflare**

In `main.ts`, the `mkdirSync` for the data directory, schema.sql write, and `pragma` settings don't apply to D1. Guard these with `config.target !== 'cloudflare'` checks (or the D1 adapter handles them as no-ops — verify which approach is cleaner).

**Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add packages/hatk/src/config.ts packages/hatk/src/main.ts
git commit -m "feat: auto-set d1 engine for cloudflare target, guard file ops"
```

### Task 9: Add Cloudflare deployment docs

**Files:**
- Create: `docs/site/cli/cloudflare.md`
- Modify: `docs/site/.vitepress/config.ts` (add to CLI sidebar)

**Step 1: Write the docs page**

Cover:
- What `target: 'cloudflare'` does (Worker + Container + D1)
- Prerequisites (Cloudflare account, wrangler CLI)
- Config: add `target: 'cloudflare'` to `hatk.config.ts`
- Build: `hatk build` generates `dist/` with worker, container, wrangler.jsonc
- Deploy: `npx wrangler deploy` (after setting D1 database_id)
- Create D1 database: `npx wrangler d1 create hatk`
- Known limitations (10GB D1 limit, slower backfill)

**Step 2: Add to sidebar**

In `docs/site/.vitepress/config.ts`, add to the CLI Reference items:

```ts
{ text: 'Cloudflare', link: '/cli/cloudflare' },
```

**Step 3: Verify docs build**

Run: `cd docs/site && npx vitepress build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add docs/site/cli/cloudflare.md docs/site/.vitepress/config.ts
git commit -m "docs: add Cloudflare deployment guide"
```
