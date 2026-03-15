# Typed XRPC Actions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `callXrpc` handle procedures (POST/body) and blob uploads on client and server, with SvelteKit remote functions (`command`) for mutations.

**Architecture:** Extract PDS proxy into shared functions. Register write ops as XRPC handlers. Update codegen for procedure-aware `callXrpc`. Update `getViewer()` to resolve from cookies via `getRequestEvent()`. Template uses `command()` remote functions for mutations.

**Tech Stack:** TypeScript, SvelteKit remote functions, AT Protocol OAuth/DPoP

---

### Task 1: Extract PDS proxy logic into pds-proxy.ts

**Files:**
- Create: `packages/hatk/src/pds-proxy.ts`
- Modify: `packages/hatk/src/server.ts`

**Step 1: Create pds-proxy.ts**

Move `proxyToPds` (server.ts:991-1052) and `proxyToPdsRaw` (server.ts:1055-1114) into a new file `packages/hatk/src/pds-proxy.ts`. Then add four high-level functions that wrap these:

```ts
import type { OAuthConfig } from './config.ts'
import { getSession } from './oauth/db.ts'
import { getServerKey } from './oauth/db.ts'
import { createDpopProof } from './oauth/dpop.ts'
import { refreshPdsSession } from './oauth/server.ts'
import { validateRecord } from '@bigmoves/lexicon'
import { getLexiconArray } from './database/schema.ts'
import { insertRecord, deleteRecord as dbDeleteRecord } from './database/db.ts'

export class ProxyError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}
```

Move `proxyToPds` and `proxyToPdsRaw` as-is (private functions).

Then add these exported functions:

- `pdsCreateRecord(oauthConfig, viewer, input: { collection, repo?, rkey?, record })` — validates record, gets session, proxies to PDS `com.atproto.repo.createRecord`, indexes locally
- `pdsDeleteRecord(oauthConfig, viewer, input: { collection, rkey })` — gets session, proxies to PDS `com.atproto.repo.deleteRecord`, deletes locally
- `pdsPutRecord(oauthConfig, viewer, input: { collection, rkey, record, repo? })` — validates, gets session, proxies to PDS `com.atproto.repo.putRecord`, re-indexes
- `pdsUploadBlob(oauthConfig, viewer, body: Uint8Array, contentType: string)` — gets session, proxies raw to PDS `com.atproto.repo.uploadBlob`

All throw `ProxyError` on auth/validation/PDS errors.

Reference the existing server.ts route handlers (lines 726-848) for exact logic — each function is a direct extraction of that code.

**Step 2: Update server.ts HTTP routes to use shared functions**

Import `{ pdsCreateRecord, pdsDeleteRecord, pdsPutRecord, pdsUploadBlob, ProxyError }` from `./pds-proxy.ts`.

Replace each HTTP route handler body (createRecord ~727-763, deleteRecord ~766-792, putRecord ~795-831, uploadBlob ~834-848) with:

```ts
if (!viewer) return withCors(jsonError(401, 'Authentication required', acceptEncoding))
const body = JSON.parse(await request.text())
try {
  const result = await pdsCreateRecord(oauth, viewer, body)
  return withCors(json(result, 200, acceptEncoding))
} catch (err: any) {
  if (err instanceof ProxyError) return withCors(jsonError(err.status, err.message, acceptEncoding))
  throw err
}
```

(Adjust per endpoint — uploadBlob reads `request.arrayBuffer()` and passes content-type.)

Delete the now-unused `proxyToPds` and `proxyToPdsRaw` from the bottom of server.ts. Remove any imports that are now only used by the deleted functions (check `getServerKey`, `createDpopProof` — they may still be used by admin proxy or elsewhere).

**Step 3: Verify**

Run: `npm run build`

**Step 4: Commit**

```
refactor: extract PDS proxy logic into shared pds-proxy.ts
```

---

### Task 2: Register write operations as core XRPC handlers

**Files:**
- Modify: `packages/hatk/src/server.ts:67-149` (registerCoreHandlers)
- Modify: `packages/hatk/src/main.ts:117`
- Modify: `packages/hatk/src/dev-entry.ts:61`

**Step 1: Add oauth parameter to registerCoreHandlers**

Change signature at server.ts:67:

```ts
export function registerCoreHandlers(collections: string[], oauth: OAuthConfig | null): void {
```

Add import for `OAuthConfig` type if needed.

**Step 2: Register write handlers at end of registerCoreHandlers**

```ts
if (oauth) {
  registerCoreXrpcHandler('dev.hatk.createRecord', async (_params, _cursor, _limit, viewer, input) => {
    if (!viewer) throw new InvalidRequestError('Authentication required')
    return pdsCreateRecord(oauth, viewer, input as any)
  })
  registerCoreXrpcHandler('dev.hatk.deleteRecord', async (_params, _cursor, _limit, viewer, input) => {
    if (!viewer) throw new InvalidRequestError('Authentication required')
    return pdsDeleteRecord(oauth, viewer, input as any)
  })
  registerCoreXrpcHandler('dev.hatk.putRecord', async (_params, _cursor, _limit, viewer, input) => {
    if (!viewer) throw new InvalidRequestError('Authentication required')
    return pdsPutRecord(oauth, viewer, input as any)
  })
  registerCoreXrpcHandler('dev.hatk.uploadBlob', async (_params, _cursor, _limit, viewer, input) => {
    if (!viewer) throw new InvalidRequestError('Authentication required')
    return pdsUploadBlob(oauth, viewer, input as any, 'application/octet-stream')
  })
}
```

**Step 3: Update call sites**

- `main.ts:117`: `registerCoreHandlers(collections, config.oauth)`
- `dev-entry.ts:61`: `registerCoreHandlers(collections, <oauth variable>)` — check what the oauth config variable is named in dev-entry.ts

**Step 4: Verify**

Run: `npm run build`

**Step 5: Commit**

```
feat: register write operations as core XRPC handlers
```

---

### Task 3: Update codegen for procedure-aware callXrpc

**Files:**
- Modify: `packages/hatk/src/cli.ts:1718-1787`

**Step 1: Collect procedure and blob nsids**

After the entries loop (~line 1425), add:

```ts
const procedureNsids: string[] = []
const blobInputNsids: string[] = []
for (const { nsid, defType } of entries) {
  if (defType === 'procedure') {
    const lex = lexicons.get(nsid)
    const inputEncoding = lex?.defs?.main?.input?.encoding
    if (inputEncoding === '*/*') {
      blobInputNsids.push(nsid)
    } else {
      procedureNsids.push(nsid)
    }
  }
}
```

**Step 2: Replace callXrpc generation block**

Replace lines ~1748-1769 with new code that:

1. Emits `const _procedures = new Set([...])` and `const _blobInputs = new Set([...])`
2. Uses `CallArg<K>` type instead of `ExtractParams` — resolves `input` for procedures, `params` for queries
3. Server-side bridge: procedures pass `(nsid, {}, arg)`, queries pass `(nsid, arg)`
4. Client-side: blob inputs POST raw with `blob.type`, procedures POST JSON, queries GET with query params

Delete the old `ExtractParams` type emission.

**Step 3: Update getViewer() to resolve from cookies**

In the `getViewer()` generation block (~lines 1771-1785), update the server-side path to try `getRequestEvent()` cookies:

```ts
clientOut += `\nexport function getViewer(): { did: string } | null {\n`
clientOut += `  const ssrViewer = (globalThis as any).__hatk_viewer\n`
clientOut += `  if (typeof window === 'undefined') {\n`
clientOut += `    if (ssrViewer) return ssrViewer\n`
clientOut += `    // Try resolving from request cookies (SvelteKit remote functions, load, etc.)\n`
clientOut += `    try {\n`
clientOut += `      const { getRequestEvent } = require('$app/server')\n`
clientOut += `      const event = getRequestEvent()\n`
clientOut += `      const cookieValue = event.cookies.get('__hatk_session')\n`
clientOut += `      // parseSessionCookie is sync-incompatible, so we can't call it here.\n`
clientOut += `      // The viewer should be set via layout.server.ts instead.\n`
clientOut += `    } catch {}\n`
clientOut += `    return null\n`
clientOut += `  }\n`
```

Wait — `parseSessionCookie` is async. `getViewer()` is sync. We can't call it.

**Revised approach:** Keep `getViewer()` sync. The viewer is already set on `globalThis.__hatk_viewer` by the layout.server.ts load function. Remote functions run in the same request context, so the viewer set during layout load is available. No change needed to `getViewer()` — it already works.

Verify: in the statusphere template's `+layout.server.ts`, the load function sets `(globalThis as any).__hatk_viewer = viewer`. Since remote functions run server-side in the same request lifecycle, `getViewer()` will pick it up from `globalThis.__hatk_viewer`.

**Actually** — `globalThis` is shared across all requests on the server. Setting `__hatk_viewer` in one request's layout load would leak to another request. This is a race condition.

**Better approach:** Make `getViewer()` async on the server and use the `__hatk_parseSessionCookie` bridge with `getRequestEvent()`:

```ts
clientOut += `\nexport async function getViewer(): Promise<{ did: string } | null> {\n`
clientOut += `  if (typeof window === 'undefined') {\n`
clientOut += `    try {\n`
clientOut += `      const parse = (globalThis as any).__hatk_parseSessionCookie\n`
clientOut += `      if (parse) {\n`
clientOut += `        const { getRequestEvent } = await import('$app/server')\n`
clientOut += `        const event = getRequestEvent()\n`
clientOut += `        const cookieValue = event.cookies.get('__hatk_session')\n`
clientOut += `        if (cookieValue) {\n`
clientOut += `          const request = new Request('http://localhost', {\n`
clientOut += `            headers: { cookie: \`__hatk_session=\${cookieValue}\` },\n`
clientOut += `          })\n`
clientOut += `          return parse(request)\n`
clientOut += `        }\n`
clientOut += `      }\n`
clientOut += `    } catch {}\n`
clientOut += `    return (globalThis as any).__hatk_viewer ?? null\n`
clientOut += `  }\n`
clientOut += `  try {\n`
clientOut += `    const mod = (globalThis as any).__hatk_auth\n`
clientOut += `    if (mod?.viewerDid) {\n`
clientOut += `      const did = mod.viewerDid()\n`
clientOut += `      if (did) return { did }\n`
clientOut += `    }\n`
clientOut += `  } catch {}\n`
clientOut += `  return (globalThis as any).__hatk_viewer ?? null\n`
clientOut += `}\n`
```

This changes `getViewer()` from sync to async. Update any existing usages. The `+layout.server.ts` in the template already has its own cookie parsing, so this mainly benefits remote functions.

**Note:** The `import('$app/server')` will fail in non-SvelteKit contexts. The `try/catch` handles that gracefully, falling back to `__hatk_viewer`.

**Step 4: Verify**

Run: `npm run build`

**Step 5: Commit**

```
feat: codegen emits procedure-aware callXrpc with async getViewer
```

---

### Task 4: Enable remote functions in statusphere template

**Files:**
- Modify: `/Users/chadmiller/code/hatk-template-statusphere/svelte.config.js`
- Create: `/Users/chadmiller/code/hatk-template-statusphere/app/routes/status.remote.ts`
- Modify: `/Users/chadmiller/code/hatk-template-statusphere/app/routes/+page.svelte`

**Step 1: Enable experimental remote functions**

In `svelte.config.js`, add:

```js
export default {
  compilerOptions: {
    experimental: {
      async: true,
    },
  },
  kit: {
    adapter: adapter(),
    files: { src: 'app' },
    alias: {
      $hatk: './hatk.generated.ts',
      '$hatk/client': './hatk.generated.client.ts',
    },
    experimental: {
      remoteFunctions: true,
    },
  },
}
```

**Step 2: Regenerate client file**

Run in template: `npx hatk generate`

Verify `hatk.generated.client.ts` has `_procedures` set and updated `callXrpc`.

**Step 3: Create remote functions file**

Create `app/routes/status.remote.ts`:

```ts
import { command } from '$app/server'
import { callXrpc, getViewer } from '$hatk/client'

export const createStatus = command(async (emoji: string) => {
  const viewer = await getViewer()
  if (!viewer) throw new Error('Not authenticated')
  return callXrpc('dev.hatk.createRecord', {
    collection: 'xyz.statusphere.status' as const,
    repo: viewer.did,
    record: { status: emoji, createdAt: new Date().toISOString() },
  })
})

export const deleteStatus = command(async (rkey: string) => {
  const viewer = await getViewer()
  if (!viewer) throw new Error('Not authenticated')
  return callXrpc('dev.hatk.deleteRecord', {
    collection: 'xyz.statusphere.status' as const,
    rkey,
  })
})
```

**Step 4: Update +page.svelte to use remote functions**

Import remote functions:
```ts
import { createStatus, deleteStatus } from './status.remote'
```

Remove the manual `xrpc()` helper function.

Remove the local `createStatus()` and `deleteStatus()` functions and replace with calls to the imported remote functions:

```ts
async function handleCreateStatus(emoji: string) {
  if (isMutating) return
  const did = data.viewer!.did
  const profile = viewerProfile

  const optimisticItem: StatusView = {
    uri: `at://${did}/xyz.statusphere.status/optimistic-${Date.now()}`,
    status: emoji,
    createdAt: new Date().toISOString(),
    author: { did, handle: profile?.handle || did, displayName: profile?.displayName },
  }
  items = [optimisticItem, ...items]
  isMutating = true

  try {
    const res = await createStatus(emoji)
    items = items.map(i => i.uri === optimisticItem.uri ? { ...optimisticItem, uri: res.uri! } : i)
  } catch {
    items = items.filter(i => i.uri !== optimisticItem.uri)
  } finally {
    isMutating = false
  }
}

async function handleDeleteStatus(uri: string) {
  if (isMutating) return
  const removed = items.find(i => i.uri === uri)
  items = items.filter(i => i.uri !== uri)
  isMutating = true

  try {
    await deleteStatus(uri.split('/').pop()!)
  } catch {
    if (removed) items = [removed, ...items]
  } finally {
    isMutating = false
  }
}
```

Update onclick handlers in template to use `handleCreateStatus` and `handleDeleteStatus`.

Keep `loadMore` using client-side `callXrpc` directly (it's a query, not a mutation).

**Step 5: Rebuild hatk and re-link**

```bash
cd /path/to/hatk && npm run build
cd /path/to/statusphere && npm link @hatk/hatk
```

**Step 6: Manual test**

Start dev server and test:
1. Sign in via OAuth
2. Create a status (should use remote function → server-side callXrpc)
3. Delete a status
4. Load more (client-side callXrpc query)

**Step 7: Commit**

```
feat: use SvelteKit remote functions for statusphere mutations
```
