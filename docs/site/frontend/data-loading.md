---
title: Data Loading
description: Load data from your XRPC endpoints in SvelteKit pages using callXrpc and getViewer.
---

# Data Loading

hatk generates a typed `callXrpc()` function that calls your XRPC endpoints. It works in server load functions, universal load functions, and client-side components -- with full type inference for parameters and return values.

## `callXrpc()`

Import `callXrpc` from `$hatk/client`:

```typescript
import { callXrpc } from "$hatk/client";
```

The function signature is:

```typescript
async function callXrpc<K extends keyof XrpcSchema>(
  nsid: K,
  arg?: CallArg<K>,
  customFetch?: typeof globalThis.fetch,
): Promise<OutputOf<K>>
```

The first argument is the XRPC method name (e.g. `"dev.hatk.getFeed"`). TypeScript autocompletes available methods and infers the argument and return types from your lexicons.

**How it works in different contexts:**

- **Browser** -- Makes an HTTP request to `/xrpc/{nsid}` on your server
- **Server (SSR)** -- Uses an internal bridge to call your XRPC handlers directly, skipping HTTP entirely
- **Server with `customFetch`** -- Uses the provided fetch function instead of the bridge, which lets SvelteKit deduplicate requests between server and client

## Server load functions

The most common pattern is loading data in `+page.server.ts`. This runs only on the server, so `callXrpc` uses the internal bridge for zero-overhead calls:

```typescript
// app/routes/+page.server.ts
import { callXrpc } from "$hatk/client";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const feed = await callXrpc("dev.hatk.getFeed", {
    feed: "recent",
    limit: 30,
  });
  return {
    items: feed.items ?? [],
    cursor: feed.cursor,
  };
};
```

The returned data is available in your Svelte component via `$props()`:

```svelte
<script lang="ts">
  import type { PageData } from './$types'
  let { data }: { data: PageData } = $props()
</script>

{#each data.items as item}
  <p>{item.status}</p>
{/each}
```

## Universal load functions

Universal load functions (`+page.ts`) run on both server and client. Pass SvelteKit's `fetch` as the third argument to `callXrpc` so SvelteKit can deduplicate the request -- on the server it calls your endpoint directly, and on the client it reuses the serialized response instead of making a second HTTP request:

```typescript
// app/routes/+page.ts
import { callXrpc } from "$hatk/client";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const feed = await callXrpc(
    "dev.hatk.getFeed",
    { feed: "recent", limit: 30 },
    fetch,  // SvelteKit's fetch for deduplication
  );
  return {
    items: feed.items ?? [],
    cursor: feed.cursor,
  };
};
```

### When to use `customFetch`

Pass SvelteKit's `fetch` as the third argument whenever you call `callXrpc` in a universal load function (`+page.ts` or `+layout.ts`). This tells `callXrpc` to skip the internal server bridge and use SvelteKit's fetch instead, which handles request deduplication between server rendering and client hydration.

You don't need `customFetch` in `+page.server.ts` files -- those only run on the server, where the bridge is faster.

## Client-side data loading

You can also call `callXrpc` directly in components for client-side fetching, such as infinite scroll:

```svelte
<script lang="ts">
  import { callXrpc } from '$hatk/client'

  let items = $state(data.items)
  let cursor = $state(data.cursor)
  let loadingMore = $state(false)

  async function loadMore() {
    if (!cursor || loadingMore) return
    loadingMore = true
    try {
      const res = await callXrpc('dev.hatk.getFeed', {
        feed: 'recent',
        limit: 30,
        cursor,
      })
      items = [...items, ...res.items]
      cursor = res.cursor
    } finally {
      loadingMore = false
    }
  }
</script>
```

When called from the browser, `callXrpc` makes a standard HTTP request to your `/xrpc/{nsid}` endpoint.

## Identifying the current user

### `parseViewer()` in layout loads

Use `parseViewer()` in your root layout to read the session cookie and make the current user available to all pages:

```typescript
// app/routes/+layout.server.ts
import { parseViewer } from "$hatk/client";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ cookies }) => {
  const viewer = await parseViewer(cookies);
  return { viewer };
};
```

`parseViewer` decrypts the session cookie and returns `{ did, handle? }` for authenticated users, or `null` for anonymous visitors. The result flows into every page's `data.viewer`.

### `getViewer()` in server functions

Use `getViewer()` to access the current user in remote functions and other server-side code that runs within a request:

```typescript
import { getViewer } from "$hatk/client";

const viewer = await getViewer();
if (!viewer) throw new Error("Not authenticated");
// viewer.did is the user's DID
```

`getViewer()` reads the viewer that was set by `parseViewer` earlier in the request lifecycle. It returns `{ did }` or `null`.

## Types from `$hatk/client`

The generated client re-exports all view and record types from your lexicons:

```typescript
import type { StatusView, ProfileView } from "$hatk/client";
```

These types are derived from your lexicon definitions, so they stay in sync when you change a lexicon and run `hatk generate types`.
