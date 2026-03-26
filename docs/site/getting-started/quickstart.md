---
title: Quickstart
description: Create and run your first hatk project in under two minutes.
---

## Prerequisites

- **Vite+** — install with `curl -fsSL https://vite.plus | bash` (or `irm https://vite.plus/ps1 | iex` on Windows)
- **Docker** — needed to run the local PDS (Personal Data Server) during development

Vite+ manages Node.js and your package manager automatically. Run `vp help` to verify it's installed.

## Create a new project

```bash
vp create github:hatk-dev/hatk-template-starter
```

This scaffolds a full-stack project with a SvelteKit frontend, OAuth login, seed data, and everything wired together. The generated project includes:

```
my-appview/
├── app/                        # SvelteKit frontend (routes, components, styles)
├── server/                     # Backend logic (hooks, feeds, XRPC handlers)
├── lexicons/                   # AT Protocol schemas for your data types
├── seeds/                      # Test fixture data for local development
├── db/                         # Database reference schemas
├── hatk.config.ts              # Project configuration
├── hatk.generated.ts           # Auto-generated types (server)
├── hatk.generated.client.ts    # Auto-generated types (client)
├── vite.config.ts              # Vite+ / SvelteKit config
├── svelte.config.js            # SvelteKit adapter config
├── tsconfig.json               # TypeScript config (app)
├── tsconfig.server.json        # TypeScript config (server)
└── docker-compose.yml          # Local PLC directory and PDS for development
```

## Start the dev server

```bash
cd my-appview
npx svelte-kit sync
vp dev
```

This does three things automatically:

1. Starts a local PDS via Docker (your own mini AT Protocol server)
2. Runs seed data to create test accounts and records
3. Starts the hatk backend and SvelteKit dev server with hot reload

## See it running

Open `http://127.0.0.1:3000` in your browser. You should see the starter app running with seeded data. Both the frontend and API are served on the same port.

Try hitting an endpoint directly:

```bash
curl http://127.0.0.1:3000/xrpc/dev.hatk.describeCollections
```

This returns the data collections your server is indexing, derived from your lexicon schemas.

## Next steps

- [Project Structure](/getting-started/project-structure) -- understand each file and directory
- [Configuration](/getting-started/configuration) -- customize `hatk.config.ts`
- [Feeds](/guides/feeds) -- build custom feed algorithms
- [Auth](/guides/auth) -- add login and authenticated actions
