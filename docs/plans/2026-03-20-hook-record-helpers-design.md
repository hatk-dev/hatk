# Hook & XRPC Record Helpers Design

**Goal:** Add `createRecord`, `deleteRecord`, `putRecord` helpers to `OnLoginCtx` and `XrpcContext` so server-side code can write records through the PDS with local indexing, without raw SQL.

**Motivation:** Writing records currently requires raw SQL with manual column mapping, JSON serialization, and AT URI construction. The framework already has PDS proxy functions (`pdsCreateRecord`, etc.) that validate against lexicons, write to the user's PDS, and index locally — but they're only wired up to the core HTTP handlers, not available to hook or XRPC authors.

## Design

### Where the helpers live

- `XrpcContext` — already has an authenticated viewer and PDS session access
- `OnLoginCtx` — has a viewer (the user who just logged in) with a fresh PDS session
- `BaseContext` — stays read-only (feeds can run without a viewer)

### New fields

```typescript
createRecord: (
  collection: string,
  record: Record<string, unknown>,
  opts?: { rkey?: string },
) => Promise<{ uri?: string; cid?: string }>

putRecord: (
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
) => Promise<{ uri?: string; cid?: string }>

deleteRecord: (
  collection: string,
  rkey: string,
) => Promise<void>
```

### What they do

Each helper wraps the existing `pdsCreateRecord` / `pdsPutRecord` / `pdsDeleteRecord` from `pds-proxy.ts`:

1. Validate record against lexicons
2. Authenticate to user's PDS via DPoP (with nonce retry + token refresh)
3. Write to PDS
4. Index locally (insert/delete in SQLite)
5. Log errors on index failure (record still exists on PDS, will sync via firehose)

### Wiring

Both `XrpcContext` and `OnLoginCtx` need `oauthConfig` to call the PDS proxy functions.

**XrpcContext:** `buildXrpcContext` in `xrpc.ts` already runs inside `initXrpc` which has `oauthConfig`. Add the helpers there.

**OnLoginCtx:** `fireOnLoginHook` is called from `oauth/server.ts` `handleCallback` which has `config: OAuthConfig`. Pass it through:

```typescript
// oauth/server.ts
await fireOnLoginHook(did, config)
```

### Usage in hooks

```typescript
export default defineHook('on-login', async (ctx) => {
  await ctx.ensureRepo(ctx.did)

  const existing = await ctx.lookup('social.grain.actor.profile', 'did', [ctx.did])
  if (existing.has(ctx.did)) return

  const bsky = await ctx.lookup('app.bsky.actor.profile', 'did', [ctx.did])
  const profile = bsky.get(ctx.did)
  if (!profile) return

  await ctx.createRecord('social.grain.actor.profile', {
    displayName: profile.value.displayName,
    description: profile.value.description,
    avatar: profile.value.avatar,
    createdAt: new Date().toISOString(),
  }, { rkey: 'self' })
})
```

### Usage in XRPC handlers

```typescript
export default defineQuery('my.app.doThing', async (ctx) => {
  await ctx.createRecord('my.app.activity', {
    action: 'did-thing',
    createdAt: new Date().toISOString(),
  })
  return ctx.ok({ success: true })
})
```

## Files to change

**hatk framework:**
- `hooks.ts` — Add helpers to `OnLoginCtx`, update `fireOnLoginHook(did, oauthConfig)`
- `xrpc.ts` — Add helpers to `XrpcContext`, wire in `buildXrpcContext`
- `oauth/server.ts` — Pass `config` to `fireOnLoginHook`

**Templates:**
- `server/on-login.ts` — Replace raw SQL with `ctx.createRecord`

## Future: typed records

The helpers can later be typed with `RecordRegistry` so `createRecord('social.grain.actor.profile', ...)` validates the record shape at compile time, matching how `defineFeed` and `defineQuery` work. Not required for v1.

## Edge cases

- **No PDS session:** Throws `ProxyError(401)`. Caught by hook/XRPC error handling. Login/request still succeeds.
- **PDS write fails:** Error propagates to caller. In hooks, caught and logged. In XRPCs, returns error to client.
- **Local index fails after PDS write:** Already handled in pds-proxy.ts — logged, record syncs back via firehose.
- **No viewer (unauthenticated XRPC):** Helpers should not be called. Throws if no session exists.
