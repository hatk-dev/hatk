---
title: Feeds
description: Define custom feeds that turn your indexed data into timelines.
---

# Feeds

Feeds are custom timelines powered by your indexed data. Each feed queries your SQLite database to produce a list of record URIs, and optionally enriches those results with author profiles and other metadata before returning them to the client.

## Defining a feed

Create a feed file in your `server/` directory using `defineFeed()`:

```typescript
// server/recent.ts
import { defineFeed } from "$hatk";

export default defineFeed({
  collection: "xyz.statusphere.status",
  label: "Recent",

  async generate(ctx) {
    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      `SELECT uri, cid, indexed_at, created_at FROM "xyz.statusphere.status"`,
      { orderBy: "created_at", order: "DESC" },
    );

    return ctx.ok({ uris: rows.map((r) => r.uri), cursor });
  },
});
```

This feed queries every status record, sorted newest-first, with automatic cursor-based pagination. The framework resolves the returned URIs into full records before sending them to the client.

## `defineFeed` options

| Field        | Required                        | Description                                  |
| ------------ | ------------------------------- | -------------------------------------------- |
| `collection` | Yes (unless `hydrate` provided) | The collection this feed queries             |
| `label`      | Yes                             | Human-readable name shown in `describeFeeds` |
| `generate`   | Yes                             | Function that returns record URIs            |
| `hydrate`    | No                              | Function that enriches resolved records      |

## The `generate` function

`generate` receives a context object and returns a list of AT URIs plus an optional cursor for pagination.

### Context reference

| Field                 | Type                      | Description                                                         |
| --------------------- | ------------------------- | ------------------------------------------------------------------- |
| `db.query`            | function                  | Run SQL queries against your SQLite database                        |
| `params`              | `Record<string, string>`  | Query string parameters from the request                            |
| `limit`               | number                    | Requested page size                                                 |
| `cursor`              | string \| undefined       | Pagination cursor from the client                                   |
| `viewer`              | `{ did: string }` \| null | The authenticated user, or null                                     |
| `ok`                  | function                  | Wraps your return value with type checking                          |
| `paginate`            | function                  | Run a paginated query (handles cursor, ORDER BY, LIMIT)             |
| `packCursor`          | function                  | Encode a `(primary, cid)` pair into an opaque cursor string         |
| `unpackCursor`        | function                  | Decode a cursor back into `{ primary, cid }` or null                |
| `isTakendown`         | function                  | Check if a DID has been taken down                                  |
| `filterTakendownDids` | function                  | Filter a list of DIDs, returning those that are taken down          |

## Pagination with `ctx.paginate()`

`paginate` is the recommended way to handle cursor-based pagination. It takes a SQL query and handles cursor unpacking, `WHERE`/`AND` clause injection, `ORDER BY`, `LIMIT`, `hasMore` detection, and cursor packing automatically.

### Basic usage

```typescript
const { rows, cursor } = await ctx.paginate<{ uri: string }>(
  `SELECT uri, cid, indexed_at FROM "xyz.statusphere.status"`,
);
```

### With parameters and custom sort

Pass SQL parameters and specify which column to sort by:

```typescript
const { rows, cursor } = await ctx.paginate<{ uri: string }>(
  `SELECT p.uri, p.cid, p.played_time
   FROM "fm.teal.alpha.feed.play__artists" a
   JOIN "fm.teal.alpha.feed.play" p ON p.uri = a.parent_uri
   WHERE a.artist_name = $1`,
  { params: [artist], orderBy: "p.played_time" },
);
```

`paginate` appends cursor conditions, `ORDER BY`, and `LIMIT` to your query. You provide the base `SELECT` and any `WHERE` clauses for filtering; `paginate` adds the rest.

### Using the viewer

Feeds can use `ctx.viewer` to personalize results. For example, a "following" feed that shows records from accounts the viewer follows:

```typescript
import { defineFeed } from "$hatk";

export default defineFeed({
  collection: "fm.teal.alpha.feed.play",
  label: "Following",

  async generate(ctx) {
    const actorDid = ctx.params.actor || ctx.viewer?.did;
    if (!actorDid) {
      return ctx.ok({ uris: [], cursor: undefined });
    }

    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      `SELECT p.uri, p.cid, p.played_time
       FROM "fm.teal.alpha.feed.play" p
       INNER JOIN "app.bsky.graph.follow" f ON f.subject = p.did
       WHERE f.did = $1`,
      { params: [actorDid], orderBy: "p.played_time" },
    );

    return ctx.ok({ uris: rows.map((r) => r.uri), cursor });
  },
});
```

### Manual cursors

If you need more control than `paginate` provides, use `packCursor` and `unpackCursor` directly. They implement a two-field cursor pattern using a sort value (like `indexed_at`) and the record's `cid` as a tiebreaker:

```typescript
// Encode: packCursor(indexed_at, cid) → "MjAyNS0wMS..."
const cursor = packCursor(last.indexed_at, last.cid);

// Decode: unpackCursor("MjAyNS0wMS...") → { primary: "2025-01-01T...", cid: "bafyrei..." }
const parsed = unpackCursor(cursor);
```

## Hydration

The optional `hydrate` function enriches feed results with additional data. After `generate` returns URIs, the framework resolves them into full records, then passes those records to `hydrate`.

### Hydrate context reference

| Field        | Type                      | Description                                                     |
| ------------ | ------------------------- | --------------------------------------------------------------- |
| `items`      | `Row[]`                   | The resolved records (each has `uri`, `did`, `handle`, `value`) |
| `viewer`     | `{ did: string }` \| null | The authenticated user, or null                                 |
| `db.query`   | function                  | Run SQL queries against your SQLite database                    |
| `getRecords` | function                  | Fetch records by URI from another collection                    |
| `lookup`     | function                  | Look up records by a field value (e.g. profiles by DID)         |
| `count`      | function                  | Count records by field value                                    |
| `labels`     | function                  | Query labels for a list of URIs                                 |
| `blobUrl`    | function                  | Resolve a blob reference to a CDN URL                           |

### Example with hydration

This feed queries status records and hydrates each one with the author's profile:

```typescript
import { defineFeed, views, type Status, type Profile, type HydrateContext } from "$hatk";

export default defineFeed({
  collection: "xyz.statusphere.status",
  label: "Recent",

  hydrate: (ctx) => hydrateStatuses(ctx),

  async generate(ctx) {
    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      `SELECT uri, cid, indexed_at, created_at FROM "xyz.statusphere.status"`,
      { orderBy: "created_at", order: "DESC" },
    );

    return ctx.ok({ uris: rows.map((r) => r.uri), cursor });
  },
});

async function hydrateStatuses(ctx: HydrateContext<Status>) {
  const dids = [...new Set(ctx.items.map((item) => item.did).filter(Boolean))];
  const profiles = await ctx.lookup<Profile>("app.bsky.actor.profile", "did", dids);

  return ctx.items.map((item) => {
    const author = profiles.get(item.did);
    return views.statusView({
      uri: item.uri,
      status: item.value.status,
      createdAt: item.value.createdAt,
      indexedAt: item.indexed_at,
      author: views.profileView({
        did: item.did,
        handle: item.handle || item.did,
        displayName: author?.value.displayName,
        avatar: author ? ctx.blobUrl(author.did, author.value.avatar, "avatar") : undefined,
      }),
    });
  });
}
```

Key patterns:

- **Batch lookups** — `ctx.lookup()` fetches records for multiple DIDs in one call. Collect unique DIDs first to avoid duplicate queries.
- **`ctx.blobUrl()`** — converts a blob reference (like an avatar) into a CDN URL the client can load.
- **View builders** — `views.statusView()` and `views.profileView()` are generated from your lexicon's view definitions, providing type-safe construction.

### Hydration with viewer context

Hydration can also use `ctx.viewer` to add viewer-specific data like bookmarks:

```typescript
async function hydratePlays(ctx: HydrateContext<Play>) {
  const dids = [...new Set(ctx.items.map((item) => item.did).filter(Boolean))];
  const profiles = await ctx.lookup<Profile>("app.bsky.actor.profile", "did", dids);

  // Load viewer's bookmarks
  const bookmarks = new Map<string, string>();
  if (ctx.viewer?.did && ctx.items.length > 0) {
    const rows = await ctx.db.query(
      `SELECT subject, uri FROM "community.lexicon.bookmarks.bookmark" WHERE did = $1`,
      [ctx.viewer.did],
    );
    for (const row of rows as { subject: string; uri: string }[]) {
      bookmarks.set(row.subject, row.uri);
    }
  }

  return ctx.items.map((item) => {
    const author = profiles.get(item.did);
    return views.playView({
      record: { uri: item.uri, did: item.did, handle: item.handle, ...item.value },
      author: author
        ? {
            did: author.did,
            handle: author.handle,
            displayName: author.value.displayName,
            avatar: ctx.blobUrl(author.did, author.value.avatar),
          }
        : undefined,
      viewerBookmark: bookmarks.get(item.uri),
    });
  });
}
```

## Generating a feed

Use the CLI to scaffold a new feed file:

```bash
hatk generate feed recent
```

This creates the file with the right imports and structure.
