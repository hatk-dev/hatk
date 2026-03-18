# Docs Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite all hatk documentation to reflect the current API (generated client, SQLite-only, SvelteKit remote commands, `parseViewer`/`login`/`logout` from `$hatk/client`).

**Architecture:** VitePress site at `docs/site/`. Rewrite every page in-place, add new `frontend/` section, update nav config. Source examples from `~/code/hatk-template-statusphere` and `~/code/hatk-template-teal`.

**Tech Stack:** VitePress, Markdown, TypeScript code blocks

**Design doc:** `docs/plans/2026-03-18-docs-overhaul-design.md`

---

## Batch 1: Foundation (config + landing page + nav)

### Task 1: Update VitePress config and nav

**Files:**
- Modify: `docs/site/.vitepress/config.ts`

**Step 1: Rewrite the config**

Replace the full config with updated nav and sidebar. Add Frontend section, remove api-client, rename OAuth → Auth & OAuth, remove Deployment from guides (move to CLI build page).

```ts
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'hatk',
  description: 'Build AT Protocol applications with typed XRPC endpoints.',

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started/quickstart' },
      { text: 'Frontend', link: '/frontend/setup' },
      { text: 'CLI', link: '/cli/' },
      { text: 'API', link: '/api/' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Quickstart', link: '/getting-started/quickstart' },
          { text: 'Project Structure', link: '/getting-started/project-structure' },
          { text: 'Configuration', link: '/getting-started/configuration' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Feeds', link: '/guides/feeds' },
          { text: 'XRPC Handlers', link: '/guides/xrpc-handlers' },
          { text: 'Auth & OAuth', link: '/guides/auth' },
          { text: 'Seeds', link: '/guides/seeds' },
          { text: 'Labels', link: '/guides/labels' },
          { text: 'OpenGraph', link: '/guides/opengraph' },
          { text: 'Hooks', link: '/guides/hooks' },
        ],
      },
      {
        text: 'Frontend',
        items: [
          { text: 'SvelteKit Setup', link: '/frontend/setup' },
          { text: 'Data Loading', link: '/frontend/data-loading' },
          { text: 'Mutations', link: '/frontend/mutations' },
        ],
      },
      {
        text: 'CLI Reference',
        items: [
          { text: 'Overview', link: '/cli/' },
          { text: 'Scaffolding', link: '/cli/scaffold' },
          { text: 'Development', link: '/cli/development' },
          { text: 'Testing', link: '/cli/testing' },
          { text: 'Build & Deploy', link: '/cli/build' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Overview', link: '/api/' },
          { text: 'Records', link: '/api/records' },
          { text: 'Feeds', link: '/api/feeds' },
          { text: 'Search', link: '/api/search' },
          { text: 'Blobs', link: '/api/blobs' },
          { text: 'Preferences', link: '/api/preferences' },
          { text: 'Labels', link: '/api/labels' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/bigmoves/hatk' }],
  },
})
```

**Step 2: Verify**

Run: `cd docs/site && npx vitepress build 2>&1 | tail -5`
Expected: Build succeeds (some dead links expected until pages are written)

**Step 3: Commit**

```bash
git add docs/site/.vitepress/config.ts
git commit -m "docs: update nav structure for docs overhaul"
```

### Task 2: Rewrite landing page

**Files:**
- Modify: `docs/site/index.md`

**Step 1: Rewrite with project tree and feature cards**

```markdown
---
layout: home

hero:
  name: hatk
  tagline: Build AT Protocol apps with typed XRPC endpoints.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/quickstart
    - theme: alt
      text: CLI Reference
      link: /cli/

features:
  - title: Typed end-to-end
    details: Lexicons generate TypeScript types for records, queries, and feeds. Your editor catches mistakes before your users do.
  - title: SQLite by default
    details: No external database to configure. Data lives in a single file that just works — locally and in production.
  - title: OAuth built-in
    details: AT Protocol auth with session cookies. Login, logout, and viewer resolution with zero setup.
  - title: SvelteKit-first
    details: Full-stack with SSR, remote commands, and typed XRPC calls from a generated client.
---

## Project Structure

A hatk app looks like this:

```
my-app/
├── app/                        # SvelteKit frontend
│   ├── routes/
│   │   ├── +layout.server.ts   # parseViewer(cookies)
│   │   └── +page.svelte        # Your UI
│   └── lib/
├── server/                     # Backend handlers
│   ├── feeds/                  # Feed generators
│   │   └── recent.ts           # defineFeed({ ... })
│   └── xrpc/                   # Custom XRPC endpoints
│       └── getProfile.ts       # defineQuery('...', ...)
├── seeds/
│   └── seed.ts                 # Test fixture data
├── lexicons/                   # AT Protocol schemas (like Prisma models)
├── hatk.config.ts              # Server configuration
└── hatk.generated.ts           # Auto-generated types from lexicons
```
```

**Step 2: Commit**

```bash
git add docs/site/index.md
git commit -m "docs: rewrite landing page with project tree and features"
```

---

## Batch 2: Getting Started (3 pages)

### Task 3: Rewrite quickstart

**Files:**
- Modify: `docs/site/getting-started/quickstart.md`

Rewrite to reflect current CLI (`hatk new` with `--svelte` default, `npm run dev` instead of `npx hatk dev`, `hatk.config.ts` not `config.yaml`). Steps:

1. Prerequisites (Node 22+, Docker for local dev)
2. `npx hatk new my-app` — show the project it creates
3. `cd my-app && npm run dev` — starts PDS, seeds, dev server
4. Open `http://localhost:5173`, see the app
5. Next steps links

Source accurate project structure from `~/code/hatk-template-statusphere`. Reference `hatk.config.ts` not `config.yaml`. No DuckDB mentions.

**Step 1: Rewrite the page**
**Step 2: Commit**

```bash
git add docs/site/getting-started/quickstart.md
git commit -m "docs: rewrite quickstart for current CLI and project structure"
```

### Task 4: Rewrite project structure

**Files:**
- Modify: `docs/site/getting-started/project-structure.md`

Expanded annotated tree matching actual template layout:
- `app/` — SvelteKit frontend, routes, lib
- `server/` — feeds, xrpc handlers, hooks, labels, og, setup
- `seeds/` — test fixtures
- `lexicons/` — AT Protocol schemas with brief explanation
- `hatk.config.ts` — link to configuration page
- `hatk.generated.ts` / `hatk.generated.client.ts` — what they contain
- `vite.config.ts`, `svelte.config.js`, `tsconfig.json` — brief notes

Each directory gets 2-3 sentences and a link to the relevant guide.

**Step 1: Rewrite the page**
**Step 2: Commit**

```bash
git add docs/site/getting-started/project-structure.md
git commit -m "docs: rewrite project structure with annotated tree"
```

### Task 5: Rewrite configuration

**Files:**
- Modify: `docs/site/getting-started/configuration.md`

Reference: read `~/code/hatk/packages/hatk/src/cli.ts` for the config type definition, and `~/code/hatk-template-statusphere/hatk.config.ts` for a real example.

Structure:
1. Minimal config example at top
2. Full reference table grouped by: Server, Database, Backfill, OAuth
3. Each option: name, type, default, description
4. No DuckDB options. No `config.yaml` references.

**Step 1: Rewrite the page**
**Step 2: Commit**

```bash
git add docs/site/getting-started/configuration.md
git commit -m "docs: rewrite configuration for hatk.config.ts"
```

---

## Batch 3: Guides — core (3 pages)

### Task 6: Rewrite feeds guide

**Files:**
- Modify: `docs/site/guides/feeds.md`

Source examples from `~/code/hatk-template-statusphere/server/recent.ts` and `~/code/hatk-template-teal/server/feeds/`. Replace all DuckDB references with SQLite. Keep the `generate`/`hydrate` context tables but update them.

Pattern: what feeds do → minimal example → `generate` context reference → `paginate` helper → `hydrate` context reference → full example with hydration.

**Step 1: Rewrite the page**
**Step 2: Commit**

```bash
git add docs/site/guides/feeds.md
git commit -m "docs: rewrite feeds guide with SQLite examples"
```

### Task 7: Rewrite XRPC handlers guide

**Files:**
- Modify: `docs/site/guides/xrpc-handlers.md`

Source examples from `~/code/hatk-template-teal/server/xrpc/`. Cover `defineQuery()` and `defineProcedure()` with typed `Ctx<K>`. Show `ctx.ok()`, `ctx.db.query()`, `ctx.lookup()`, `ctx.viewer`.

**Step 1: Read current page and template examples**
**Step 2: Rewrite the page**
**Step 3: Commit**

```bash
git add docs/site/guides/xrpc-handlers.md
git commit -m "docs: rewrite XRPC handlers guide"
```

### Task 8: Rewrite auth guide (rename oauth.md → auth.md)

**Files:**
- Create: `docs/site/guides/auth.md`
- Delete: `docs/site/guides/oauth.md`
- Delete: `docs/site/guides/api-client.md`
- Delete: `docs/site/guides/frontend.md`

Complete rewrite. No `OAuthClient` class. Structure:
1. Overview — hatk handles OAuth server-side with session cookies
2. Config — `hatk.config.ts` oauth section with scopes and clients
3. Frontend auth — `login(handle)` and `logout()` from `$hatk/client`
4. Server-side — `parseViewer(cookies)` in `+layout.server.ts`, `getViewer()` in handlers, `ctx.viewer`
5. Complete example showing config → layout → login form → protected route

Source from `~/code/hatk-template-statusphere` for the simple case.

Also delete `api-client.md` and `frontend.md` since their content moves to the new Frontend section.

**Step 1: Write new auth.md**
**Step 2: Delete old files**
**Step 3: Commit**

```bash
git add docs/site/guides/auth.md
git rm docs/site/guides/oauth.md docs/site/guides/api-client.md docs/site/guides/frontend.md
git commit -m "docs: rewrite auth guide, remove obsolete oauth/api-client/frontend pages"
```

---

## Batch 4: Guides — remaining (4 pages)

### Task 9: Rewrite seeds guide

**Files:**
- Modify: `docs/site/guides/seeds.md`

Source from `~/code/hatk-template-statusphere/seeds/seed.ts` and `~/code/hatk-template-teal/seeds/seed.ts`. Show `seed()` with `createAccount`, `createRecord`, `uploadBlob`. Mention `hatk seed` and `hatk reset`.

**Step 1: Rewrite the page**
**Step 2: Commit**

```bash
git add docs/site/guides/seeds.md
git commit -m "docs: rewrite seeds guide"
```

### Task 10: Rewrite labels guide

**Files:**
- Modify: `docs/site/guides/labels.md`

Brief. Show `defineLabels()` with `evaluate()`. Source from actual label files if they exist in templates, otherwise from CLI scaffolding output.

**Step 1: Read current page and find examples**
**Step 2: Rewrite the page**
**Step 3: Commit**

```bash
git add docs/site/guides/labels.md
git commit -m "docs: rewrite labels guide"
```

### Task 11: Rewrite opengraph guide

**Files:**
- Modify: `docs/site/guides/opengraph.md`

Brief. Show `defineOG()` with Satori rendering. Source from template OG files.

**Step 1: Read current page and find examples**
**Step 2: Rewrite the page**
**Step 3: Commit**

```bash
git add docs/site/guides/opengraph.md
git commit -m "docs: rewrite opengraph guide"
```

### Task 12: Rewrite hooks guide

**Files:**
- Modify: `docs/site/guides/hooks.md`

Brief. Show `defineHook('on-login', ...)` with `ensureRepo`. One example from templates.

**Step 1: Rewrite the page**
**Step 2: Commit**

```bash
git add docs/site/guides/hooks.md
git commit -m "docs: rewrite hooks guide"
```

---

## Batch 5: Frontend section (3 new pages)

### Task 13: Write frontend/setup page

**Files:**
- Create: `docs/site/frontend/setup.md`

Cover:
- Vite plugin (`hatk()` in `vite.config.ts`)
- `$hatk` and `$hatk/client` aliases
- What `hatk.generated.ts` vs `hatk.generated.client.ts` contain
- The `app/` directory convention (`svelte.config.js` files.src)
- `hatk generate types` for regeneration after lexicon changes

Source from `~/code/hatk-template-statusphere/vite.config.ts` and `svelte.config.js`.

**Step 1: Write the page**
**Step 2: Commit**

```bash
git add docs/site/frontend/setup.md
git commit -m "docs: add frontend setup page"
```

### Task 14: Write frontend/data-loading page

**Files:**
- Create: `docs/site/frontend/data-loading.md`

Cover:
- `callXrpc()` from `$hatk/client`
- Server load (`+page.server.ts`) — uses bridge directly
- Universal load (`+page.ts`) — works both sides
- `customFetch` parameter for SvelteKit's fetch deduplication
- `getViewer()` for accessing current user in server code

Source from `~/code/hatk-template-statusphere/app/routes/+page.server.ts` and `~/code/hatk-template-teal/app/routes/+page.ts`.

**Step 1: Write the page**
**Step 2: Commit**

```bash
git add docs/site/frontend/data-loading.md
git commit -m "docs: add frontend data loading page"
```

### Task 15: Write frontend/mutations page

**Files:**
- Create: `docs/site/frontend/mutations.md`

Cover:
- Remote commands with `command('unchecked', ...)`
- `callXrpc('dev.hatk.createRecord', ...)` and `deleteRecord`
- Optimistic UI pattern

Source from `~/code/hatk-template-statusphere/app/routes/status.remote.ts`.

**Step 1: Write the page**
**Step 2: Commit**

```bash
git add docs/site/frontend/mutations.md
git commit -m "docs: add frontend mutations page"
```

---

## Batch 6: CLI and API reference updates

### Task 16: Update CLI pages

**Files:**
- Modify: `docs/site/cli/index.md`
- Modify: `docs/site/cli/scaffold.md`
- Modify: `docs/site/cli/development.md`
- Modify: `docs/site/cli/testing.md`
- Modify: `docs/site/cli/build.md`

Read each page, update references: `config.yaml` → `hatk.config.ts`, remove DuckDB mentions, update command outputs to match current CLI. Add deployment info (SQLite/Railway) to `build.md`. Reference current CLI help output from `hatk --help`.

**Step 1: Read all 5 CLI pages**
**Step 2: Update each page**
**Step 3: Commit**

```bash
git add docs/site/cli/
git commit -m "docs: update CLI reference pages"
```

### Task 17: Update API reference pages

**Files:**
- Modify: `docs/site/api/index.md`
- Modify: `docs/site/api/records.md`
- Modify: `docs/site/api/feeds.md`
- Modify: `docs/site/api/search.md`
- Modify: `docs/site/api/blobs.md`
- Modify: `docs/site/api/preferences.md`
- Modify: `docs/site/api/labels.md`

Read each page, update to match current XRPC signatures. Remove DuckDB references. Update authentication section to reference session cookies instead of DPoP browser tokens. Add `customFetch` where relevant.

**Step 1: Read all 7 API pages**
**Step 2: Update each page**
**Step 3: Commit**

```bash
git add docs/site/api/
git commit -m "docs: update API reference pages"
```

---

## Batch 7: Final cleanup and verify

### Task 18: Delete obsolete files and verify build

**Files:**
- Delete: `docs/site/guides/deployment.md` (if not already moved to cli/build.md)

**Step 1: Check for any remaining dead links or old references**

Run: `cd docs/site && grep -r "DuckDB\|duckdb\|config\.yaml\|OAuthClient\|@hatk/oauth-client\|TanStack\|tanstack" --include="*.md" .`
Expected: No matches

**Step 2: Build the docs site**

Run: `cd docs/site && npx vitepress build`
Expected: Build succeeds with no errors

**Step 3: Commit any remaining cleanup**

```bash
git add -A docs/site/
git commit -m "docs: final cleanup, remove dead references"
```
