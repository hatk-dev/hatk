# hatk privateCollections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a hatk app declare collections that are indexed and queryable in-process but never served by the built-in `dev.hatk.*` record endpoints.

**Architecture:** hatk currently conflates "is this collection indexed" with "should it be served publicly" — both are answered by `getSchema(collection)` returning a schema, so adding a lexicon publishes it. This adds a `privateCollections` config field held in a small module-level registry (mirroring how the schema registry already works), and a guard applied as the *first* check in each generic record endpoint, before any schema or database lookup.

**Tech Stack:** TypeScript (ESM, `.ts` extension imports), Node, vitest (introduced by this plan), oxlint + oxfmt.

## Global Constraints

- Package is ESM: `"type": "module"`. Relative imports carry the `.ts` extension (`from './server.ts'`).
- Formatting is oxfmt: 2-space indent, single quotes, no semicolons. Run `npm run format` before committing.
- `npm run check` (`tsc --noEmit && oxlint . && oxfmt --check .`) must pass at every commit.
- The guard must **fail closed**: run before `getSchema`, before any DB access, and return 404 (never 403 — a 403 confirms the collection exists).
- No breaking changes. `privateCollections` defaults to `[]`, so existing apps behave exactly as before.
- Work happens in `~/code/hatk`, in the `packages/hatk` workspace.

---

### Task 1: Test infrastructure

hatk has no test runner. This adds one so the rest of the plan can be test-driven.

**Files:**
- Modify: `packages/hatk/package.json`
- Modify: `package.json` (repo root)
- Create: `packages/hatk/vitest.config.ts`
- Create: `packages/hatk/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` at the repo root runs vitest against `packages/hatk/test/**/*.test.ts`

- [ ] **Step 1: Add vitest as a devDependency**

```bash
cd ~/code/hatk && npm install -D -w @hatk/hatk vitest@^3
```

- [ ] **Step 2: Create the vitest config**

Create `packages/hatk/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: Add test scripts**

In `packages/hatk/package.json`, add to `"scripts"`:

```json
    "test": "vitest run"
```

In the repo root `package.json`, add to `"scripts"`:

```json
    "test": "npm run test -w @hatk/hatk"
```

- [ ] **Step 4: Write a smoke test**

Create `packages/hatk/test/smoke.test.ts`:

```ts
import { expect, test } from 'vitest'

test('vitest runs', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 5: Run the test suite**

Run: `cd ~/code/hatk && npm test`
Expected: PASS, 1 test.

- [ ] **Step 6: Verify checks still pass**

Run: `cd ~/code/hatk && npm run check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/code/hatk
git add package.json package-lock.json packages/hatk/package.json packages/hatk/vitest.config.ts packages/hatk/test/smoke.test.ts
git commit -m "chore: add vitest test infrastructure"
```

---

### Task 2: The guard module

A pure module holding the private-collection set and the AT-URI collection parser. Pure so it can be tested without a database or server.

**Files:**
- Create: `packages/hatk/src/private-collections.ts`
- Create: `packages/hatk/test/private-collections.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `setPrivateCollections(list: string[]): void`
  - `isPrivateCollection(nsid: string | null | undefined): boolean`
  - `collectionFromUri(uri: string): string | undefined`

- [ ] **Step 1: Write the failing test**

Create `packages/hatk/test/private-collections.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { collectionFromUri, isPrivateCollection, setPrivateCollections } from '../src/private-collections.ts'

beforeEach(() => {
  setPrivateCollections([])
})

test('no collections are private by default', () => {
  expect(isPrivateCollection('social.switchback.activity')).toBe(false)
})

test('listed collections are private', () => {
  setPrivateCollections(['social.switchback.activity'])
  expect(isPrivateCollection('social.switchback.activity')).toBe(true)
  expect(isPrivateCollection('app.bsky.actor.profile')).toBe(false)
})

test('setPrivateCollections replaces rather than accumulates', () => {
  setPrivateCollections(['a.b.c'])
  setPrivateCollections(['d.e.f'])
  expect(isPrivateCollection('a.b.c')).toBe(false)
  expect(isPrivateCollection('d.e.f')).toBe(true)
})

test('a missing collection is not private', () => {
  setPrivateCollections(['a.b.c'])
  expect(isPrivateCollection(null)).toBe(false)
  expect(isPrivateCollection(undefined)).toBe(false)
})

test('collectionFromUri extracts the collection segment', () => {
  expect(collectionFromUri('at://did:plc:abc/social.switchback.activity/3kx')).toBe(
    'social.switchback.activity',
  )
})

test('collectionFromUri returns undefined for a malformed uri', () => {
  expect(collectionFromUri('not-a-uri')).toBeUndefined()
  expect(collectionFromUri('at://did:plc:abc')).toBeUndefined()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/code/hatk && npm test`
Expected: FAIL — cannot resolve `../src/private-collections.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/hatk/src/private-collections.ts`:

```ts
/**
 * Collections that are indexed and queryable in-process but must never be
 * served by the built-in dev.hatk.* record endpoints.
 *
 * Held module-level, mirroring the schema registry, so the guard can be applied
 * inside handlers without threading config through every signature.
 */
let privateCollections = new Set<string>()

export function setPrivateCollections(list: string[]): void {
  privateCollections = new Set(list)
}

export function isPrivateCollection(nsid: string | null | undefined): boolean {
  return nsid != null && privateCollections.has(nsid)
}

/**
 * The collection segment of an AT-URI: at://{did}/{collection}/{rkey}.
 * Splitting yields ['at:', '', did, collection, rkey].
 */
export function collectionFromUri(uri: string): string | undefined {
  const parts = uri.split('/')
  return parts.length > 3 ? parts[3] : undefined
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/code/hatk && npm test`
Expected: PASS, 7 tests.

- [ ] **Step 5: Format and check**

Run: `cd ~/code/hatk && npm run format && npm run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/code/hatk
git add packages/hatk/src/private-collections.ts packages/hatk/test/private-collections.test.ts
git commit -m "feat: add private collection registry and at-uri collection parser"
```

---

### Task 3: The config field

**Files:**
- Modify: `packages/hatk/src/config.ts:59-74` (the `HatkConfig` interface) and `:117-140` (the config literal)
- Create: `packages/hatk/test/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `HatkConfig.privateCollections: string[]`, defaulting to `[]`

- [ ] **Step 1: Write the failing test**

Create `packages/hatk/test/config.test.ts`:

```ts
import { expect, test } from 'vitest'
import type { HatkConfig } from '../src/config.ts'

test('privateCollections is part of HatkConfig and accepts a list', () => {
  const partial: Pick<HatkConfig, 'privateCollections'> = {
    privateCollections: ['social.switchback.activity'],
  }
  expect(partial.privateCollections).toEqual(['social.switchback.activity'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/code/hatk && npm test`
Expected: FAIL — `'privateCollections' does not exist in type 'HatkConfig'`.

Note: vitest does not type-check by default, so if this passes at runtime, confirm the failure with `npm run typecheck` instead — that is the assertion that matters here.

- [ ] **Step 3: Add the field to the interface**

In `packages/hatk/src/config.ts`, in the `HatkConfig` interface, immediately after the `collections` line:

```ts
  collections: string[] // optional — auto-derived from lexicons if empty
  privateCollections: string[] // never served by the built-in dev.hatk.* record endpoints
```

- [ ] **Step 4: Add the default to the config literal**

In the same file, in the `const config: HatkConfig = {` literal, immediately after the `collections:` line:

```ts
    collections: parsed.collections || [],
    privateCollections: parsed.privateCollections || [],
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd ~/code/hatk && npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Format, check, commit**

```bash
cd ~/code/hatk
npm run format && npm run check
git add packages/hatk/src/config.ts packages/hatk/test/config.test.ts
git commit -m "feat: add privateCollections config field"
```

---

### Task 4: Guard the HTTP record endpoints

The three generic record branches in `createHandler`. The guard goes **first** in each branch, before `getSchema` and before any DB call, so a private collection is rejected without touching storage.

**Files:**
- Modify: `packages/hatk/src/server.ts` — `getRecords` branch (~line 347), `getRecord` branch (~line 378), `searchRecords` branch (~line 410)
- Create: `packages/hatk/test/private-endpoints.test.ts`

**Interfaces:**
- Consumes: `isPrivateCollection`, `collectionFromUri` from Task 2; `createHandler(config: HandlerConfig)` from `packages/hatk/src/server.ts:298`
- Produces: 404 responses for private collections on all three endpoints

- [ ] **Step 1: Write the failing test**

`createHandler` needs no database for these assertions, because the guard returns before any lookup. `oauth: null` skips viewer resolution.

Create `packages/hatk/test/private-endpoints.test.ts`:

```ts
import { beforeEach, expect, test } from 'vitest'
import { createHandler } from '../src/server.ts'
import { setPrivateCollections } from '../src/private-collections.ts'

const PRIVATE = 'social.switchback.activity'

function handler() {
  return createHandler({
    collections: [PRIVATE, 'app.bsky.actor.profile'],
    publicDir: null,
    oauth: null,
    admins: [],
  })
}

beforeEach(() => {
  setPrivateCollections([PRIVATE])
})

test('getRecords 404s for a private collection', async () => {
  const res = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${PRIVATE}`),
  )
  expect(res.status).toBe(404)
})

test('searchRecords 404s for a private collection', async () => {
  const res = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.searchRecords?collection=${PRIVATE}&q=run`),
  )
  expect(res.status).toBe(404)
})

test('getRecord 404s for a uri in a private collection', async () => {
  const res = await handler()(
    new Request(
      `http://localhost/xrpc/dev.hatk.getRecord?uri=at://did:plc:abc/${PRIVATE}/3kx`,
    ),
  )
  expect(res.status).toBe(404)
})

test('the guard does not 403, which would confirm the collection exists', async () => {
  const res = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${PRIVATE}`),
  )
  expect(res.status).not.toBe(403)
})

test('a collection that is not private is not blocked by the guard', async () => {
  const res = await handler()(
    new Request('http://localhost/xrpc/dev.hatk.getRecords?collection=app.bsky.actor.profile'),
  )
  // No schema is registered in this test, so the endpoint 404s for a different
  // reason. What matters is that the guard is not what rejected it: the body
  // carries the unknown-collection message rather than a bare not-found.
  expect(await res.text()).toContain('Unknown collection')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/code/hatk && npm test`
Expected: FAIL — the private-collection requests return an "Unknown collection" 404 or reach the DB, and the last test's assertion ordering is not yet meaningful.

- [ ] **Step 3: Import the guard in server.ts**

At the top of `packages/hatk/src/server.ts`, alongside the existing imports:

```ts
import { collectionFromUri, isPrivateCollection } from './private-collections.ts'
```

- [ ] **Step 4: Guard the getRecords branch**

In the `if (url.pathname === coreXrpc('getRecords')) {` branch, insert immediately after the `collection` is read and its missing-parameter check, before the `getSchema` check:

```ts
        const collection = url.searchParams.get('collection')
        if (!collection) return withCors(jsonError(400, 'Missing collection parameter', acceptEncoding))
        if (isPrivateCollection(collection))
          return withCors(jsonError(404, `Unknown collection: ${collection}`, acceptEncoding))
        if (!getSchema(collection)) return withCors(jsonError(404, `Unknown collection: ${collection}`, acceptEncoding))
```

- [ ] **Step 5: Guard the searchRecords branch**

In the `if (url.pathname === coreXrpc('searchRecords')) {` branch, apply the same insertion — after the missing-parameter checks for `collection` and `q`, before `getSchema`:

```ts
        if (isPrivateCollection(collection))
          return withCors(jsonError(404, `Unknown collection: ${collection}`, acceptEncoding))
```

- [ ] **Step 6: Guard the getRecord branch**

This branch has no `collection` parameter — it is parsed from the URI. Insert immediately after the missing-`uri` check, before `getRecordByUri`:

```ts
      if (url.pathname === coreXrpc('getRecord')) {
        const uri = url.searchParams.get('uri')
        if (!uri) return withCors(jsonError(400, 'Missing uri parameter', acceptEncoding))
        if (isPrivateCollection(collectionFromUri(uri)))
          return withCors(jsonError(404, 'Record not found', acceptEncoding))

        const record = await getRecordByUri(uri)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ~/code/hatk && npm test`
Expected: PASS, all 5 tests in this file.

- [ ] **Step 8: Format, check, commit**

```bash
cd ~/code/hatk
npm run format && npm run check
git add packages/hatk/src/server.ts packages/hatk/test/private-endpoints.test.ts
git commit -m "feat: block private collections from generic HTTP record endpoints"
```

---

### Task 5: Guard the in-process handler registry

`registerCoreHandlers` registers the same three endpoints for `callXrpc()` in SSR and server code. These are a separate code path from Task 4 and need the same guard, or SSR bypasses it.

**Files:**
- Modify: `packages/hatk/src/server.ts` — `registerCoreHandlers` at `:90`, the `getRecords` handler at `:91`, `getRecord` at `:116`, `searchRecords` at `:135`
- Modify: `packages/hatk/test/private-endpoints.test.ts`

**Interfaces:**
- Consumes: `isPrivateCollection`, `collectionFromUri` from Task 2 (already imported by Task 4)
- Produces: `NotFoundError` thrown from the three registry handlers for private collections

- [ ] **Step 1: Write the failing test**

Append to `packages/hatk/test/private-endpoints.test.ts`:

```ts
import { registerCoreHandlers } from '../src/server.ts'
import { callCoreXrpcHandler } from '../src/xrpc.ts'

test('the in-process getRecords handler rejects a private collection', async () => {
  registerCoreHandlers([PRIVATE], null)
  await expect(
    callCoreXrpcHandler('dev.hatk.getRecords', { collection: PRIVATE }),
  ).rejects.toThrow(/Unknown collection/)
})

test('the in-process getRecord handler rejects a private uri', async () => {
  registerCoreHandlers([PRIVATE], null)
  await expect(
    callCoreXrpcHandler('dev.hatk.getRecord', { uri: `at://did:plc:abc/${PRIVATE}/3kx` }),
  ).rejects.toThrow(/not found/i)
})
```

Before running, confirm the exported name for invoking a registered core handler:

```bash
cd ~/code/hatk && grep -n "export function callCoreXrpcHandler\|export async function callCoreXrpcHandler\|registerCoreXrpcHandler" packages/hatk/src/xrpc.ts
```

If the invoker is exported under a different name, use that name in the test and in this task's steps.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/code/hatk && npm test`
Expected: FAIL — the handlers resolve or throw a different error.

- [ ] **Step 3: Guard the registry getRecords handler**

In `registerCoreHandlers`, in the `dev.hatk.getRecords` handler, after the missing-collection check and before `getSchema`:

```ts
    if (!collection) throw new InvalidRequestError('Missing collection parameter')
    if (isPrivateCollection(collection)) throw new NotFoundError(`Unknown collection: ${collection}`)
    if (!getSchema(collection)) throw new NotFoundError(`Unknown collection: ${collection}`)
```

- [ ] **Step 4: Guard the registry searchRecords handler**

In the `dev.hatk.searchRecords` handler, after the missing-parameter checks and before `getSchema`:

```ts
    if (isPrivateCollection(collection)) throw new NotFoundError(`Unknown collection: ${collection}`)
```

- [ ] **Step 5: Guard the registry getRecord handler**

In the `dev.hatk.getRecord` handler, after the missing-`uri` check and before `getRecordByUri`:

```ts
    if (!uri) throw new InvalidRequestError('Missing uri parameter')
    if (isPrivateCollection(collectionFromUri(uri))) throw new NotFoundError('Record not found')
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/code/hatk && npm test`
Expected: PASS.

- [ ] **Step 7: Format, check, commit**

```bash
cd ~/code/hatk
npm run format && npm run check
git add packages/hatk/src/server.ts packages/hatk/test/private-endpoints.test.ts
git commit -m "feat: block private collections from in-process record handlers"
```

---

### Task 6: Omit private collections from describeCollections

`describeCollections` publishes each collection's schema, including column names. Listing a private collection advertises its shape even if its rows are unreachable.

**Files:**
- Modify: `packages/hatk/src/server.ts` — registry handler at `:153`, HTTP branch at `:434`
- Modify: `packages/hatk/test/private-endpoints.test.ts`

**Interfaces:**
- Consumes: `isPrivateCollection` from Task 2
- Produces: `describeCollections` output excluding private collections

- [ ] **Step 1: Write the failing test**

Append to `packages/hatk/test/private-endpoints.test.ts`:

```ts
test('describeCollections omits private collections', async () => {
  const res = await handler()(new Request('http://localhost/xrpc/dev.hatk.describeCollections'))
  const body = (await res.json()) as { collections: { collection: string }[] }
  const names = body.collections.map((c) => c.collection)
  expect(names).not.toContain(PRIVATE)
  expect(names).toContain('app.bsky.actor.profile')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/code/hatk && npm test`
Expected: FAIL — `names` contains the private collection.

- [ ] **Step 3: Filter the HTTP branch**

In the `if (url.pathname === coreXrpc('describeCollections')) {` branch, filter before mapping:

```ts
        const collectionInfo = collections
          .filter((c) => !isPrivateCollection(c))
          .map((c) => {
            const schema = getSchema(c)
            return {
              collection: c,
              columns: schema?.columns.map((col) => ({
                name: col.name,
                originalName: col.originalName,
                type: col.sqlType,
                required: col.notNull,
              })),
            }
          })
```

- [ ] **Step 4: Filter the registry handler**

Apply the same `.filter((c) => !isPrivateCollection(c))` before `.map(` in the `dev.hatk.describeCollections` handler registered in `registerCoreHandlers`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/code/hatk && npm test`
Expected: PASS.

- [ ] **Step 6: Format, check, commit**

```bash
cd ~/code/hatk
npm run format && npm run check
git add packages/hatk/src/server.ts packages/hatk/test/private-endpoints.test.ts
git commit -m "feat: omit private collections from describeCollections"
```

---

### Task 7: Wire config into the registry at startup

Nothing has called `setPrivateCollections` yet, so the guard is inert in a real app. This connects config to the registry in all three entry points, including the test harness — without which apps cannot test their own private collections.

**Files:**
- Modify: `packages/hatk/src/main.ts:119` (near `registerCoreHandlers(collections, config.oauth)`)
- Modify: `packages/hatk/src/dev-entry.ts:77` (same call)
- Modify: `packages/hatk/src/test.ts` — inside `startTestServer`, before `startServer(...)` at `:285`
- Modify: `packages/hatk/test/private-endpoints.test.ts`

**Interfaces:**
- Consumes: `setPrivateCollections` from Task 2; `HatkConfig.privateCollections` from Task 3
- Produces: the guard active in `hatk start`, `vp dev`, and `startTestServer()`

- [ ] **Step 1: Write the failing test**

Append to `packages/hatk/test/private-endpoints.test.ts`:

```ts
test('setPrivateCollections drives the guard, so an empty list serves normally', async () => {
  setPrivateCollections([])
  const res = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${PRIVATE}`),
  )
  // Not blocked by the guard: rejected as an unregistered schema instead.
  expect(await res.text()).toContain('Unknown collection')
})
```

- [ ] **Step 2: Run the test to verify it passes already**

Run: `cd ~/code/hatk && npm test`
Expected: PASS. This test pins the registry's behaviour so the wiring below cannot regress it; it is a guard against Task 7 hardcoding the set.

- [ ] **Step 3: Wire main.ts**

In `packages/hatk/src/main.ts`, add the import alongside the existing `./server.ts` import:

```ts
import { setPrivateCollections } from './private-collections.ts'
```

and immediately before `registerCoreHandlers(collections, config.oauth)`:

```ts
setPrivateCollections(config.privateCollections)
```

- [ ] **Step 4: Wire dev-entry.ts**

In `packages/hatk/src/dev-entry.ts`, add the same import, and immediately before `registerCoreHandlers(collections, config.oauth)`:

```ts
setPrivateCollections(config.privateCollections)
```

- [ ] **Step 5: Wire the test harness**

In `packages/hatk/src/test.ts`, add the same import, and inside `startTestServer`, immediately before the `const httpServer = startServer(` call:

```ts
  setPrivateCollections(ctx._config.privateCollections)
```

- [ ] **Step 6: Run tests and checks**

Run: `cd ~/code/hatk && npm test && npm run check`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/code/hatk
git add packages/hatk/src/main.ts packages/hatk/src/dev-entry.ts packages/hatk/src/test.ts packages/hatk/test/private-endpoints.test.ts
git commit -m "feat: apply privateCollections config at startup and in the test harness"
```

---

### Task 8: Document and release

**Files:**
- Modify: `docs/` — the configuration reference page (locate with the command in Step 1)
- Modify: `packages/hatk/package.json` (version)

**Interfaces:**
- Consumes: everything above
- Produces: a published `@hatk/hatk` alpha that switchback can depend on

- [ ] **Step 1: Find the config documentation page**

Run: `cd ~/code/hatk && grep -rln "collections" docs/ | head`

Open the configuration reference page from the results.

- [ ] **Step 2: Document the field**

Add an entry for `privateCollections` next to `collections`:

```markdown
### `privateCollections`

`string[]` — defaults to `[]`.

Collections listed here are indexed, typed, and queryable from your own feeds
and XRPC handlers, but are never served by the built-in `dev.hatk.*` record
endpoints. `getRecords`, `getRecord`, and `searchRecords` return 404 for them,
and `describeCollections` omits them.

Use this for any collection holding data that is not public. Authorization for
your own handlers remains yours to enforce — this only ensures hatk does not
serve the collection on your behalf.

```ts
export default defineConfig({
  privateCollections: ['social.switchback.activity'],
})
```
```

- [ ] **Step 3: Bump the version**

In `packages/hatk/package.json`, increment the alpha: `0.0.1-alpha.63` → `0.0.1-alpha.64`.

- [ ] **Step 4: Verify the build**

Run: `cd ~/code/hatk && npm run build && npm test && npm run check`
Expected: build succeeds, tests pass, no check errors.

- [ ] **Step 5: Commit**

```bash
cd ~/code/hatk
git add docs packages/hatk/package.json
git commit -m "docs: document privateCollections and bump to alpha.64"
```

- [ ] **Step 6: Publish**

```bash
cd ~/code/hatk && npm run release
```

Expected: `@hatk/hatk@0.0.1-alpha.64` published with the `alpha` tag.

---

## Verification

After all tasks, confirm the whole feature from a consumer's perspective:

- [ ] `cd ~/code/hatk && npm test` — all tests pass
- [ ] `cd ~/code/hatk && npm run check` — clean
- [ ] An app with `privateCollections: ['x.y.z']` gets 404 from
      `/xrpc/dev.hatk.getRecords?collection=x.y.z` and no `x.y.z` entry in
      `/xrpc/dev.hatk.describeCollections`
- [ ] An app with `privateCollections: []` behaves exactly as before this change
