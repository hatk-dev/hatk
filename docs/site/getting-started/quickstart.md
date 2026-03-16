---
title: Quickstart
description: Create and run your first Hatk project.
---

## Prerequisites

- **Node.js 25+**
- **Docker** (for the local PDS)

## Create a new project

```bash
npx hatk new my-app
```

For a project with a Svelte frontend:

```bash
npx hatk new my-app --svelte
```

This scaffolds a project with the following structure:

```
my-app/
├── config.yaml
├── lexicons/
├── feeds/
├── xrpc/
├── og/
├── labels/
├── jobs/
├── seeds/
├── setup/
├── public/
├── test/
│   ├── feeds/
│   ├── xrpc/
│   ├── integration/
│   ├── browser/
│   └── fixtures/
└── hatk.generated.ts
```

## Start the dev server

```bash
cd my-app
npx hatk dev
```

This starts:

1. A local PDS via Docker
2. Runs your seed data
3. Starts the Hatk server with file watching

## Make your first request

```bash
curl http://localhost:3000/xrpc/dev.hatk.describeCollections
```

This returns the collections your server is indexing, derived from your lexicon schemas.

## Next steps

- [Project Structure](/getting-started/project-structure) — understand each file and directory
- [Configuration](/getting-started/configuration) — customize `config.yaml`
- [CLI Reference](/cli/) — all available commands
