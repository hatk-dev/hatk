---
title: XRPC Handlers
description: Define custom query and procedure endpoints.
---

Custom XRPC handlers extend your hatk server's API beyond the built-in endpoints. Place them in the `xrpc/` directory, organized by namespace.

```bash
hatk generate xrpc dev.hatk.unspecced.getPlay
```

This creates `xrpc/dev/hatk/unspecced/getPlay.ts`.

## `defineQuery`

For read-only GET endpoints:

```typescript
import { defineQuery } from '../../../../hatk.generated.ts'

export default defineQuery('dev.hatk.unspecced.getPlay', async (ctx) => {
  const { ok, params, resolve, lookup, blobUrl } = ctx
  const { uri } = params

  const records = await resolve([uri])
  if (records.length === 0) throw new NotFoundError('Play not found')

  const record = records[0]
  const profiles = await lookup('app.bsky.actor.profile', 'did', [record.did])
  const profile = profiles.get(record.did)

  return ok({
    play: {
      uri: record.uri,
      did: record.did,
      handle: record.handle,
      ...record.value,
      author: profile
        ? {
            did: profile.did,
            handle: profile.handle,
            displayName: profile.value.displayName,
            avatar: blobUrl(profile.did, profile.value.avatar, 'avatar'),
          }
        : undefined,
    },
  })
})
```

## `defineProcedure`

For write POST endpoints. The request body is available via `ctx.input`, typed from your lexicon's input schema:

```typescript
import { defineProcedure } from '../../../../hatk.generated.ts'

export default defineProcedure('dev.hatk.unspecced.doSomething', async (ctx) => {
  const { ok, db, viewer, input } = ctx

  if (!viewer) throw new Error('Authentication required')

  // input is typed from the lexicon's input schema
  const { name, value } = input

  await db.run(
    `INSERT INTO my_table (did, name, value, created_at) VALUES ($1, $2, $3, $4)`,
    viewer.did,
    name,
    value,
    new Date().toISOString(),
  )

  return ok({})
})
```

## Context

Both `defineQuery` and `defineProcedure` receive the same context:

| Field                 | Type                      | Description                                                           |
| --------------------- | ------------------------- | --------------------------------------------------------------------- |
| `db.query`            | function                  | Run SQL queries against DuckDB                                        |
| `db.run`              | function                  | Execute SQL statements                                                |
| `params`              | object                    | Typed parameters from the lexicon schema                              |
| `input`               | object                    | Request body (procedures only), typed from the lexicon's input schema |
| `limit`               | number                    | Requested page size                                                   |
| `cursor`              | string \| undefined       | Pagination cursor                                                     |
| `viewer`              | `{ did: string }` \| null | The authenticated user, or null                                       |
| `ok`                  | function                  | Wraps your return value with type checking                            |
| `packCursor`          | function                  | Encode a `(primary, cid)` pair into a cursor string                   |
| `unpackCursor`        | function                  | Decode a cursor back into `{ primary, cid }`                          |
| `search`              | function                  | Full-text search a collection                                         |
| `resolve`             | function                  | Resolve AT URIs into full records                                     |
| `lookup`              | function                  | Look up records by a field value                                      |
| `count`               | function                  | Count records by field value                                          |
| `exists`              | function                  | Check if a record exists matching field filters                       |
| `labels`              | function                  | Query labels for a list of URIs                                       |
| `blobUrl`             | function                  | Resolve a blob reference to a CDN URL                                 |
| `isTakendown`         | function                  | Check if a DID has been taken down                                    |
| `filterTakendownDids` | function                  | Filter a list of DIDs, returning those taken down                     |

## Errors

Import error classes from your generated types:

```typescript
import { NotFoundError, InvalidRequestError } from '../../../../hatk.generated.ts'

// 404
throw new NotFoundError('Play not found')

// 400
throw new InvalidRequestError('Missing required field')
```

## Lexicon pairing

Each handler must have a matching lexicon in `lexicons/`. The handler file path mirrors the NSID:

```
lexicons/dev/hatk/unspecced/getPlay.json  →  xrpc/dev/hatk/unspecced/getPlay.ts
```

The lexicon defines the parameter types, input/output schemas, and whether the endpoint is a query or procedure. The `ok()` function enforces the output schema at the type level — if your return value doesn't match, TypeScript will error.
