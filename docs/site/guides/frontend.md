---
title: Frontend (SvelteKit)
description: Build a frontend for your hatk server with SvelteKit.
---

Scaffold a project with `--svelte` to get a SvelteKit frontend wired to your hatk backend:

```bash
hatk new my-app --svelte
```

## Project layout

The scaffold creates:

```
src/
├── app.html              # HTML shell
├── app.css               # Global styles
├── error.html            # Error fallback
├── lib/
│   ├── api.ts            # Typed XRPC client
│   ├── auth.ts           # OAuth helpers
│   └── query.ts          # TanStack Query client
└── routes/
    ├── +layout.svelte    # Root layout (OAuth init + QueryProvider)
    ├── +page.svelte      # Home page
    ├── +error.svelte     # Error page
    └── oauth/
        └── callback/
            └── +page.svelte  # OAuth redirect target
```

Plus these config files at the root:

- **`svelte.config.js`** — Static adapter outputting to `public/`, with `$hatk` alias pointing to `hatk.generated.ts`
- **`vite.config.ts`** — SvelteKit + hatk Vite plugin

## Vite plugin

The `hatk()` Vite plugin does two things:

1. **Proxies API routes** to the hatk backend (port 3001) during development — `/xrpc`, `/oauth/*`, `/.well-known`, `/og`, `/blob`, and others
2. **Starts the hatk server** automatically when the Vite dev server launches

```typescript
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite'
import { hatk } from 'hatk/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sveltekit(), hatk()],
})
```

During development, the Vite dev server runs on port 3000 and proxies API calls to the backend on port 3001. In production, the static build outputs to `public/` and the hatk server serves everything directly on port 3000.

## The `$hatk` alias

`svelte.config.js` defines an alias so you can import generated types cleanly:

```typescript
import type { XrpcSchema } from '$hatk'
```

This resolves to `./hatk.generated.ts`, giving you type-safe access to all your lexicon-defined endpoints.

## Root layout

The root layout initializes OAuth and wraps the app in a TanStack Query provider:

```svelte
<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query'
  import { queryClient } from '$lib/query'
  import { handleCallback, getOAuthClient } from '$lib/auth'
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'

  let { children } = $props()
  let ready = $state(false)

  onMount(async () => {
    const handled = await handleCallback()
    if (handled) goto('/', { replaceState: true })
    getOAuthClient()
    ready = true
  })
</script>

{#if ready}
  <QueryClientProvider client={queryClient}>
    {@render children()}
  </QueryClientProvider>
{/if}
```

The layout checks for an OAuth callback on every page load. Once initialized, it renders child routes inside the query provider.

## Fetching data

Use TanStack Svelte Query with the typed API client:

```svelte
<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query'
  import { api } from '$lib/api'
  import { viewerDid } from '$lib/auth'

  const queryClient = useQueryClient()

  // Read data with api.query()
  const statuses = createQuery(() => ({
    queryKey: ['statuses'],
    queryFn: () => api.query('xyz.statusphere.getStatuses', { limit: 30 }),
  }))

  // Write data with api.call()
  const createStatus = createMutation(() => ({
    mutationFn: (emoji: string) =>
      api.call('dev.hatk.createRecord', {
        collection: 'xyz.statusphere.status',
        repo: viewerDid()!,
        record: { status: emoji, createdAt: new Date().toISOString() },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['statuses'] }),
  }))
</script>
```

## Building for production

The SvelteKit static adapter compiles your frontend to `public/`:

```bash
npx vite build
```

The hatk server serves files from `public/` with SPA fallback, so client-side routing works out of the box.
