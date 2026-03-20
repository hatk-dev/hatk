# Hook & XRPC Record Helpers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `createRecord`, `putRecord`, `deleteRecord` helpers to `OnLoginCtx` and `XrpcContext` so server-side code can write records through the PDS with local indexing, without raw SQL.

**Architecture:** The helpers wrap existing `pdsCreateRecord`/`pdsPutRecord`/`pdsDeleteRecord` from `pds-proxy.ts`. Both contexts need `oauthConfig` plumbed through — `OnLoginCtx` gets it via `fireOnLoginHook(did, config)` from `oauth/server.ts`, and `XrpcContext` gets it via a module-level setter called during boot.

**Tech Stack:** TypeScript, AT Protocol PDS proxy, SQLite indexing

---

### Task 1: Add `oauthConfig` to `fireOnLoginHook` and wire record helpers into `OnLoginCtx`

**Files:**
- Modify: `packages/hatk/src/hooks.ts`
- Modify: `packages/hatk/src/oauth/server.ts:540`

**Step 1: Update `OnLoginCtx` type to include record helpers**

In `packages/hatk/src/hooks.ts`, add the record helper types to `OnLoginCtx`:

```typescript
import type { OAuthConfig } from './config.ts'
import { pdsCreateRecord, pdsPutRecord, pdsDeleteRecord } from './pds-proxy.ts'

export type OnLoginCtx = Omit<BaseContext, 'db'> & {
  did: string
  db: {
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>
    run: (sql: string, params?: unknown[]) => Promise<void>
  }
  ensureRepo: (did: string) => Promise<void>
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
}
```

**Step 2: Update `fireOnLoginHook` to accept `oauthConfig` and build helpers**

Change the signature and body of `fireOnLoginHook`:

```typescript
export async function fireOnLoginHook(did: string, oauthConfig?: OAuthConfig | null): Promise<void> {
  if (!onLoginHook) return
  try {
    const base = buildBaseContext({ did })
    const viewer = { did }

    const hookPromise = onLoginHook({
      ...base,
      did,
      db: { query: base.db.query, run: runSQL },
      ensureRepo,
      createRecord: async (collection, record, opts) => {
        if (!oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
        return pdsCreateRecord(oauthConfig, viewer, { collection, record, rkey: opts?.rkey })
      },
      putRecord: async (collection, rkey, record) => {
        if (!oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
        return pdsPutRecord(oauthConfig, viewer, { collection, rkey, record })
      },
      deleteRecord: async (collection, rkey) => {
        if (!oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
        await pdsDeleteRecord(oauthConfig, viewer, { collection, rkey })
      },
    })
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('on-login hook timed out after 30s')), 30_000)
    )
    await Promise.race([hookPromise, timeout])
  } catch (err: any) {
    emit('hooks', 'on_login_error', { did, error: err.message })
  }
}
```

**Step 3: Pass `config` in `oauth/server.ts`**

In `packages/hatk/src/oauth/server.ts`, line 540, change:

```typescript
// Before:
await fireOnLoginHook(did)

// After:
await fireOnLoginHook(did, config)
```

**Step 4: Verify the build**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit -p packages/hatk/tsconfig.json`
Expected: No type errors

**Step 5: Commit**

```bash
git add packages/hatk/src/hooks.ts packages/hatk/src/oauth/server.ts
git commit -m "feat: add createRecord/putRecord/deleteRecord helpers to OnLoginCtx"
```

---

### Task 2: Add record helpers to `XrpcContext`

**Files:**
- Modify: `packages/hatk/src/xrpc.ts`

**Step 1: Add module-level `oauthConfig` setter and record helper types to `XrpcContext`**

Add imports and a module-level config variable at the top of `xrpc.ts`:

```typescript
import type { OAuthConfig } from './config.ts'
import { pdsCreateRecord, pdsPutRecord, pdsDeleteRecord } from './pds-proxy.ts'

let _oauthConfig: OAuthConfig | null = null

export function configureOAuth(config: OAuthConfig | null) {
  _oauthConfig = config
}
```

Add the helper fields to the `XrpcContext` interface:

```typescript
export interface XrpcContext<
  P = Record<string, string>,
  Records extends Record<string, any> = Record<string, any>,
  I = unknown,
> extends BaseContext {
  // ... existing fields ...
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
}
```

**Step 2: Wire helpers into `buildXrpcContext`**

Update the `buildXrpcContext` function to include the record helpers. The helpers use the `viewer` param already available in the function:

```typescript
export function buildXrpcContext(
  params: Record<string, string>,
  cursor: string | undefined,
  limit: number,
  viewer: { did: string; handle?: string } | null,
  input?: unknown,
): XrpcContext {
  const base = buildBaseContext(viewer)
  return {
    ...base,
    db: { query: querySQL, run: runSQL },
    params,
    input: input || {},
    cursor,
    limit,
    packCursor,
    unpackCursor,
    isTakendown: isTakendownDid,
    filterTakendownDids,
    search: searchRecords,
    resolve: resolveRecords as any,
    exists: async (collection, filters) => {
      const conditions = Object.entries(filters).map(([field, value]) => ({ field, value }))
      const uri = await findUriByFields(collection, conditions)
      return uri !== null
    },
    createRecord: async (collection, record, opts) => {
      if (!_oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
      if (!viewer) throw new Error('Authentication required to write records')
      return pdsCreateRecord(_oauthConfig, viewer, { collection, record, rkey: opts?.rkey })
    },
    putRecord: async (collection, rkey, record) => {
      if (!_oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
      if (!viewer) throw new Error('Authentication required to write records')
      return pdsPutRecord(_oauthConfig, viewer, { collection, rkey, record })
    },
    deleteRecord: async (collection, rkey) => {
      if (!_oauthConfig) throw new Error('No OAuth config — cannot write to PDS')
      if (!viewer) throw new Error('Authentication required to write records')
      await pdsDeleteRecord(_oauthConfig, viewer, { collection, rkey })
    },
  }
}
```

**Step 3: Verify the build**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit -p packages/hatk/tsconfig.json`
Expected: No type errors

**Step 4: Commit**

```bash
git add packages/hatk/src/xrpc.ts
git commit -m "feat: add createRecord/putRecord/deleteRecord helpers to XrpcContext"
```

---

### Task 3: Call `configureOAuth` during boot

**Files:**
- Modify: `packages/hatk/src/main.ts`
- Modify: `packages/hatk/src/dev-entry.ts`

**Step 1: Wire `configureOAuth` in `main.ts`**

Import and call `configureOAuth` alongside the existing `registerCoreHandlers` call:

```typescript
import { initXrpc, listXrpc, configureRelay, callXrpc, configureOAuth } from './xrpc.ts'

// After line 127 (registerCoreHandlers):
configureOAuth(config.oauth)
```

**Step 2: Wire `configureOAuth` in `dev-entry.ts`**

```typescript
import { configureOAuth } from './xrpc.ts'

// After line 76 (registerCoreHandlers):
configureOAuth(config.oauth)
```

**Step 3: Verify the build**

Run: `cd /Users/chadmiller/code/hatk && npx tsc --noEmit -p packages/hatk/tsconfig.json`
Expected: No type errors

**Step 4: Commit**

```bash
git add packages/hatk/src/main.ts packages/hatk/src/dev-entry.ts
git commit -m "feat: wire configureOAuth at boot for XRPC record helpers"
```

---

### Task 4: Update grain template `on-login.ts` to use `ctx.createRecord`

**Files:**
- Modify: `/Users/chadmiller/code/hatk-template-grain/server/on-login.ts`

**Step 1: Replace raw SQL with `ctx.createRecord`**

```typescript
import { defineHook, type GrainActorProfile, type BskyActorProfile } from "$hatk";

export default defineHook("on-login", async (ctx) => {
  const { did, ensureRepo, lookup } = ctx;

  // Backfill the user's repo and wait for completion
  await ensureRepo(did);

  // Check if user already has a grain profile
  const grainProfiles = await lookup<GrainActorProfile>("social.grain.actor.profile", "did", [did]);
  if (grainProfiles.has(did)) return;

  // No grain profile — copy from bsky profile if available
  const bskyProfiles = await lookup<BskyActorProfile>("app.bsky.actor.profile", "did", [did]);
  const bsky = bskyProfiles.get(did);
  if (!bsky) return;

  const record: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
  };
  if (bsky.value.displayName) record.displayName = bsky.value.displayName;
  if (bsky.value.description) record.description = bsky.value.description;
  if (bsky.value.avatar) record.avatar = bsky.value.avatar;

  await ctx.createRecord("social.grain.actor.profile", record, { rkey: "self" });
});
```

**Step 2: Verify the template builds**

Run: `cd /Users/chadmiller/code/hatk-template-grain && npx tsc --noEmit`
Expected: No type errors (after hatk types are regenerated)

**Step 3: Commit**

```bash
git add server/on-login.ts
git commit -m "refactor: replace raw SQL with ctx.createRecord in on-login hook"
```

---

### Task 5: Update documentation

**Files:**
- Modify: `packages/hatk/docs/site/guides/hooks.md`

**Step 1: Add record helpers to the hook context table**

Add three rows to the context table in `hooks.md`:

```markdown
| `createRecord` | `(collection, record, opts?) => Promise<{uri?, cid?}>` | Write a record to the user's PDS and index locally |
| `putRecord` | `(collection, rkey, record) => Promise<{uri?, cid?}>` | Create or update a record on the user's PDS |
| `deleteRecord` | `(collection, rkey) => Promise<void>` | Delete a record from the user's PDS and local index |
```

**Step 2: Update the "Populating records on first login" example**

Replace the raw SQL example with the `ctx.createRecord` version:

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

**Step 3: Commit**

```bash
git add packages/hatk/docs/site/guides/hooks.md
git commit -m "docs: update hooks guide with record helper examples"
```
