# BaseContext Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract a shared `BaseContext` type so hydrators work with both feed and XRPC contexts without manual field spreading or `as any` casts.

**Architecture:** Replace `HydrateContext` with `BaseContext` (shared data access interface). `XrpcContext` extends `BaseContext`. Feed hydrate signature changes from `(ctx: HydrateContext<T>)` to `(ctx: BaseContext, items: Row<T>[])`. No deprecation — clean break.

**Tech Stack:** TypeScript, hatk framework (`packages/hatk/src/`), template projects (grain, teal)

---

### Task 1: Add BaseContext and buildBaseContext to hydrate.ts

**Files:**
- Modify: `packages/hatk/src/hydrate.ts`

**Step 1: Replace HydrateContext with BaseContext**

Replace the `HydrateContext` interface and `buildHydrateContext` function with:

```ts
export interface BaseContext {
  viewer: { did: string; handle?: string } | null
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }
  getRecords: <R = unknown>(collection: string, uris: string[]) => Promise<Map<string, Row<R>>>
  lookup: <R = unknown>(collection: string, field: string, values: string[]) => Promise<Map<string, Row<R>>>
  count: (collection: string, field: string, values: string[]) => Promise<Map<string, number>>
  labels: (uris: string[]) => Promise<Map<string, unknown[]>>
  blobUrl: (
    did: string,
    ref: unknown,
    preset?: 'avatar' | 'banner' | 'feed_thumbnail' | 'feed_fullsize',
  ) => string | undefined
}
```

Key differences from `HydrateContext`:
- No `items` field (items are now a separate argument)
- No generic `<T>` parameter
- `viewer` gains optional `handle` field
- `db.query` params typed as `unknown[]` not `any[]`

Replace `buildHydrateContext`:

```ts
/** Build a BaseContext for hydration. */
export function buildBaseContext(viewer: { did: string; handle?: string } | null): BaseContext {
  return {
    viewer,
    db: { query: querySQL },
    getRecords: getRecordsMap,
    lookup: async (collection, field, values) => {
      if (values.length === 0) return new Map()
      const unique = [...new Set(values.filter(Boolean))]
      return lookupByFieldBatch(collection, field, unique) as any
    },
    count: async (collection, field, values) => {
      if (values.length === 0) return new Map()
      const unique = [...new Set(values.filter(Boolean))]
      return countByFieldBatch(collection, field, unique)
    },
    labels: queryLabelsForUris,
    blobUrl,
  }
}
```

Note: `buildBaseContext` takes only `viewer`, not `items`. The `as any` on `lookupByFieldBatch` return is acceptable — it's an internal implementation detail where the batch function returns the right shape but TypeScript can't prove it.

**Step 2: Verify the file compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit -p packages/hatk/tsconfig.json 2>&1 | head -30`

Expected: Errors in `feeds.ts` referencing the old `HydrateContext` name — that's expected, we fix it in Task 2.

---

### Task 2: Update feeds.ts to use BaseContext

**Files:**
- Modify: `packages/hatk/src/feeds.ts`

**Step 1: Update imports**

Change:
```ts
import { resolveRecords, buildHydrateContext } from './hydrate.ts'
import type { HydrateContext, Row } from './hydrate.ts'

export type { HydrateContext, Row }
```

To:
```ts
import { resolveRecords, buildBaseContext } from './hydrate.ts'
import type { BaseContext, Row } from './hydrate.ts'

export type { BaseContext, Row }
```

**Step 2: Update FeedHandler interface**

Change the `hydrate` field type:
```ts
// Before
hydrate?: (ctx: HydrateContext) => Promise<unknown[]>

// After
hydrate?: (ctx: BaseContext, items: Row<unknown>[]) => Promise<unknown[]>
```

**Step 3: Update FeedOpts type**

Change both union members:
```ts
type FeedOpts =
  | {
      collection: string
      view?: string
      label: string
      generate: FeedGenerate
      hydrate?: (ctx: BaseContext, items: Row<any>[]) => Promise<unknown[]>
    }
  | {
      collection?: never
      view?: never
      label: string
      generate: FeedGenerate
      hydrate: (ctx: BaseContext, items: Row<any>[]) => Promise<unknown[]>
    }
```

**Step 4: Update executeFeed**

Change the hydrate call site from:
```ts
const ctx = buildHydrateContext(items, viewer || null)
const hydrated = await handler.hydrate(ctx)
```

To:
```ts
const ctx = buildBaseContext(viewer || null)
const hydrated = await handler.hydrate(ctx, items)
```

**Step 5: Verify**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit -p packages/hatk/tsconfig.json 2>&1 | head -30`

Expected: Errors in `cli.ts` referencing old `HydrateContext` — fixed in Task 4.

---

### Task 3: XrpcContext extends BaseContext in xrpc.ts

**Files:**
- Modify: `packages/hatk/src/xrpc.ts`

**Step 1: Import BaseContext**

Add to the imports from `./hydrate.ts`:
```ts
import { resolveRecords } from './hydrate.ts'
import type { BaseContext } from './hydrate.ts'
```

**Step 2: Update XrpcContext interface**

Change from a standalone interface to one that extends BaseContext:

```ts
export interface XrpcContext<
  P = Record<string, string>,
  Records extends Record<string, any> = Record<string, any>,
  I = unknown,
> extends BaseContext {
  db: {
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>
    run: (sql: string, ...params: unknown[]) => Promise<void>
  }
  params: P
  input: I
  cursor?: string
  limit: number
  packCursor: (primary: string | number, cid: string) => string
  unpackCursor: (cursor: string) => { primary: string; cid: string } | null
  isTakendown: (did: string) => Promise<boolean>
  filterTakendownDids: (dids: string[]) => Promise<Set<string>>
  search: <K extends string & keyof Records>(
    collection: K,
    q: string,
    opts?: { limit?: number; cursor?: string; fuzzy?: boolean },
  ) => Promise<{ records: Row<Records[K]>[]; cursor?: string }>
  resolve: <R = unknown>(uris: string[]) => Promise<Row<R>[]>
  exists: (collection: string, filters: Record<string, string>) => Promise<boolean>
}
```

Key changes:
- `extends BaseContext` — inherits viewer, db.query, getRecords, lookup, count, labels, blobUrl
- `db` field overrides BaseContext's `db` to add `.run` method (TypeScript allows this since it's a superset)
- Remove fields already in BaseContext: `getRecords`, `lookup`, `count`, `labels`, `blobUrl` — they're inherited
- `viewer` is inherited from BaseContext: `{ did: string; handle?: string } | null`
- Tighten `any` types to `unknown` where possible

**Step 3: Update context construction in initXrpc and registerXrpcHandler**

Both `initXrpc` (line ~200) and `registerXrpcHandler` (line ~263) construct `XrpcContext` objects. Remove the fields that are now inherited from BaseContext (they still need to be set since we're constructing an object literal, not using a builder). The construction stays the same shape but now the types are stricter:

```ts
const ctx: XrpcContext = {
  db: { query: querySQL, run: runSQL },
  params,
  input: input || {},
  cursor,
  limit,
  viewer,
  packCursor,
  unpackCursor,
  isTakendown: isTakendownDid,
  filterTakendownDids,
  search: searchRecords,
  resolve: resolveRecords as any,
  getRecords: getRecordsMap,
  lookup: async (collection, field, values) => {
    if (values.length === 0) return new Map()
    const unique = [...new Set(values.filter(Boolean))]
    return lookupByFieldBatch(collection, field, unique) as any
  },
  count: async (collection, field, values) => {
    if (values.length === 0) return new Map()
    const unique = [...new Set(values.filter(Boolean))]
    return countByFieldBatch(collection, field, unique)
  },
  exists: async (collection, filters) => {
    const conditions = Object.entries(filters).map(([field, value]) => ({ field, value }))
    const uri = await findUriByFields(collection, conditions)
    return uri !== null
  },
  labels: queryLabelsForUris,
  blobUrl,
}
```

The object literal is the same — `extends` just means the interface is compatible, not that construction changes.

**Step 4: Verify**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit -p packages/hatk/tsconfig.json 2>&1 | head -30`

---

### Task 4: Update opengraph.ts context construction

**Files:**
- Modify: `packages/hatk/src/opengraph.ts`

**Step 1: No structural changes needed**

`opengraph.ts` constructs `XrpcContext` objects (line ~135 in `initOpengraph` and line ~222 in `registerOgHandler`). Since `XrpcContext extends BaseContext`, these constructions are already correct — they include all BaseContext fields.

The only change: if TypeScript complains about the `any` types that were tightened to `unknown` in `XrpcContext`, update the `db.query` and `labels` types in the construction to match.

**Step 2: Verify**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit -p packages/hatk/tsconfig.json 2>&1 | head -30`

---

### Task 5: Update cli.ts codegen

**Files:**
- Modify: `packages/hatk/src/cli.ts`

**Step 1: Update the import line (around line 1527)**

Change:
```ts
out += `import { defineFeed as _defineFeed, type FeedResult, type FeedContext, type HydrateContext, type Row } from '@hatk/hatk/feeds'\n`
```

To:
```ts
out += `import { defineFeed as _defineFeed, type FeedResult, type FeedContext, type BaseContext, type Row } from '@hatk/hatk/feeds'\n`
```

**Step 2: Update the re-export line (around line 1695)**

Change:
```ts
out += `export type { HydrateContext, Row } from '@hatk/hatk/feeds'\n`
```

To:
```ts
out += `export type { BaseContext, Row } from '@hatk/hatk/feeds'\n`
```

**Step 3: Update defineFeed overloads (around lines 1733-1738)**

Change:
```ts
out += `export function defineFeed<K extends keyof RecordRegistry>(\n`
out += `  opts: { collection: K; view?: string; label: string; generate: FeedGenerate; hydrate?: (ctx: HydrateContext<RecordRegistry[K]>) => Promise<unknown[]> }\n`
out += `): ReturnType<typeof _defineFeed>\n`
out += `export function defineFeed(\n`
out += `  opts: { collection?: never; view?: never; label: string; generate: FeedGenerate; hydrate: (ctx: HydrateContext<any>) => Promise<unknown[]> }\n`
out += `): ReturnType<typeof _defineFeed>\n`
```

To:
```ts
out += `export function defineFeed<K extends keyof RecordRegistry>(\n`
out += `  opts: { collection: K; view?: string; label: string; generate: FeedGenerate; hydrate?: (ctx: BaseContext, items: Row<RecordRegistry[K]>[]) => Promise<unknown[]> }\n`
out += `): ReturnType<typeof _defineFeed>\n`
out += `export function defineFeed(\n`
out += `  opts: { collection?: never; view?: never; label: string; generate: FeedGenerate; hydrate: (ctx: BaseContext, items: Row<unknown>[]) => Promise<unknown[]> }\n`
out += `): ReturnType<typeof _defineFeed>\n`
```

Key change: `hydrate` goes from `(ctx: HydrateContext<T>) => ...` to `(ctx: BaseContext, items: Row<T>[]) => ...`. The second overload uses `Row<unknown>` instead of `HydrateContext<any>`.

**Step 4: Verify hatk compiles**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit -p packages/hatk/tsconfig.json 2>&1 | head -30`

Expected: Clean compile. All hatk framework changes are done.

**Step 5: Bump version and publish**

Run: `cd /Users/chadmiller/code/hatk && npm version prerelease --preid alpha -w packages/hatk`

Then commit all hatk changes (hydrate.ts, feeds.ts, xrpc.ts, cli.ts, and version bump).

---

### Task 6: Update grain template — _hydrate.ts

**Files:**
- Modify: `/Users/chadmiller/code/hatk-template-grain/server/feeds/_hydrate.ts`

**Step 1: Install updated hatk**

Run: `cd /Users/chadmiller/code/hatk-template-grain && npm install`

**Step 2: Regenerate types**

Run: `cd /Users/chadmiller/code/hatk-template-grain && npx hatk generate`

**Step 3: Update hydrateGalleries signature**

Change:
```ts
import type { HydrateContext, Row } from "$hatk";

export async function hydrateGalleries(ctx: HydrateContext<Gallery>): Promise<GalleryView[]> {
  const dids = [...new Set(ctx.items.map((item) => item.did).filter(Boolean))];
```

To:
```ts
import type { BaseContext, Row } from "$hatk";

export async function hydrateGalleries(ctx: BaseContext, items: Row<Gallery>[]): Promise<GalleryView[]> {
  const dids = [...new Set(items.map((item) => item.did).filter(Boolean))];
```

**Step 4: Replace all `ctx.items` with `items` in the function body**

Every reference to `ctx.items` becomes just `items`:
- `ctx.items.map(...)` → `items.map(...)`
- `ctx.items.length` → `items.length`

These occur at:
- Line 8: `ctx.items.map((item) => item.did)` → `items.map((item) => item.did)`
- Line 9: `ctx.items.map((item) => item.uri)` → `items.map((item) => item.uri)`
- Line 61: `return ctx.items.map((item) => {` → `return items.map((item) => {`

**Step 5: Verify**

Run: `cd /Users/chadmiller/code/hatk-template-grain && npx tsc --noEmit 2>&1 | head -30`

Expected: Errors in feed files and searchGalleries.ts — fixed in Tasks 7-8.

---

### Task 7: Update grain template — feed files

**Files:**
- Modify: `/Users/chadmiller/code/hatk-template-grain/server/feeds/recent.ts`
- Modify: `/Users/chadmiller/code/hatk-template-grain/server/feeds/actor.ts`

**Step 1: Update recent.ts**

Change:
```ts
hydrate: hydrateGalleries,
```

To:
```ts
hydrate: (ctx, items) => hydrateGalleries(ctx, items),
```

Or more concisely, since the signature now matches directly:
```ts
hydrate: hydrateGalleries,
```

This still works because `hydrateGalleries` now has the signature `(ctx: BaseContext, items: Row<Gallery>[]) => Promise<GalleryView[]>`, which matches the `hydrate` field type `(ctx: BaseContext, items: Row<RecordRegistry[K]>[]) => Promise<unknown[]>`.

So **no change needed** in recent.ts — the function reference still works.

**Step 2: Same for actor.ts — no change needed**

**Step 3: Verify**

Run: `cd /Users/chadmiller/code/hatk-template-grain && npx tsc --noEmit 2>&1 | head -30`

---

### Task 8: Update grain template — searchGalleries.ts

**Files:**
- Modify: `/Users/chadmiller/code/hatk-template-grain/server/xrpc/searchGalleries.ts`

**Step 1: Replace the ugly field spreading**

Change:
```ts
const galleries = await hydrateGalleries({
  items: result.records,
  viewer: ctx.viewer,
  db: ctx.db,
  getRecords: ctx.getRecords,
  lookup: ctx.lookup,
  count: ctx.count,
  labels: ctx.labels,
  blobUrl: ctx.blobUrl,
} as any);
```

To:
```ts
const galleries = await hydrateGalleries(ctx, result.records);
```

This works because `XrpcContext extends BaseContext`, so `ctx` is directly assignable to `BaseContext`.

**Step 2: Verify**

Run: `cd /Users/chadmiller/code/hatk-template-grain && npx tsc --noEmit 2>&1 | head -30`

Expected: Clean compile.

---

### Task 9: Update teal template

**Files:**
- Modify: `/Users/chadmiller/code/hatk-template-teal/server/feeds/_hydrate.ts`

**Step 1: Install updated hatk and regenerate types**

Run:
```bash
cd /Users/chadmiller/code/hatk-template-teal && npm install && npx hatk generate
```

**Step 2: Update hydratePlays signature**

Change:
```ts
import { views, type HydrateContext, type Play, type Profile } from "$hatk";

export async function hydratePlays(ctx: HydrateContext<Play>) {
  const dids = [...new Set(ctx.items.map((item) => item.did).filter(Boolean))];
```

To:
```ts
import { views, type BaseContext, type Row, type Play, type Profile } from "$hatk";

export async function hydratePlays(ctx: BaseContext, items: Row<Play>[]) {
  const dids = [...new Set(items.map((item) => item.did).filter(Boolean))];
```

**Step 3: Replace all `ctx.items` with `items`**

- Line 6: `ctx.items.map((item) => item.did)` → `items.map((item) => item.did)`
- Line 10: `ctx.items.length` → `items.length`
- Line 27: `return ctx.items.map((item) => {` → `return items.map((item) => {`

**Step 4: Update feed files if needed**

Check `recent.ts` and other feed files. The `hydrate: (ctx) => hydratePlays(ctx)` pattern needs to change to `hydrate: (ctx, items) => hydratePlays(ctx, items)` or just `hydrate: hydratePlays`.

In teal's `recent.ts`:
```ts
// Before
hydrate: (ctx) => hydratePlays(ctx),

// After
hydrate: hydratePlays,
```

Apply the same pattern to all teal feed files that reference `hydratePlays`.

**Step 5: Verify**

Run: `cd /Users/chadmiller/code/hatk-template-teal && npx tsc --noEmit 2>&1 | head -30`

Expected: Clean compile.

---

## Summary of all changes

| File | Change |
|------|--------|
| `hydrate.ts` | `HydrateContext` → `BaseContext` (no items, add handle to viewer), `buildHydrateContext` → `buildBaseContext` (no items param) |
| `feeds.ts` | Import/export `BaseContext`, hydrate signature gets `items` param, `executeFeed` passes ctx and items separately |
| `xrpc.ts` | `XrpcContext extends BaseContext`, import BaseContext, tighten types |
| `opengraph.ts` | No changes needed (constructs XrpcContext which now extends BaseContext) |
| `cli.ts` | Codegen: `HydrateContext` → `BaseContext`, `defineFeed` overloads get `(ctx, items)` signature |
| grain `_hydrate.ts` | `(ctx: HydrateContext<Gallery>)` → `(ctx: BaseContext, items: Row<Gallery>[])`, `ctx.items` → `items` |
| grain feeds | No changes (function reference still works) |
| grain `searchGalleries.ts` | Remove 10-line field spread + `as any`, replace with `hydrateGalleries(ctx, result.records)` |
| teal `_hydrate.ts` | `(ctx: HydrateContext<Play>)` → `(ctx: BaseContext, items: Row<Play>[])`, `ctx.items` → `items` |
| teal feeds | `(ctx) => hydratePlays(ctx)` → `hydratePlays` |
