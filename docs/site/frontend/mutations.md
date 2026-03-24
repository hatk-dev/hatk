---
title: Mutations
description: Create, update, and delete records from your frontend using callXrpc.
---

# Mutations

Mutations use `callXrpc` to call hatk's built-in record management endpoints. `callXrpc` is isomorphic, it works in server load functions, Svelte components, and anywhere else you have access to it.

```typescript
// Server-side: in a +layout.server.ts or +page.server.ts
export const load = async () => {
  return {
    feed: callXrpc("dev.hatk.getFeed", { feed: "recent", limit: 50 }),
  }
}

// Client-side: in a Svelte component or query helper
const res = await callXrpc("dev.hatk.createRecord", {
  collection: "xyz.statusphere.status" as const,
  repo: viewer.did,
  record: { status: "🚀", createdAt: new Date().toISOString() },
})
```

Pass SvelteKit's `fetch` as the optional third argument in load functions for request deduplication:

```typescript
callXrpc("dev.hatk.getFeed", { feed: "recent" }, fetch)
```

## Record mutations

hatk generates three built-in procedures for managing records:

| Method | Purpose |
|---|---|
| `dev.hatk.createRecord` | Create a new record in a collection |
| `dev.hatk.deleteRecord` | Delete a record by collection and rkey |
| `dev.hatk.putRecord` | Create or update a record at a specific rkey |

### Creating a record

```typescript
import { callXrpc } from "$hatk/client";

const result = await callXrpc("dev.hatk.createRecord", {
  collection: "xyz.statusphere.status" as const,
  repo: viewer.did,
  record: { status: "🚀", createdAt: new Date().toISOString() },
});
// result.uri — the AT URI of the new record
// result.cid — the content hash
```

The `collection` field uses `as const` so TypeScript narrows the `record` type to match that collection's schema. If your lexicon says `status` is required, you'll get a type error if you omit it.

### Deleting a record

```typescript
await callXrpc("dev.hatk.deleteRecord", {
  collection: "xyz.statusphere.status" as const,
  rkey: "3abc123",
});
```

The `rkey` is the last segment of the record's AT URI. For example, if the URI is `at://did:plc:abc/xyz.statusphere.status/3abc123`, the rkey is `3abc123`.

### Updating a record

```typescript
await callXrpc("dev.hatk.putRecord", {
  collection: "xyz.statusphere.status" as const,
  rkey: "3abc123",
  record: { status: "☕", createdAt: new Date().toISOString() },
});
```

`putRecord` writes a record at a specific rkey, creating it if it doesn't exist or replacing it if it does.

## Optimistic UI

For a responsive feel, update the UI before the server responds and roll back on failure:

```svelte
<script lang="ts">
  import { callXrpc } from '$hatk/client'
  import type { StatusView } from '$hatk/client'

  let { data } = $props()
  let items = $state(data.items as StatusView[])
  let isMutating = $state(false)

  async function createStatus(emoji: string) {
    if (isMutating) return
    const did = data.viewer!.did

    // 1. Insert optimistic item immediately
    const optimisticItem: StatusView = {
      uri: `at://${did}/xyz.statusphere.status/optimistic-${Date.now()}`,
      status: emoji,
      createdAt: new Date().toISOString(),
      author: { did, handle: did },
    }
    items = [optimisticItem, ...items]
    isMutating = true

    try {
      // 2. Call the server
      const res = await callXrpc('dev.hatk.createRecord', {
        collection: 'xyz.statusphere.status' as const,
        repo: did,
        record: { status: emoji, createdAt: new Date().toISOString() },
      })
      // 3. Replace optimistic item with real URI
      items = items.map(i =>
        i.uri === optimisticItem.uri
          ? { ...optimisticItem, uri: res.uri! }
          : i
      )
    } catch {
      // 4. Roll back on failure
      items = items.filter(i => i.uri !== optimisticItem.uri)
    } finally {
      isMutating = false
    }
  }
</script>
```

The same pattern works for deletes -- remove the item from the list immediately, then restore it if the server call fails:

```svelte
<script lang="ts">
  async function deleteStatus(uri: string) {
    if (isMutating) return
    const removed = items.find(i => i.uri === uri)
    items = items.filter(i => i.uri !== uri)
    isMutating = true

    try {
      const rkey = uri.split('/').pop()!
      await callXrpc('dev.hatk.deleteRecord', {
        collection: 'xyz.statusphere.status' as const,
        rkey,
      })
    } catch {
      if (removed) items = [removed, ...items]
    } finally {
      isMutating = false
    }
  }
</script>
```
