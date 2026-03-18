# Docs Overhaul Design

## Goal

Rewrite hatk documentation to reflect the current API surface (generated client helpers, SQLite-only, SvelteKit remote commands, `parseViewer`/`login`/`logout` from `$hatk/client`). Inspired by Nitro's docs style — project tree on landing page, code-heavy examples, progressive structure.

## Audience

Web developers who may or may not know AT Protocol. Don't gate understanding behind AT Protocol knowledge. Explain concepts inline as they come up ("lexicons are schemas for your data — like Prisma models but for the AT Protocol"). Link to AT Protocol docs for deep dives.

## Framework

Stay with VitePress. Content is the problem, not the tooling.

---

## Landing Page

Hero with current tagline, then a project structure visualization:

```
my-app/
├── app/                    # SvelteKit frontend
│   ├── routes/
│   │   ├── +layout.server.ts   # parseViewer(cookies)
│   │   └── +page.svelte        # your UI
│   └── lib/
├── server/                 # Backend
│   ├── feeds/              # Feed generators
│   │   └── recent.ts       # defineFeed({ ... })
│   └── xrpc/               # Custom endpoints
│       └── getProfile.ts   # defineQuery('...', ...)
├── seeds/
│   └── seed.ts             # Test fixtures
├── lexicons/               # AT Protocol schemas
├── hatk.config.ts          # Configuration
└── hatk.generated.ts       # Auto-generated types
```

Below the tree, 4 feature cards:
- **Typed end-to-end** — Lexicons generate TypeScript types for records, queries, feeds
- **SQLite by default** — No external database, just works
- **OAuth built-in** — AT Protocol auth with session cookies, no setup
- **SvelteKit-first** — Full-stack with SSR, remote commands, typed XRPC calls

CTA: "Get Started"

---

## Navigation Structure

### Top nav
- Guide → /getting-started/quickstart
- Frontend → /frontend/setup
- CLI → /cli/
- API → /api/

### Sidebar

**Getting Started** (3 pages)
- Quickstart
- Project Structure
- Configuration

**Guides** (7 pages)
- Feeds
- XRPC Handlers
- Auth & OAuth
- Seeds
- Labels
- OpenGraph
- Hooks

**Frontend** (3 pages)
- SvelteKit Setup
- Data Loading
- Mutations

**CLI Reference** (5 pages)
- Overview
- Scaffolding
- Development
- Testing
- Build & Deploy

**API Reference** (7 pages)
- Overview
- Records
- Feeds
- Search
- Blobs
- Preferences
- Labels

---

## Page Details

### Getting Started

**Quickstart** — Zero to running app in under 2 minutes.
1. `npx hatk new my-app`
2. `cd my-app && npm run dev`
3. Open browser, see the app
4. Make a first change (edit a feed or add a record via admin)

No AT Protocol preamble. Jump straight into doing. Explain concepts when they naturally arise.

**Project Structure** — Expanded annotated tree. Each directory gets 2-3 sentences and a link to the relevant guide. Replaces current page which lists directories without connecting them to workflows.

**Configuration** — `hatk.config.ts` reference. Each option with type, default, one-line description. Groups: server (relay, plc, port), database (engine, path), backfill (parallelism, signalCollections), oauth (issuer, scopes, clients). Minimal config example at top showing just the essentials. No DuckDB options.

### Guides

All guides follow the same pattern: what it does, minimal example, then details.

**Feeds** — `defineFeed()` with `generate` and `hydrate`. Statusphere "recent" feed as the example. Pagination with `ctx.paginate()`, hydration for author profiles. Most important guide.

**XRPC Handlers** — `defineQuery()` and `defineProcedure()` with typed context (`Ctx<K>`). `ctx.ok()` for return type enforcement. `ctx.db.query()` for direct SQL, `ctx.lookup()` for cross-collection joins.

**Auth & OAuth** — Rewritten from scratch. No `OAuthClient` class. Focus on: config (hatk.config.ts oauth section), built-in login/callback flow, `parseViewer(cookies)` in layouts, `login()`/`logout()` from `$hatk/client`, `getViewer()` in server code. Complete flow from config to working login.

**Seeds** — `seed()` helper with `createAccount`, `createRecord`, `uploadBlob`. Complete seed file example. `hatk seed` and `hatk reset` commands.

**Labels** — `defineLabel()` with `evaluate()`. Brief.

**OpenGraph** — `defineOG()` with Satori. Brief.

**Hooks** — `defineHook('on-login', ...)` with `ensureRepo`. One example.

### Frontend

**SvelteKit Setup** — Vite plugin (`hatk()` in vite.config.ts), `$hatk` and `$hatk/client` aliases, what the generated files contain, the `app/` directory convention. `hatk generate types` for regeneration.

**Data Loading** — `callXrpc()` from `$hatk/client`. Show in `+page.server.ts` (server-side bridge) and `+page.ts` (universal). `customFetch` for SvelteKit deduplication. `getViewer()` for current user in server code.

**Mutations** — Remote commands with SvelteKit experimental remote functions. `command('unchecked', ...)` pattern. Creating/deleting records via `callXrpc('dev.hatk.createRecord', ...)`. Optimistic UI updates.

### CLI & API Reference

Update to match current signatures. Remove DuckDB references. Add `customFetch` param, `parseViewer`, new generated client exports.

---

## Key Changes from Current Docs

- Drop all DuckDB references (SQLite only)
- Drop TanStack Query (use `callXrpc` directly)
- Drop `OAuthClient` class (use generated `login`/`logout`/`parseViewer`)
- Drop `api-client.md` guide (fold into Frontend section)
- Frontend gets its own top-level section
- Landing page gets project tree visualization
- All examples sourced from hatk-template-statusphere and hatk-template-teal
- Deployment guide updated for SQLite/Railway

## Source Material

- `~/code/hatk-template-statusphere` — simple reference app
- `~/code/hatk-template-teal` — complex reference app with feeds, bookmarks, search
- `~/code/hatk-template-start` — minimal starter
- `~/code/hatk/packages/hatk/src/cli.ts` — generated client output (auth helpers, parseViewer)
