# Typed XRPC Actions Design

**Goal:** Make `callXrpc` handle procedures (POST with JSON body) and blob uploads in addition to queries, working on both client and server (SvelteKit form actions).

**Architecture:** Extract PDS proxy logic into shared functions. Register write operations as core XRPC handlers so server-side `callXrpc` works. Update generated client code to detect procedures vs queries and use POST vs GET accordingly.

---

## 1. Generated Client `callXrpc`

The codegen in `cli.ts` already knows which lexicons are `type: "procedure"` vs `type: "query"`. Generate two runtime sets in `hatk.generated.client.ts`:

```ts
const _procedures = new Set(['dev.hatk.createRecord', 'dev.hatk.deleteRecord', 'dev.hatk.putRecord'])
const _blobInputs = new Set(['dev.hatk.uploadBlob'])
```

Update `callXrpc` to branch on these:

```ts
type CallArg<K extends keyof XrpcSchema> =
  XrpcSchema[K] extends { input: infer I } ? I :
  XrpcSchema[K] extends { params: infer P } ? P :
  Record<string, unknown>

export async function callXrpc<K extends keyof XrpcSchema & string>(
  nsid: K,
  arg?: CallArg<K>,
): Promise<OutputOf<K>> {
  // Server-side bridge (SSR / form actions)
  if (typeof window === 'undefined') {
    const bridge = (globalThis as any).__hatk_callXrpc
    if (bridge) return bridge(nsid, arg) as Promise<OutputOf<K>>
    throw new Error('callXrpc: server bridge not available')
  }

  const url = new URL(`/xrpc/${nsid}`, window.location.origin)

  // Blob upload: POST raw body
  if (_blobInputs.has(nsid)) {
    const blob = arg as Blob | ArrayBuffer
    const contentType = blob instanceof Blob ? blob.type : 'application/octet-stream'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: blob,
    })
    if (!res.ok) throw new Error(`XRPC ${nsid} failed: ${res.status}`)
    return res.json() as Promise<OutputOf<K>>
  }

  // Procedure: POST JSON body
  if (_procedures.has(nsid)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arg),
    })
    if (!res.ok) throw new Error(`XRPC ${nsid} failed: ${res.status}`)
    return res.json() as Promise<OutputOf<K>>
  }

  // Query: GET with query params
  for (const [k, v] of Object.entries(arg || {})) {
    if (v != null) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`XRPC ${nsid} failed: ${res.status}`)
  return res.json() as Promise<OutputOf<K>>
}
```

User-defined procedures (via `defineProcedure`) are also included in the `_procedures` set.

## 2. Shared PDS Proxy Functions

Extract from `server.ts` into a new file `pds-proxy.ts`:

```ts
// packages/hatk/src/pds-proxy.ts

export async function proxyCreateRecord(
  viewer: { did: string },
  input: { collection: string; repo: string; record: unknown },
): Promise<{ uri?: string; cid?: string }>

export async function proxyDeleteRecord(
  viewer: { did: string },
  input: { collection: string; rkey: string },
): Promise<{}>

export async function proxyPutRecord(
  viewer: { did: string },
  input: { collection: string; rkey: string; record: unknown; repo?: string },
): Promise<{ uri?: string; cid?: string }>

export async function proxyUploadBlob(
  viewer: { did: string },
  blob: Blob | ArrayBuffer,
  contentType: string,
): Promise<{ blob: unknown }>
```

Each function:
1. Looks up the viewer's PDS session from the DB
2. Creates a DPoP proof for the PDS endpoint
3. Proxies the request to the PDS
4. Handles DPoP nonce retry
5. Handles token refresh if expired

This is the same logic currently in `server.ts` HTTP route handlers, extracted to be reusable.

## 3. Register Write Operations as Core XRPC Handlers

In `server.ts` `initServer()`, register alongside existing handlers:

```ts
registerCoreXrpcHandler('dev.hatk.createRecord', async (_params, _cursor, _limit, viewer, input) => {
  if (!viewer) throw new InvalidRequestError('Authentication required')
  return proxyCreateRecord(viewer, input as any)
})

registerCoreXrpcHandler('dev.hatk.deleteRecord', async (_params, _cursor, _limit, viewer, input) => {
  if (!viewer) throw new InvalidRequestError('Authentication required')
  return proxyDeleteRecord(viewer, input as any)
})

registerCoreXrpcHandler('dev.hatk.putRecord', async (_params, _cursor, _limit, viewer, input) => {
  if (!viewer) throw new InvalidRequestError('Authentication required')
  return proxyPutRecord(viewer, input as any)
})

registerCoreXrpcHandler('dev.hatk.uploadBlob', async (_params, _cursor, _limit, viewer, input) => {
  if (!viewer) throw new InvalidRequestError('Authentication required')
  return proxyUploadBlob(viewer, input as any, 'application/octet-stream')
})
```

The existing HTTP routes in `server.ts` call the same `proxy*` functions but stay in place for direct HTTP access.

## 4. Server-Side Bridge for Procedures

The `callXrpc` bridge in `xrpc.ts` already passes `input` through:

```ts
export async function callXrpc(nsid, params, input) {
  // ...
  const result = await executeXrpc(nsid, stringParams, cursor, limit, viewer, input)
}
```

For procedures called via the bridge, `params` will be the input body (since `callXrpc` has a single `arg` parameter). The bridge needs to detect this: if the arg is an object with procedure-shaped data (not query params), pass it as `input` rather than `params`.

The simplest approach: the generated client code passes a third argument for procedures:

```ts
// In generated client, server-side branch:
if (_procedures.has(nsid) || _blobInputs.has(nsid)) {
  if (bridge) return bridge(nsid, {}, arg) as Promise<OutputOf<K>>
}
if (bridge) return bridge(nsid, arg) as Promise<OutputOf<K>>
```

This keeps the bridge contract clean — queries pass `(nsid, params)`, procedures pass `(nsid, {}, input)`.

## 5. Template Usage

After this change, the statusphere template's `+page.svelte` replaces the manual `xrpc()` helper:

```svelte
<script lang="ts">
  import { callXrpc } from '$hatk/client'

  async function createStatus(emoji: string) {
    await callXrpc('dev.hatk.createRecord', {
      collection: 'xyz.statusphere.status',
      repo: did,
      record: { status: emoji, createdAt: new Date().toISOString() },
    })
  }

  async function deleteStatus(uri: string) {
    await callXrpc('dev.hatk.deleteRecord', {
      collection: 'xyz.statusphere.status',
      rkey: uri.split('/').pop()!,
    })
  }
</script>
```

And SvelteKit form actions work too:

```ts
// +page.server.ts
import { callXrpc } from '$hatk/client'

export const actions = {
  create: async ({ request, cookies }) => {
    const data = await request.formData()
    await callXrpc('dev.hatk.createRecord', {
      collection: 'xyz.statusphere.status',
      repo: viewer.did,
      record: { status: data.get('emoji'), createdAt: new Date().toISOString() },
    })
  }
}
```

## Summary of Changes

| File | Change |
|------|--------|
| `cli.ts` (codegen) | Emit `_procedures` and `_blobInputs` sets, update `callXrpc` signature and body in client file |
| `pds-proxy.ts` (new) | Extracted PDS proxy functions |
| `server.ts` | HTTP routes delegate to `pds-proxy.ts`, register write ops as core XRPC handlers |
| `xrpc.ts` | No changes needed (already supports `input` parameter) |
