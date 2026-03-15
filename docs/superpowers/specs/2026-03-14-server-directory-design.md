# Server Directory Design

**Goal:** Consolidate all server-side code into a single `server/` directory with Vite SSR integration, inspired by Nitro's DX.

**Status:** Design complete

---

## Overview

All server-side code lives in a single `server/` directory. hatk recursively scans it on startup, inspects each file's default export, and wires it up based on the define function used. File names and subdirectory structure are purely organizational — hatk derives all routing and semantics from the define calls themselves.

## Define Functions

| Function | Purpose | Key args |
|---|---|---|
| `defineQuery(nsid, opts)` | XRPC query handler | lexicon-typed input/output |
| `defineProcedure(nsid, opts)` | XRPC mutation handler | lexicon-typed input/output |
| `defineFeed(name, opts)` | Feed generator | handler + hydrator |
| `defineHook(event, opts)` | Lifecycle hook | event name (e.g. `'on-login'`) |
| `defineSetup(fn)` | Boot-time setup | runs before server starts |
| `defineLabels(defs)` | Label definitions | array of label configs |
| `defineOG(path, fn)` | OpenGraph image | route path, returns JSX |

**Execution order:** Setup scripts run first (boot), then all other handlers register. During dev, handler files get Vite SSR HMR — edits reload instantly without restarting the database or indexer.

## Vite Integration

Adding `hatk()` to your Vite config is the entire setup. No separate server process, no CLI to run alongside Vite.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { hatk } from '@hatk/hatk/vite-plugin'

export default defineConfig({
  plugins: [hatk()]
})
```

**Dev mode (`vite dev`):** hatk boots its core runtime (database, indexer, OAuth) inside Vite's SSR context. Handler files in `server/` are loaded through Vite's module pipeline, giving them true HMR. Editing a feed or XRPC handler reloads just that handler — no database reconnection, no indexer restart, no lost firehose cursor.

**Build mode (`vite build`):** hatk compiles server code alongside the frontend. The output is a self-contained app — static assets plus a Node server entry point. `node dist/server.js` runs everything.

**Proxy rules:** In dev, Vite's dev server handles the frontend. hatk's plugin automatically proxies `/xrpc/*`, `/oauth/*`, `/.well-known/*`, `/og/*`, and other backend routes to the hatk runtime. No manual proxy configuration.

**What stays in the long-running core (no HMR):**
- Database connections (SQLite/DuckDB)
- Firehose indexer + websocket
- OAuth server state
- Backfill workers

**What gets HMR'd:**
- Feeds, queries, procedures, hooks, labels, OG handlers — anything defined in `server/`

## Project Structure

A minimal hatk app:

```
vite.config.ts
hatk.config.ts
lexicons/
  xyz/statusphere/
    profile.json
    status.json
server/
  feed.ts
  get-profile.ts
src/
  index.html
  App.tsx
```

A larger app organizes with optional subdirectories:

```
vite.config.ts
hatk.config.ts
lexicons/
  xyz/teal/
    post.json
    profile.json
    like.json
server/
  setup/
    seed-data.ts
  feeds/
    recent.ts
    popular.ts
    my-posts.ts
  xrpc/
    get-profile.ts
    set-status.ts
    create-post.ts
  hooks/
    on-login.ts
  labels.ts
  og-card.tsx
src/
  ...frontend code
```

Both are valid. hatk doesn't enforce directory structure inside `server/` — it scans recursively and only cares about exports.

**`hatk.config.ts` gets simpler.** Only non-code config: collections, OAuth, relay URL, database path. Everything behavioral moves into `server/`.

**`lexicons/` stays separate.** Lexicons are JSON schema definitions, not server code. They're consumed at build time for type generation and at runtime for validation.

## Implementation Scope

**1. Server scanner** — New module that recursively walks `server/`, imports each file, inspects the default export, and registers it with the appropriate subsystem. Replaces the current `initFeeds()`, `initXrpc()`, `initLabels()`, `initOpengraph()`, `loadOnLoginHook()`, and `initSetup()` calls in `main.ts` with a single `initServer('server/')` call.

**2. Vite SSR integration** — Replace the `tsx watch` spawn in the Vite plugin with Vite's `ssrLoadModule()` for handler files. The hatk core runtime (database, indexer, OAuth) boots once and stays alive. Handler modules get loaded/reloaded through Vite's module graph, giving us HMR for free.

**3. Define functions** — `defineQuery`, `defineProcedure`, `defineFeed`, `defineHook`, `defineSetup`, `defineLabels`, `defineOG` all export from `@hatk/hatk`. Each returns a typed descriptor object that the scanner knows how to register. The define functions themselves are thin — they just tag the config with a type and return it.

**4. Build output** — `vite build` produces a server entry point alongside static assets. The entry point imports the scanned handlers and boots the hatk runtime. Production runs with `node dist/server.js`.

**5. Template updates** — Rewrite statusphere and teal templates to use the new `server/` layout.

**What doesn't change:** Database layer, indexer, backfill, OAuth, lexicon loading, schema migration — all the infrastructure work stays as-is.
