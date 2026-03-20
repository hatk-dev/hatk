---
title: Hooks
description: Run custom logic at key points in the server lifecycle.
---

Hooks let you run custom logic at key points in the Hatk lifecycle, like when a user logs in via OAuth. Define them with `defineHook()` in the `server/` directory.

## `on-login`

The `on-login` hook runs after a successful OAuth login. The most common use is calling `ensureRepo` to backfill the user's data so it's available immediately:

```typescript
// server/on-login.ts
import { defineHook } from '$hatk'

export default defineHook('on-login', async ({ did, ensureRepo }) => {
  await ensureRepo(did)
})
```

This is three lines, but it's important: without it, a new user's existing records won't appear until the firehose (the AT Protocol's real-time event stream) delivers them. `ensureRepo` fetches the user's repository from their PDS, indexes it, and **waits for the backfill to complete** before returning.

### Populating records on first login

Since the hook has full database and record access, you can check for records and create them if needed. For example, copying a user's Bluesky profile to a custom profile collection on first login:

```typescript
// server/on-login.ts
import { defineHook, type BskyActorProfile, type MyAppProfile } from '$hatk'

export default defineHook('on-login', async (ctx) => {
  const { did, ensureRepo, lookup } = ctx

  await ensureRepo(did)

  // Check if user already has an app profile
  const existing = await lookup<MyAppProfile>('my.app.profile', 'did', [did])
  if (existing.has(did)) return

  // Copy from Bluesky profile
  const bsky = await lookup<BskyActorProfile>('app.bsky.actor.profile', 'did', [did])
  const profile = bsky.get(did)
  if (!profile) return

  await ctx.createRecord('my.app.profile', {
    displayName: profile.value.displayName,
    description: profile.value.description,
    avatar: profile.value.avatar,
    createdAt: new Date().toISOString(),
  }, { rkey: 'self' })
})
```

## Hook context

The `on-login` handler receives a context object with database access, record helpers, and the login event data:

| Field | Type | Description |
| --- | --- | --- |
| `did` | `string` | The DID of the user who logged in |
| `ensureRepo` | `(did: string) => Promise<void>` | Backfills the user's repo from their PDS and waits for completion |
| `db.query` | `(sql, params?) => Promise<unknown[]>` | Run a read query |
| `db.run` | `(sql, params?) => Promise<void>` | Run a write query (INSERT, UPDATE, DELETE) |
| `lookup` | `(collection, field, values) => Promise<Map>` | Look up records by field values |
| `count` | `(collection, field, values) => Promise<Map>` | Count records by field values |
| `getRecords` | `(collection, uris) => Promise<Map>` | Fetch records by URI |
| `labels` | `(uris) => Promise<Map>` | Get labels for URIs |
| `blobUrl` | `(did, ref, preset?) => string` | Generate a blob URL |
| `createRecord` | `(collection, record, opts?) => Promise<{uri?, cid?}>` | Write a record to the user's PDS and index locally |
| `putRecord` | `(collection, rkey, record) => Promise<{uri?, cid?}>` | Create or update a record on the user's PDS |
| `deleteRecord` | `(collection, rkey) => Promise<void>` | Delete a record from the user's PDS and local index |

## Error handling

If a hook throws, the error is logged but does not block the login flow. The user still completes authentication successfully. Hooks have a 30-second timeout — if the hook takes longer, it is cancelled and the login proceeds.
