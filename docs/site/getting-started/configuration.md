---
title: Configuration
description: Configure your Hatk project with hatk.config.ts.
---

## Overview

Hatk is configured through `hatk.config.ts` at the project root. The `defineConfig` helper provides type safety and autocompletion. Most options can be overridden with environment variables.

## Complete example

```typescript
import { defineConfig } from '@hatk/hatk/config'

export default defineConfig({
  relay: 'ws://localhost:2583',
  plc: 'http://localhost:2582',
  port: 3000,
  database: 'data/hatk.db',
  publicDir: './public',
  admins: [],

  backfill: {
    parallelism: 10,
    fetchTimeout: 300,
    maxRetries: 5,
    fullNetwork: false,
  },

  ftsRebuildInterval: 500,

  oauth: {
    issuer: 'http://127.0.0.1:3000',
    scopes: ['atproto'],
    clients: [
      {
        client_id: 'http://localhost',
        client_name: 'My App',
        redirect_uris: ['http://127.0.0.1:3000/oauth/callback'],
      },
    ],
  },
})
```

## Options

### `relay`

WebSocket URL for the AT Protocol firehose relay.

- **Default:** `ws://localhost:2583`
- **Env:** `RELAY`

In production, point this to a relay like `wss://bsky.network`.

### `plc`

PLC directory URL for DID resolution.

- **Default:** `https://plc.directory`
- **Env:** `DID_PLC_URL`

### `port`

HTTP port for the XRPC server.

- **Default:** `3000`
- **Env:** `PORT`

### `database`

DuckDB file path. Resolved relative to the config file directory.

- **Default:** `:memory:`
- **Env:** `DATABASE`

### `publicDir`

Directory for static files. Set to `null` to disable static file serving.

- **Default:** `./public`

### `collections`

Array of collection NSIDs to index. If empty, collections are auto-derived from your lexicon record definitions.

### `admins`

DIDs allowed to access `/admin/*` endpoints.

- **Default:** `[]`
- **Env:** `ADMINS` (comma-separated)

## Backfill

Controls how the server backfills historical data from the network.

| Option              | Default | Env                      | Description                                                             |
| ------------------- | ------- | ------------------------ | ----------------------------------------------------------------------- |
| `parallelism`       | `5`     | `BACKFILL_PARALLELISM`   | Concurrent repo fetches                                                 |
| `fetchTimeout`      | `300`   | `BACKFILL_FETCH_TIMEOUT` | Timeout per repo (seconds)                                              |
| `maxRetries`        | `5`     | `BACKFILL_MAX_RETRIES`   | Max retry attempts for failed repos                                     |
| `fullNetwork`       | `false` | `BACKFILL_FULL_NETWORK`  | Backfill the entire network                                             |
| `repos`             | —       | `BACKFILL_REPOS`         | Pin specific DIDs to backfill (comma-separated)                         |
| `signalCollections` | —       | —                        | Collections that trigger backfill (defaults to top-level `collections`) |

## Full-text search

### `ftsRebuildInterval`

Rebuild the FTS index every N writes. Lower values mean fresher search results but more CPU usage.

- **Default:** `500`
- **Env:** `FTS_REBUILD_INTERVAL`

## OAuth

Configure OAuth for authenticated endpoints. Set to `null` (or omit) to disable.

### `oauth.issuer`

The OAuth issuer URL. Typically your server's public URL.

- **Env:** `OAUTH_ISSUER`

### `oauth.scopes`

OAuth scopes to request. Defaults to `['atproto']`.

### `oauth.clients`

Array of allowed OAuth clients. Each client needs:

| Field           | Description             |
| --------------- | ----------------------- |
| `client_id`     | Client identifier URL   |
| `client_name`   | Human-readable name     |
| `redirect_uris` | Allowed redirect URIs   |
| `scope`         | Optional scope override |
