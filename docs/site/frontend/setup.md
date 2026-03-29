---
title: Frontend Setup
description: How hatk integrates with SvelteKit — the Vite plugin, generated files, and import aliases.
---

# Frontend Setup

hatk uses SvelteKit for its frontend, but any Vite SSR framework could be supported. The hatk CLI generates typed client code from your lexicons, so your components get autocomplete and type checking for every API call. The Vite plugin handles import resolution, the dev server, and the server-side bridge for `callXrpc()`.

## Vite plugin

Add the `hatk()` plugin to your `vite.config.ts` alongside `sveltekit()`:

```typescript
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { hatk } from "@hatk/hatk/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [hatk(), sveltekit()],
});
```

The `hatk()` plugin resolves `$hatk` and `$hatk/client` imports to the generated files, boots the dev server and PDS, and sets up the server-side bridge that lets `callXrpc()` work in both server and client contexts.

## Generated files

When you run `hatk dev` or `hatk generate types`, hatk produces two files in your project root:

| File | Purpose |
|---|---|
| `hatk.generated.ts` | Server-side types, helpers, and lexicon definitions. Exports `defineQuery`, `defineProcedure`, `defineFeed`, `callXrpc` (server variant), and all your record/view types. |
| `hatk.generated.client.ts` | Client-safe subset. Exports `callXrpc` (browser variant), `getViewer`, `login`, `logout`, `parseViewer`, and re-exports types from the server file without pulling in server-only dependencies. |

These files are auto-generated -- don't edit them. Add them to your lint/format ignore patterns:

```typescript
// vite.config.ts
export default defineConfig({
  // ...
  lint: {
    ignorePatterns: ["hatk.generated.ts", "hatk.generated.client.ts"],
  },
  fmt: {
    ignorePatterns: ["hatk.generated.ts", "hatk.generated.client.ts"],
  },
});
```

## Import aliases

SvelteKit aliases map `$hatk` and `$hatk/client` to the generated files. These are configured in `svelte.config.js`:

```javascript
// svelte.config.js
export default {
  kit: {
    alias: {
      $hatk: "./hatk.generated.ts",
      "$hatk/client": "./hatk.generated.client.ts",
    },
  },
};
```

**When to use which:**

- **`$hatk`** -- Use in server-only code: XRPC handler files, seeds, feeds, hooks. Contains server-side `callXrpc` that talks directly to your XRPC layer without HTTP.
- **`$hatk/client`** -- Use in components, `+page.server.ts`, `+layout.server.ts`, `.remote.ts` files, and anywhere that might run in the browser. Contains the client `callXrpc` that routes through HTTP on the client and uses a server bridge during SSR.

The rule is simple: if the file can be imported by a Svelte component (even indirectly), use `$hatk/client`.

## The `app/` directory

hatk projects use `app/` instead of `src/` for the SvelteKit source directory:

```javascript
// svelte.config.js
export default {
  kit: {
    files: {
      src: "app",
    },
  },
};
```

Your routes, components, and lib code live under `app/`:

```
app/
  routes/
    +page.svelte
    +page.server.ts
    +layout.server.ts
  lib/
    components/
```

This is a convention, not a requirement -- but all hatk templates use it and the CLI scaffolding expects it.

## Regenerating types

After adding or changing lexicons, regenerate the typed files:

```bash
npx hatk generate types
```

This updates both `hatk.generated.ts` and `hatk.generated.client.ts` with new types, XRPC schema entries, and helper functions matching your lexicons.
