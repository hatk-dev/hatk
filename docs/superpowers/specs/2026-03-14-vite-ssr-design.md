# Vite SSR & Environment API Integration Design

**Goal:** Replace tsx watch child process with Vite 8 Environment API for in-process HMR, rewrite server to Web Standard Request/Response, add framework-agnostic SSR rendering, and produce a single deployable artifact from `vite build`.

**Status:** Design complete

---

## Architecture Overview

hatk registers a custom `hatk` environment with Vite 8's Environment API. In dev, a `RunnableDevEnvironment` runs the hatk server through Vite's module runner with full HMR. In production, `vite build` produces client assets with an SSR manifest plus a server entry point.

**Three layers:**

1. **Infrastructure** — Database, firehose indexer, OAuth, backfill workers. Boots once in `configureServer`, survives handler reloads. Exposed via existing global singletons (`db.ts`, `indexer.ts`).

2. **Handler layer** — Everything in `server/`. Loaded through the module runner. On file change, module graph invalidates the changed module, entry re-imports. Handlers get fresh code while DB connections persist.

3. **Request handler** — A Web Standard `fetch` function (`Request → Response`) exported from the handler entry module. Routes API requests to XRPC/feeds/OG handlers. Routes HTML requests through the user's `defineRenderer` if provided, otherwise serves the SPA shell. A hand-rolled ~50 line adapter bridges this to Node.js `createServer` in production.

**SSR model:** hatk is not an SSR framework. It provides the hook point (`defineRenderer`), the SSR manifest, and the `Request` object. The user brings their own framework renderer (Vue, React, Svelte). Vite handles framework-specific compilation. hatk serves the result with correct asset preloads and OG meta tags.

## Dev Mode

The Vite plugin registers a `hatk` environment and hooks into the dev server lifecycle:

```ts
// vite.config.ts
import { defineConfig } from 'vite-plus'
import { hatk } from '@hatk/hatk/vite-plugin'

export default defineConfig({
  plugins: [hatk()],
  test: { include: ['test/**/*.test.ts'] },
  lint: { ignorePatterns: ['dist/**'] },
})
```

**Boot sequence:**
1. Vite starts, `hatk()` plugin's `config()` hook registers the `hatk` environment
2. `configureServer()` fires — boots infrastructure (DB, indexer, OAuth) from `hatk.config.ts`
3. Module runner imports the handler entry module
4. Entry module scans `server/`, registers handlers, exports a `fetch(Request) → Response` function
5. Plugin mounts the fetch handler as Vite middleware for backend routes (`/xrpc/*`, `/oauth/*`, `/og/*`)
6. For HTML requests: if `defineRenderer` exists, calls it with the `Request` and SSR manifest, serves rendered HTML with asset preloads and OG meta
7. If no renderer: falls through to Vite's client pipeline (SPA mode, same as today)

**HMR flow:**
1. User edits `server/recent.ts`
2. Vite watcher fires, `hotUpdate` hook invalidates the module in the `hatk` environment's graph
3. Module runner re-imports entry — scanner re-registers handlers
4. Next request uses updated code. No restart, no dropped DB connections.

**No proxy, no child process, no ECONNREFUSED errors.** Everything runs in-process.

## Request/Response Architecture

hatk's server rewrites from Node.js `IncomingMessage`/`ServerResponse` to Web Standard `Request`/`Response`. The core becomes a pure function:

```ts
type HatkHandler = (request: Request) => Promise<Response>
```

**Routing order inside the handler:**
1. `/xrpc/*` → XRPC query/procedure dispatch
2. `/oauth/*` → OAuth server
3. `/.well-known/*` → AT Protocol discovery
4. `/og/*` → OpenGraph image generation
5. `/*` with `Accept: text/html` → `defineRenderer` if exists, else SPA shell
6. `/*` → static assets (production only, dev falls through to Vite)

**Node.js adapter (~50 lines):**
```ts
// Converts IncomingMessage → Request
function toRequest(req: IncomingMessage): Request { ... }

// Pipes Response → ServerResponse
function sendResponse(res: ServerResponse, response: Response): Promise<void> { ... }

// Bridge for production
createServer(async (req, res) => {
  const response = await handler(toRequest(req))
  await sendResponse(res, response)
}).listen(port)
```

In dev, Vite middleware calls `handler(request)` directly — no adapter needed since Vite 8's environment API works with the fetch pattern.

**What changes from current `server.ts`:** The 1200-line file gets rewritten as a pure `Request → Response` function. All the route handling logic stays, but `res.writeHead()`/`res.end()` calls become `new Response()` constructors. The viewer auth, CORS, error handling all work the same way, just returning `Response` objects.

## SSR Rendering

hatk provides the plumbing. The user brings the framework.

**The hook:**
```ts
// server/render.tsx
export default defineRenderer(async (request, manifest) => {
  const url = new URL(request.url).pathname
  const { render } = await import('../src/entry-server.tsx')
  const html = render(url)
  const preloads = manifest.getPreloadTags(url)
  return { html, head: preloads }
})
```

**What hatk does with the result:**
1. Reads `index.html` as a template
2. Injects `head` (asset preload tags) into `<head>`
3. Injects OG meta tags into `<head>` (from `defineOG` handlers, same as today)
4. Injects `html` into the app mount point (e.g. `<!--ssr-outlet-->` or `<div id="app">`)
5. Returns the assembled page as a `Response`

**What hatk does NOT do:**
- No routing — the renderer decides what to render based on the URL
- No data fetching magic — the renderer calls its own APIs or uses an XRPC client
- No framework-specific transforms — Vite plugins handle that (`@vitejs/plugin-react`, `@sveltejs/vite-plugin-svelte`, etc.)

**If no `defineRenderer` exists:** hatk falls back to SPA mode — serves `index.html` with OG meta tags injected, exactly like today. SSR is opt-in.

**Client hydration** is entirely the user's responsibility:
```tsx
// src/entry-client.tsx
hydrateRoot(document, <App />)
```

## Production Build

`vite build` produces two outputs via Vite's `buildApp` hook:

**Stage 1: Client**
- Standard Vite client build → `dist/client/`
- Generates SSR manifest at `dist/client/.vite/ssr-manifest.json`
- Static assets with content-hashed filenames

**Stage 2: Server (hatk environment)**
- Bundles handler entry + all `server/` code → `dist/server/index.js`
- Externalizes native dependencies (`better-sqlite3`, `@duckdb/node-api`)
- Embeds the Node.js adapter (~50 lines)
- SSR manifest inlined or referenced for asset injection

**Running in production:**
```bash
node dist/server/index.js
```

This boots infrastructure (DB, indexer, OAuth), imports the bundled handlers, and starts an HTTP server that:
- Serves API routes via the `Request → Response` handler
- SSR renders HTML requests through the bundled renderer with correct asset preloads
- Serves static assets from `dist/client/` with cache headers
- Injects OG meta tags for all HTML responses

**Single deployable artifact.** No separate frontend/backend deploy. `dist/` contains everything.

## Example App Structure (React)

```
vite.config.ts
hatk.config.ts
index.html
lexicons/
  xyz/myapp/
    post.json
    profile.json
server/
  feed.ts              → defineFeed(...)
  get-profile.ts       → defineQuery(...)
  on-login.ts          → defineHook(...)
  render.tsx           → defineRenderer(...)
src/
  entry-client.tsx     → hydrateRoot(document, <App />)
  entry-server.tsx     → renderToString(<App />)
  App.tsx
  routes/
    Home.tsx
    Profile.tsx
```

Framework-agnostic: swap React for Svelte or Vue by changing the entry files and Vite plugin. hatk's `server/` code stays identical.

## Implementation Scope

| Component | What changes |
|---|---|
| `server.ts` | Rewrite as `Request → Response` function |
| `vite-plugin.ts` | Replace tsx watch with DevEnvironment + middleware |
| New: `adapter.ts` | ~50 line Node.js `Request`/`Response` bridge |
| New: `defineRenderer` | New define function + SSR assembly logic |
| `main.ts` | Production entry: boot infra + start server via adapter |
| `cli.ts` codegen | Add `defineRenderer` export to `hatk.generated.ts` |
| Templates | Migrate to vite-plus, add `entry-server`/`entry-client` |

**What doesn't change:** Database layer, indexer, backfill, OAuth, lexicon loading, schema migration, feeds/xrpc/labels/og handler APIs.

## Key Decisions

1. **Vite 8 Environment API** with `RunnableDevEnvironment` (not legacy `ssrLoadModule`)
2. **Web Standard `Request`/`Response`** throughout (not Node.js IncomingMessage/ServerResponse)
3. **Hand-rolled Node.js adapter** (~50 lines, no h3 or @whatwg-node dependency)
4. **`defineRenderer(async (request, manifest) => ...)`** for framework-agnostic SSR
5. **Global singletons** for infrastructure (DB, indexer) — survives HMR reloads
6. **Two-stage production build** (client with SSR manifest + server environment)
7. **Peer dependency on `vite`** — works with both raw Vite and vite-plus
8. **SSR is opt-in** — no renderer = SPA mode, same as today
