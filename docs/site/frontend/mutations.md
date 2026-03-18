---
title: Mutations
description: Create, update, and delete records from your frontend using remote functions and callXrpc.
---

# Mutations

hatk provides two patterns for mutations from the frontend: **remote functions** for server-side logic callable from components, and **`callXrpc`** for direct API calls. Remote functions are the recommended approach -- they run on the server but are imported and called like normal functions.

## Remote functions

Remote functions use SvelteKit's experimental remote functions feature. You define server-side functions in `.remote.ts` files, then import and call them from your components as if they were local.

### Defining remote functions

Create a `.remote.ts` file in your routes directory:

```typescript
// app/routes/status.remote.ts
import { command } from "$app/server";
import { callXrpc, getViewer } from "$hatk/client";

export const createStatus = command("unchecked", async (emoji: string) => {
  const viewer = await getViewer();
  if (!viewer) throw new Error("Not authenticated");
  return callXrpc("dev.hatk.createRecord", {
    collection: "xyz.statusphere.status" as const,
    repo: viewer.did,
    record: { status: emoji, createdAt: new Date().toISOString() },
  });
});

export const deleteStatus = command("unchecked", async (rkey: string) => {
  const viewer = await getViewer();
  if (!viewer) throw new Error("Not authenticated");
  return callXrpc("dev.hatk.deleteRecord", {
    collection: "xyz.statusphere.status" as const,
    rkey,
  });
});
```

Key points:
- `command` comes from SvelteKit's `$app/server` -- it marks a function as a server-only remote function
- `"unchecked"` is the validation mode (SvelteKit experimental API)
- `getViewer()` reads the current user from the session
- `callXrpc("dev.hatk.createRecord", ...)` and `callXrpc("dev.hatk.deleteRecord", ...)` are typed calls to hatk's built-in record management endpoints

### Calling remote functions from components

Import remote functions directly in your Svelte components:

```svelte
<script lang="ts">
  import {
    createStatus as serverCreateStatus,
    deleteStatus as serverDeleteStatus,
  } from './status.remote'

  async function handleCreate(emoji: string) {
    const res = await serverCreateStatus(emoji)
    // res.uri contains the AT URI of the created record
  }

  async function handleDelete(uri: string) {
    const rkey = uri.split('/').pop()!
    await serverDeleteStatus(rkey)
  }
</script>
```

Even though these functions run on the server, you call them like any async function. SvelteKit handles the serialization and transport automatically.

### Enabling remote functions

Remote functions require two settings in `svelte.config.js`:

```javascript
// svelte.config.js
export default {
  compilerOptions: {
    experimental: {
      async: true,
    },
  },
  kit: {
    experimental: {
      remoteFunctions: true,
    },
  },
};
```

## Record mutations with `callXrpc`

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

For a responsive feel, update the UI before the server responds and roll back on failure. Here's the pattern from the statusphere template:

```svelte
<script lang="ts">
  import { callXrpc } from '$hatk/client'
  import { createStatus as serverCreateStatus } from './status.remote'
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
      const res = await serverCreateStatus(emoji)
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
      await serverDeleteStatus(uri.split('/').pop()!)
    } catch {
      if (removed) items = [removed, ...items]
    } finally {
      isMutating = false
    }
  }
</script>
```

## When to use remote functions vs. `callXrpc`

| Use case | Approach |
|---|---|
| Mutations that need auth checks | Remote functions -- call `getViewer()` server-side |
| Multi-step server logic | Remote functions -- keep it in one server round-trip |
| Simple reads from components | `callXrpc` directly -- no server function needed |
| Client-side infinite scroll | `callXrpc` directly in the component |
