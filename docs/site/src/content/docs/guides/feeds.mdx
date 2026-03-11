---
title: Feeds
description: Define custom feeds with generate and hydrate phases.
---

Create feeds in the `feeds/` directory using `defineFeed()`:

```bash
hatk generate feed recent
```

Each feed has two phases: **generate** (query for record URIs) and **hydrate** (enrich results with additional data).

## `defineFeed` options

| Field        | Required                        | Description                                  |
| ------------ | ------------------------------- | -------------------------------------------- |
| `collection` | Yes (unless `hydrate` provided) | The collection this feed queries             |
| `label`      | Yes                             | Human-readable name shown in `describeFeeds` |
| `view`       | No                              | View definition to use for auto-hydration    |
| `generate`   | Yes                             | Function that returns record URIs            |
| `hydrate`    | No                              | Function that enriches resolved records      |

---

## `generate`

Queries DuckDB and returns record URIs with optional cursor-based pagination.

### Context

| Field                 | Type                      | Description                                                           |
| --------------------- | ------------------------- | --------------------------------------------------------------------- |
| `db.query`            | function                  | Run SQL queries against DuckDB                                        |
| `params`              | `Record<string, string>`  | Query string parameters from the request                              |
| `limit`               | number                    | Requested page size                                                   |
| `cursor`              | string \| undefined       | Pagination cursor from the client                                     |
| `viewer`              | `{ did: string }` \| null | The authenticated user, or null                                       |
| `ok`                  | function                  | Wraps your return value with type checking                            |
| `packCursor`          | function                  | Encode a `(primary, cid)` pair into an opaque cursor string           |
| `unpackCursor`        | function                  | Decode a cursor back into `{ primary, cid }` or null                  |
| `isTakendown`         | function                  | Check if a DID has been taken down                                    |
| `filterTakendownDids` | function                  | Filter a list of DIDs, returning those that are taken down            |
| `paginate`            | function                  | Run a paginated query — handles cursor, ORDER BY, LIMIT automatically |

### Cursor pagination

`packCursor` and `unpackCursor` implement a standard two-field cursor pattern. Encode a sort value (like `indexed_at`) and the record's `cid` as a tiebreaker:

```typescript
// Encode: packCursor(indexed_at, cid) → "MjAyNS0wMS..."
const cursor = packCursor(last.indexed_at, last.cid)

// Decode: unpackCursor("MjAyNS0wMS...") → { primary: "2025-01-01T...", cid: "bafyrei..." }
const parsed = unpackCursor(cursor)
```

### Example

```typescript
import { defineFeed } from '../hatk.generated.ts'

export default defineFeed({
  collection: 'fm.teal.alpha.feed.play',
  label: 'Recent',

  async generate(ctx) {
    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      `SELECT uri, cid, indexed_at FROM "fm.teal.alpha.feed.play"`,
    )

    return ctx.ok({ uris: rows.map((r) => r.uri), cursor })
  },
})
```

`paginate` handles cursor unpacking, WHERE/AND injection, ORDER BY, LIMIT, hasMore detection, and cursor packing. Pass options for custom sort columns or user params:

```typescript
const { rows, cursor } = await ctx.paginate<{ uri: string }>(
  `SELECT p.uri, p.cid, p.played_time
   FROM "fm.teal.alpha.feed.play__artists" a
   JOIN "fm.teal.alpha.feed.play" p ON p.uri = a.parent_uri
   WHERE a.artist_name = $1`,
  { params: [artist], orderBy: 'p.played_time' },
)
```

---

## `hydrate` (optional)

Enriches feed results with additional data after the `generate` phase returns URIs. The framework resolves the URIs into full records, then passes them to your `hydrate` function.

### Context

| Field        | Type                      | Description                                                     |
| ------------ | ------------------------- | --------------------------------------------------------------- |
| `items`      | `Row[]`                   | The resolved records (each has `uri`, `did`, `handle`, `value`) |
| `viewer`     | `{ did: string }` \| null | The authenticated user, or null                                 |
| `db.query`   | function                  | Run SQL queries against DuckDB                                  |
| `getRecords` | function                  | Fetch records by URI from another collection                    |
| `lookup`     | function                  | Look up records by a field value (e.g. profiles by DID)         |
| `count`      | function                  | Count records by field value                                    |
| `labels`     | function                  | Query labels for a list of URIs                                 |
| `blobUrl`    | function                  | Resolve a blob reference to a CDN URL                           |

### Example

```typescript
import { defineFeed } from '../hatk.generated.ts'

export default defineFeed({
  collection: 'fm.teal.alpha.feed.play',
  label: 'Recent',

  async generate(ctx) {
    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      `SELECT uri, cid, indexed_at FROM "fm.teal.alpha.feed.play"`,
    )
    return ctx.ok({ uris: rows.map((r) => r.uri), cursor })
  },

  async hydrate(ctx) {
    // Look up author profiles for all items in one batch
    const dids = [...new Set(ctx.items.map((item) => item.did))]
    const profiles = await ctx.lookup('app.bsky.actor.profile', 'did', dids)

    return ctx.items.map((item) => {
      const author = profiles.get(item.did)
      return {
        uri: item.uri,
        did: item.did,
        ...item.value,
        author: author
          ? {
              did: author.did,
              handle: author.handle,
              displayName: author.value.displayName,
              avatar: ctx.blobUrl(author.did, author.value.avatar),
            }
          : undefined,
      }
    })
  },
})
```
