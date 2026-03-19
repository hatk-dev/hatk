---
title: Project Structure
description: Understand the files and directories in a hatk project.
---

After running `npx hatk new`, your project looks like this:

```
my-app/
├── app/                        # SvelteKit frontend
│   ├── app.html                #   HTML shell
│   ├── app.css                 #   Global styles
│   ├── lib/                    #   Shared utilities
│   └── routes/                 #   SvelteKit routes
│       ├── +layout.svelte      #     Root layout
│       ├── +layout.server.ts   #     Server-side layout data
│       ├── +page.svelte        #     Home page
│       └── oauth/callback/
│           └── +page.svelte    #     OAuth redirect target
├── server/                     # Backend logic
│   ├── recent.ts               #   Feed generator
│   ├── get-profile.ts          #   XRPC query handler
│   └── on-login.ts             #   Lifecycle hook
├── lexicons/                   # AT Protocol schemas
│   ├── xyz/statusphere/
│   │   ├── status.json         #   Custom record type
│   │   └── getProfile.json     #   Custom query endpoint
│   └── app/bsky/actor/
│       └── profile.json        #   Bluesky profile (to index)
├── seeds/
│   └── seed.ts                 # Test fixture data
├── test/
│   ├── feeds/                  #   Feed unit tests
│   ├── xrpc/                   #   XRPC handler tests
│   ├── browser/                #   Playwright browser tests
│   └── fixtures/               #   Test data (YAML files)
├── db/
│   └── schema.sql              # Custom SQL migrations
├── hatk.config.ts              # Project configuration
├── hatk.generated.ts           # Generated types (server)
├── hatk.generated.client.ts    # Generated types (client)
├── vite.config.ts              # Vite + SvelteKit config
├── svelte.config.js            # SvelteKit adapter config
├── docker-compose.yml          # Local PDS for development
├── Dockerfile                  # Production container build
├── tsconfig.json               # TypeScript config (app)
└── tsconfig.server.json        # TypeScript config (server)
```

---

## `app/` -- SvelteKit frontend

The `app/` directory is a standard SvelteKit application. Routes live in `app/routes/`, shared code goes in `app/lib/`. The `svelte.config.js` maps `app/` as the SvelteKit source directory (instead of the default `src/`).

Auth helpers for login, logout, and reading the current viewer are imported from `$hatk/client`. Data fetching uses `callXrpc()` from the same import to call your backend's typed endpoints.

See the [Frontend section](/frontend/setup) for details on routing, data loading, and mutations.

## `server/` -- backend logic

The `server/` directory contains all your backend code. hatk auto-discovers files in this directory and registers them based on their exports:

- **Feeds** -- files that export `defineFeed()` become feed generators, queryable via `dev.hatk.getFeed`
- **XRPC handlers** -- files that export `defineQuery()` or `defineProcedure()` become typed API endpoints
- **Hooks** -- files named `on-login.ts` fire after OAuth authentication
- **OG images** -- files in `server/og/` generate dynamic OpenGraph images via satori
- **Setup scripts** -- files in `server/setup/` run at boot time for custom migrations or data imports
- **Labels** -- files in `server/labels/` define content moderation rules

Files prefixed with `_` (like `_helpers.ts`) are ignored by auto-discovery, so use that convention for shared utilities.

See the guides for [Feeds](/guides/feeds), [XRPC Handlers](/guides/xrpc-handlers), [Hooks](/guides/hooks), [OpenGraph](/guides/opengraph), and [Labels](/guides/labels).

## `lexicons/` -- AT Protocol schemas

Lexicons are JSON schemas that define your data model for the AT Protocol. They describe records (data types stored in user repositories), queries (GET endpoints), and procedures (POST endpoints).

```
lexicons/
├── xyz/statusphere/
│   ├── status.json         # Record: a status emoji
│   └── getProfile.json     # Query: get a user's profile
└── app/bsky/actor/
    └── profile.json        # Bluesky's profile record (to index)
```

Lexicons drive two things automatically:
1. **Database tables** -- hatk creates SQLite tables for each record type
2. **TypeScript types** -- `hatk generate types` produces typed helpers in `hatk.generated.ts`

Organized by reverse-DNS namespace (e.g., `xyz/statusphere/status.json` for the `xyz.statusphere.status` collection).

## `seeds/` -- test fixture data

The `seeds/seed.ts` file creates test accounts and records against the local PDS during development. It runs automatically when you `npm run dev`, or manually with `hatk seed`.

Seeds use the AT Protocol API to create real data -- accounts, records, follows -- so your app has something to display during development without connecting to the live network.

See the [Seeds guide](/guides/seeds).

## `test/` -- tests

Tests are organized by type:

| Directory        | Purpose                        | Runner     |
| ---------------- | ------------------------------ | ---------- |
| `test/feeds/`    | Feed generator unit tests      | Vitest     |
| `test/xrpc/`    | XRPC handler tests             | Vitest     |
| `test/browser/`  | End-to-end browser tests       | Playwright |
| `test/fixtures/` | Shared YAML test data          | --         |

Run tests with `npm run test` (unit/integration) or `npm run test:browser` (Playwright).

## `hatk.config.ts` -- configuration

The main configuration file. Controls the relay connection, database path, backfill settings, OAuth, and more. Uses `defineConfig()` for type safety.

See the [Configuration page](/getting-started/configuration) for all options.

## `hatk.generated.ts` / `hatk.generated.client.ts`

Auto-generated TypeScript derived from your lexicon schemas. Do not edit these files directly.

- **`hatk.generated.ts`** -- server-side types and helpers: `defineFeed()`, `defineQuery()`, `defineProcedure()`, `seed()`, typed record interfaces, and view types
- **`hatk.generated.client.ts`** -- client-safe subset: `callXrpc()` for typed API calls, `login()`/`logout()`/`parseViewer()` for auth, plus re-exported types

Regenerate both with:

```bash
npx hatk generate types
```

## `vite.config.ts` / `svelte.config.js`

- **`vite.config.ts`** -- loads the `hatk()` Vite plugin (which proxies API routes to the hatk backend during development) and the `sveltekit()` plugin. Also configures test includes/excludes.
- **`svelte.config.js`** -- sets `app/` as the SvelteKit source directory and configures the `$hatk` and `$hatk/client` import aliases that point to the generated files.

## `db/schema.sql`

Optional custom SQL that runs after hatk creates its auto-generated tables. Use this for custom indexes, views, or tables that go beyond what lexicons define.

## `docker-compose.yml` / `Dockerfile`

- **`docker-compose.yml`** -- runs a local PDS and PLC directory for development. Started automatically by `npm run dev`.
- **`Dockerfile`** -- production container build for deployment.

## Runtime files

The `data/` directory is created at runtime and contains the SQLite database (`hatk.db`). It is gitignored by default.

```
data/
└── hatk.db
```
