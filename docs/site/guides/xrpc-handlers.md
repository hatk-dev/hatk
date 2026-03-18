---
title: XRPC Handlers
description: Define typed API endpoints — queries for GET, procedures for POST.
---

# XRPC Handlers

XRPC handlers are typed API endpoints that extend your hatk server's API. They come in two kinds: **queries** (read-only GET requests) and **procedures** (POST requests that can modify data). Each handler maps to a lexicon that defines its parameter types, input/output schemas, and error cases.

## Defining a query

Use `defineQuery()` for read-only GET endpoints. The handler receives a typed context object and returns a response via `ctx.ok()`:

```typescript
// server/xrpc/getPlay.ts
import { defineQuery, NotFoundError, views, type Play, type Profile } from "$hatk";

export default defineQuery("xyz.appview.unspecced.getPlay", async (ctx) => {
  const { ok, params, resolve, lookup, blobUrl } = ctx;
  const { uri } = params;

  const records = await resolve<Play>([uri]);
  if (records.length === 0) throw new NotFoundError("Play not found");

  const record = records[0];
  const profiles = await lookup<Profile>("app.bsky.actor.profile", "did", [record.did]);
  const profile = profiles.get(record.did);

  return ok({
    play: views.playView({
      record: {
        uri: record.uri,
        did: record.did,
        handle: record.handle,
        ...record.value,
      },
      author: profile
        ? {
            did: profile.did,
            handle: profile.handle,
            displayName: profile.value.displayName,
            avatar: blobUrl(profile.did, profile.value.avatar, "avatar"),
          }
        : undefined,
    }),
  });
});
```

The `params` object is typed from your lexicon's parameter definitions. In this case, `params.uri` is a string because the lexicon declares it. The `ok()` function enforces the output schema at the type level -- if your return value doesn't match, TypeScript will error.

## Defining a procedure

Use `defineProcedure()` for POST endpoints that modify data. The request body is available via `ctx.input`, typed from your lexicon's input schema:

```typescript
// server/xrpc/doSomething.ts
import { defineProcedure } from "$hatk";

export default defineProcedure("dev.hatk.unspecced.doSomething", async (ctx) => {
  const { ok, db, viewer, input } = ctx;

  if (!viewer) throw new Error("Authentication required");

  const { name, value } = input;

  await db.run(
    `INSERT INTO my_table (did, name, value, created_at) VALUES ($1, $2, $3, $4)`,
    viewer.did,
    name,
    value,
    new Date().toISOString(),
  );

  return ok({});
});
```

## Context reference

Both `defineQuery` and `defineProcedure` handlers receive the same context object:

| Field                 | Type                      | Description                                                           |
| --------------------- | ------------------------- | --------------------------------------------------------------------- |
| `ok`                  | function                  | Wraps your return value with type checking                            |
| `params`              | object                    | Typed parameters from the lexicon schema                              |
| `input`               | object                    | Request body (procedures only), typed from the lexicon's input schema |
| `db.query`            | function                  | Run SQL queries against your SQLite database                          |
| `db.run`              | function                  | Execute SQL statements (INSERT, UPDATE, DELETE)                       |
| `viewer`              | `{ did: string }` \| null | The authenticated user, or null                                       |
| `limit`               | number                    | Requested page size                                                   |
| `cursor`              | string \| undefined       | Pagination cursor                                                     |
| `resolve`             | function                  | Resolve AT URIs into full records                                     |
| `lookup`              | function                  | Look up records by a field value                                      |
| `count`               | function                  | Count records by field value                                          |
| `exists`              | function                  | Check if a record exists matching field filters                       |
| `search`              | function                  | Full-text search a collection                                         |
| `labels`              | function                  | Query labels for a list of URIs                                       |
| `blobUrl`             | function                  | Resolve a blob reference to a CDN URL                                 |
| `packCursor`          | function                  | Encode a `(primary, cid)` pair into a cursor string                   |
| `unpackCursor`        | function                  | Decode a cursor back into `{ primary, cid }`                          |
| `isTakendown`         | function                  | Check if a DID has been taken down                                    |
| `filterTakendownDids` | function                  | Filter a list of DIDs, returning those taken down                     |

### `ctx.ok()`

Every handler must return `ctx.ok(data)`. This wraps your response with type checking against the lexicon's output schema. If the shape doesn't match, TypeScript catches it at compile time.

### `ctx.db.query()` and `ctx.db.run()`

Run SQL against your SQLite database. Use `db.query()` for SELECT statements that return rows, and `db.run()` for INSERT/UPDATE/DELETE:

```typescript
// Query — returns rows
const rows = await db.query(
  `SELECT CAST(COUNT(*) AS INTEGER) AS play_count
   FROM "fm.teal.alpha.feed.play"
   WHERE did = $1`,
  [params.actor],
);

// Run — executes a statement
await db.run(
  `INSERT INTO my_table (did, value) VALUES ($1, $2)`,
  viewer.did,
  input.value,
);
```

### `ctx.resolve()` and `ctx.lookup()`

These helpers fetch records without writing raw SQL:

```typescript
// Resolve AT URIs into full records
const records = await resolve<Play>([uri]);

// Look up records by a field value — returns a Map keyed by the field
const profiles = await lookup<Profile>("app.bsky.actor.profile", "did", [did1, did2]);
const profile = profiles.get(did1);
```

### `ctx.viewer`

`viewer` is `{ did: string }` when the request comes from an authenticated user, or `null` for unauthenticated requests. Check it to protect endpoints that require authentication:

```typescript
if (!viewer) throw new Error("Authentication required");
```

## Error handling

Import error classes from your generated types to throw standard XRPC errors:

```typescript
import { NotFoundError, InvalidRequestError } from "$hatk";

// 404 — record not found
throw new NotFoundError("Play not found");

// 400 — bad request
throw new InvalidRequestError("Missing required field");
```

These map to standard XRPC error responses that clients can handle predictably.

## Lexicon pairing

Each handler must have a matching lexicon definition. The file path mirrors the NSID:

```
lexicons/dev/hatk/unspecced/getPlay.json  →  server/xrpc/getPlay.ts
```

The lexicon defines parameter types, input/output schemas, and whether the endpoint is a query or procedure. See the [AT Protocol lexicon docs](https://atproto.com/specs/lexicon) for schema details.

## Generating a handler

Use the CLI to scaffold a new handler:

```bash
hatk generate xrpc dev.hatk.unspecced.getPlay
```

This creates the handler file with the right imports and structure.
