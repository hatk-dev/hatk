---
title: Permissioned Spaces
description: Index AT Protocol spaces and serve them only to the viewers their authority admits.
---

# Permissioned Spaces

A [permissioned space](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data) is a set of records that is not public. A community's private forum, a members-only calendar, a photo pool: the records live in each writer's own repo, but the space decides who may read them, and none of it ever reaches a firehose.

That last part is why indexing one is different. There is no stream to tail. hatk asks the space's authority who has written into it, then reads those repos from the hosts that hold them, on a timer and on notice.

::: warning Alpha
Spaces are an alpha protocol feature. Most PDSes do not serve them yet.
:::

## Turning it on

```typescript
// hatk.config.ts
export default defineConfig({
  oauth: {/* required — see below */},
  spaces: {
    types: ['fyi.opensocial.forum'],
    watch: ['at://did:plc:xyz/space/fyi.opensocial.forum/gear-swap'],
    serviceDid: 'did:web:appview.example.com',
  },
})
```

| Option              | What it does                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`             | Space type NSIDs to follow. A space of any other type is refused, so a lexicon you vendored for reference cannot quietly become a subscription. |
| `watch`             | Spaces to follow at boot. Apps can also call `followSpace()` at runtime.                                                                        |
| `serviceDid`        | This instance's DID, so an authority can deliver write notices to it. Without it, writes appear within one sweep instead of within a second.    |
| `reconcileInterval` | Seconds between sweeps. Default 300, floor 30.                                                                                                  |

Leave `spaces` out and none of this runs. No space row is indexed, and every read behaves exactly as it did before.

### Why OAuth is required

hatk is a member of nothing. Reading a space begins with a delegation token from the reader's **own** PDS, so an instance holding no sessions has no way in at all. hatk borrows a signed-in member's delegation, exchanges it with the authority for a credential, and reads as them.

The consequence worth planning around: a space is only indexed while somebody who can read it has a live session on your instance.

### The DID document

When `serviceDid` is set, hatk serves the matching document at `/.well-known/did.json`, naming where an authority should deliver notices. Point the DID at your public origin. It publishes a service entry and no key — a syncer signs nothing.

## Reading space data

A record indexed from a space carries the space it came from, and is served only to a request that has proven it may read that space. That proof is not hatk's opinion: it mints a credential as the viewer and takes the authority's answer, cached briefly.

**A signed-out visitor is never shown a space record.** `readableBy: ["public"]` in the spaces protocol means any _authenticated_ reader, not anyone, and there is no anonymous read path into a space.

### Typed helpers apply the gate for you

`ctx.lookup`, `ctx.getRecords`, `ctx.resolve`, `ctx.search` and `ctx.count` all filter by what the viewer may see. Write the endpoint as you would for public data:

```typescript
export default defineQuery('com.example.getBoard', async (ctx) => {
  const { ok, lookup, params } = ctx
  const threads = await lookup('com.atmoboards.forum.thread', 'space', [params.space])
  return ok({ threads: [...threads.values()] })
})
```

### Feeds apply it too

`ctx.paginate` builds the gate into the SQL it composes, so an ordinary feed is already correct.

### Hand-written SQL: hatk tells you when it matters

Nothing can inject a predicate into a string you wrote, so `ctx.db.query` is the one read path hatk cannot gate for you. It does the next best thing. At boot it knows exactly which tables a space row can land in — the collections your configured space types declare — and a raw query naming one of those tables without the gate is refused, by name, with the helper that fixes it:

```
UngatedSpaceQueryError: Raw SQL reads "com.atmoboards.forum.thread", which
permissioned spaces write into, without the space gate. ...
```

So a feed over a collection no space touches never hears about any of this, and stays that way even if you add space types later. Only a query genuinely at risk is stopped, and it is stopped on the first run in development rather than in production.

When it is, `ctx.spaceFilter(alias, nextFreeParam)` returns the predicate, its parameters, and where the numbering continues:

```typescript
export default defineQuery('com.example.listThreads', async (ctx) => {
  const { ok, db, params, spaceFilter, limit } = ctx
  const gate = spaceFilter('t', 2)

  const rows = await db.query(
    `SELECT t.uri, t.did, t.title, t.created_at
       FROM "com.atmoboards.forum.thread" t
      WHERE t.space = $1 AND ${gate.sql}
      ORDER BY t.created_at DESC
      LIMIT $${gate.nextIdx}`,
    [params.space, ...gate.params, limit],
  )
  return ok({ threads: rows })
})
```

The two clauses do different jobs and you need both. `t.space = $1` is **which** board the caller asked for. `gate.sql` is **whether they may have it**. Drop the second and anyone who can name a space URI reads it.

Outside a viewer's scope the gate compiles to `t.space IS NULL` and binds no parameters, so on an instance that indexes no space it costs one test on an indexed column and changes no result.

For a result that is never served to a viewer — an admin rollup, a count, a maintenance pass — `ctx.db.unfiltered(sql, params)` runs the same query with the guard off. It is its own name rather than an option so that every such read says so where it happens and can be found with grep.

The check is a guard rail, not the security boundary: it matches the quoted table name and the gate's own SQL, and is meant to catch a mistake early rather than to survive an adversary. The gate applied by the helpers is the boundary.

## Blobs

A blob inside a space has no public URL by design: `com.atproto.space.getBlob` serves it only to a credential holder, so a public URL would become the capability the credential exists to replace. `ctx.blobUrl` is for public repo data.

Point the client at hatk's own route instead, using the CID from the record:

```
/space-blob?space=<space-ref>&repo=<writer-did>&cid=<blob-cid>
```

hatk fetches the bytes with the viewer's own credential and serves them `private, no-store`. A viewer who may not read the space gets the same 404 as a missing blob.

## What to expect

**Revocation lags.** A viewer's readable set is cached for five minutes, so somebody ejected from a community may still be served its rows for a few minutes. The space host itself already lets a minted credential outlive a revocation by up to two hours.

**Writes appear on notice or on sweep.** With `serviceDid` set, within about a second. Without it, within one `reconcileInterval`.

**Ejection removes rows.** When an authority stops naming a writer in a space, that writer's rows in it are dropped on the next sweep.

**Records are validated.** A record that fails its lexicon is skipped, the same as one arriving over the firehose.

**Nothing is cryptographically verified.** hatk trusts the repo host it read from, which is the same posture it takes toward the relay on the firehose path.
