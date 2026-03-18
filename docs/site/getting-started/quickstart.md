---
title: Quickstart
description: Create and run your first hatk project in under two minutes.
---

## Prerequisites

- **Node.js 22+** — check with `node --version`
- **Docker** — needed to run the local PDS (Personal Data Server) during development

## Create a new project

```bash
npx hatk new my-app
```

This scaffolds a full-stack project with a SvelteKit frontend, example feed, seed data, and everything wired together. The generated project includes:

```
my-app/
├── app/               # SvelteKit frontend (routes, components, styles)
├── server/            # Backend logic (feeds, XRPC handlers, hooks)
├── lexicons/          # AT Protocol schemas for your data types
├── seeds/             # Test fixture data for local development
├── hatk.config.ts     # Project configuration
├── hatk.generated.ts  # Auto-generated types from your lexicons
├── vite.config.ts     # Vite + SvelteKit config
└── docker-compose.yml # Local PDS for development
```

## Start the dev server

```bash
cd my-app
npm run dev
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
