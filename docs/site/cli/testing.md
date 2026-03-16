---
title: Testing
description: Run tests and check code quality.
---

## `hatk test`

Run your project's test suite.

```bash
hatk test                    # Run all tests
hatk test --unit             # Unit tests only
hatk test --integration      # Integration tests only
hatk test --browser          # Playwright browser tests
```

| Flag            | Description                                      |
| --------------- | ------------------------------------------------ |
| `--unit`        | Run unit tests in `test/feeds/` and `test/xrpc/` |
| `--integration` | Run integration tests in `test/integration/`     |
| `--browser`     | Run Playwright browser tests in `test/browser/`  |

Without flags, all test types are run.

## Writing unit tests

Unit tests use `createTestContext()` from `hatk/test` to boot an in-memory hatk — lexicons, DuckDB, feeds, and XRPC handlers — with no HTTP server, no PDS, and no indexer.

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestContext } from 'hatk/test'

let ctx: Awaited<ReturnType<typeof createTestContext>>

beforeAll(async () => {
  ctx = await createTestContext()
  await ctx.loadFixtures()
})

afterAll(async () => ctx?.close())
```

### Test context API

| Method                       | Description                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| `ctx.loadFixtures(dir?)`     | Load YAML fixture files from `test/fixtures/` (or a custom path)     |
| `ctx.loadFeed(name)`         | Load a feed by name. Returns `{ generate(feedContext) }`             |
| `ctx.loadXrpc(name)`         | Load an XRPC handler by name. Returns `{ handler(ctx) }`             |
| `ctx.feedContext(opts?)`     | Create a feed context with `limit`, `cursor`, `viewer`, and `params` |
| `ctx.db.query(sql, params?)` | Run a SQL query against the in-memory database                       |
| `ctx.db.run(sql, ...params)` | Execute a SQL statement                                              |
| `ctx.close()`                | Shut down the database                                               |

### Testing a feed

```typescript
test('returns statuses in reverse chronological order', async () => {
  const feed = ctx.loadFeed('recent')
  const result = await feed.generate(ctx.feedContext({ limit: 10 }))
  expect(result.items).toHaveLength(6)
})

test('respects limit and cursor', async () => {
  const feed = ctx.loadFeed('recent')
  const page1 = await feed.generate(ctx.feedContext({ limit: 3 }))
  expect(page1.cursor).toBeDefined()

  const page2 = await feed.generate(ctx.feedContext({ limit: 3, cursor: page1.cursor }))
  expect(page2.items).toHaveLength(3)
})
```

### Testing an XRPC handler

```typescript
test('returns profile for known user', async () => {
  const handler = ctx.loadXrpc('xyz.statusphere.getProfile')
  const result = await handler.handler({
    params: { actor: 'did:plc:alice' },
  })
  expect(result.handle).toBe('alice.test')
})
```

## Fixtures

Fixtures are YAML files in `test/fixtures/` that populate the in-memory database before tests run. Each file is named after the table it populates.

### Account fixtures

Create a `_repos.yaml` to register test accounts with handles. This file is loaded first, before any collection fixtures:

```yaml
# test/fixtures/_repos.yaml
- did: did:plc:alice
  handle: alice.test
- did: did:plc:bob
  handle: bob.test
- did: did:plc:carol
  handle: carol.test
```

If a DID appears in a collection fixture but not in `_repos.yaml`, it is auto-registered with a default handle (`<did-suffix>.test`).

### Collection fixtures

A file named after a collection inserts records into that collection. Only `did` is required — `uri` and `cid` are auto-generated if omitted:

```yaml
# test/fixtures/xyz.statusphere.status.yaml
- did: did:plc:alice
  status: "\U0001F680"
  createdAt: $now(-5m)

- did: did:plc:bob
  status: "\U0001F9D1\u200D\U0001F4BB"
  createdAt: $now(-10m)
```

Use the `rkey` field when a record needs a specific record key (e.g., singleton records like profiles) or when other records reference it by URI:

```yaml
# test/fixtures/app.bsky.actor.profile.yaml
- did: did:plc:alice
  rkey: self
  displayName: Alice

# test/fixtures/fm.teal.alpha.feed.play.yaml
- did: did:plc:alice
  rkey: '1'
  trackName: Blinding Lights
```

Without `rkey`, URIs are generated using the record's index (`at://<did>/<collection>/0`, `at://<did>/<collection>/1`, etc.).

### Custom table fixtures

A YAML file whose name doesn't match a known collection creates a custom table with VARCHAR columns derived from the first record's keys:

```yaml
# test/fixtures/my_lookup_table.yaml
- key: foo
  value: bar
- key: baz
  value: qux
```

### The `$now` helper

Use `$now` in fixture values to generate timestamps relative to the current time:

| Expression  | Result              |
| ----------- | ------------------- |
| `$now`      | Current time        |
| `$now(-5m)` | 5 minutes ago       |
| `$now(-2h)` | 2 hours ago         |
| `$now(-1d)` | 1 day ago           |
| `$now(30s)` | 30 seconds from now |

This keeps fixtures time-relative so tests for "recent" feeds and time-based sorting always work.

## Integration tests

Integration tests use `startTestServer()` to boot a full HTTP server on a random port:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { startTestServer } from 'hatk/test'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeAll(async () => {
  server = await startTestServer()
  await server.loadFixtures()
})

afterAll(async () => server?.close())

test('GET /xrpc/dev.hatk.getFeed returns items', async () => {
  const res = await server.fetch('/xrpc/dev.hatk.getFeed?feed=recent&limit=5')
  const data = await res.json()
  expect(data.items.length).toBeGreaterThan(0)
})
```

### Test server API

The test server extends the test context with:

| Method                             | Description                                                  |
| ---------------------------------- | ------------------------------------------------------------ |
| `server.url`                       | The base URL (e.g., `http://127.0.0.1:54321`)                |
| `server.fetch(path, init?)`        | Fetch a path on the test server                              |
| `server.fetchAs(did, path, init?)` | Fetch as an authenticated user (sets `x-test-viewer` header) |
| `server.seed(opts?)`               | Get seed helpers for creating records against a real PDS     |
