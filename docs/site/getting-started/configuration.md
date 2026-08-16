---
title: Configuration
description: Configure your hatk project with hatk.config.ts.
---

hatk is configured through `hatk.config.ts` at the project root. The `defineConfig` helper provides type safety and autocompletion.

## Minimal example

Most projects only need a few options. Here is a minimal config that works for local development:

```typescript
import { defineConfig } from '@hatk/hatk/config'

export default defineConfig({
  port: 3000,
  database: 'data/hatk.db',
  oauth: {
    clients: [
      {
        client_id: 'http://127.0.0.1:3000/oauth-client-metadata.json',
        client_name: 'My App',
        redirect_uris: ['http://127.0.0.1:3000/oauth/callback'],
      },
    ],
  },
})
```

## Production example

A real-world config that switches between local and production settings:

```typescript
import { defineConfig } from '@hatk/hatk/config'

const isProd = process.env.NODE_ENV === 'production'
const prodDomain = process.env.RAILWAY_PUBLIC_DOMAIN

export default defineConfig({
  relay: isProd ? 'wss://bsky.network' : 'ws://localhost:2583',
  plc: isProd ? 'https://plc.directory' : 'http://localhost:2582',
  port: 3000,
  database: isProd ? '/data/hatk.db' : 'data/hatk.db',
  backfill: {
    parallelism: 5,
    signalCollections: ['xyz.statusphere.status'],
  },
  oauth: {
    issuer: isProd && prodDomain ? `https://${prodDomain}` : undefined,
    scopes: ['atproto'],
    clients: [
      ...(prodDomain
        ? [
            {
              client_id: `https://${prodDomain}/oauth-client-metadata.json`,
              client_name: 'My App',
              redirect_uris: [`https://${prodDomain}/oauth/callback`],
            },
          ]
        : []),
      {
        client_id: 'http://127.0.0.1:3000/oauth-client-metadata.json',
        client_name: 'My App',
        redirect_uris: ['http://127.0.0.1:3000/oauth/callback'],
      },
    ],
  },
})
```

## Server options

| Option               | Type             | Default                   | Env             | Description                                                                               |
| -------------------- | ---------------- | ------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `relay`              | `string`         | `'ws://localhost:2583'`   | `RELAY`         | WebSocket URL for the AT Protocol firehose relay. Use `wss://bsky.network` in production. |
| `jetstream`          | `object \| null` | `null`                    | `JETSTREAM_URL` | Consume a Jetstream v2 instance instead of `relay`. See below.                            |
| `plc`                | `string`         | `'https://plc.directory'` | `DID_PLC_URL`   | PLC directory URL for DID resolution. Use `http://localhost:2582` for local dev.          |
| `port`               | `number`         | `3000`                    | `PORT`          | HTTP port for the hatk backend server.                                                    |
| `publicDir`          | `string \| null` | `'./public'`              | --              | Directory for static files. Set to `null` to disable static file serving.                 |
| `collections`        | `string[]`       | `[]`                      | --              | Collection NSIDs to index. If empty, auto-derived from your lexicon record definitions.   |
| `privateCollections` | `string[]`       | `[]`                      | --              | Collection NSIDs to withhold from the built-in `dev.hatk.*` record endpoints. See below.  |
| `admins`             | `string[]`       | `[]`                      | `ADMINS`        | DIDs allowed to access `/admin/*` endpoints. Env var is comma-separated.                  |

### `jetstream`

Set `jetstream` to consume the stream from a [Jetstream v2](https://bsky.network/docs/jetstream)
instance instead of the relay firehose:

```ts
export default defineConfig({
  jetstream: isProd ? { url: 'wss://jetstream.us-east.bsky.network' } : null,
  relay: isProd ? 'wss://bsky.network' : 'ws://localhost:2583',
  // ...
})
```

The relay ships every commit on the network as DAG-CBOR frames wrapping a CAR
block store, so an app indexing three collections still pays to decode all of
them. Jetstream filters server-side by collection and delivers records as
already-decoded JSON, so you only receive and decode what you index.

Notes:

- **`relay` is still required.** It is the default source, and backfill resolves
  repos through it regardless of which stream you tail. A local PDS or
  self-hosted relay usually has no Jetstream in front of it, which is why this
  is opt-in rather than the default.
- **Each source keeps its own cursor.** Relay seqs and Jetstream seqs are
  different coordinate systems, so hatk stores them under separate `_cursor`
  rows. Switching sources — or switching back — resumes from the right place;
  it does not resume one stream from the other's offset.
- **Identity events are not collection-filtered.** Jetstream delivers
  `identity` regardless of your `collections` filter, so a niche app receives
  far more identity events than commits (observed: ~35:1). They are cheap —
  hatk ignores identity for DIDs it does not track — but the bandwidth saving
  applies to commits, not the whole stream.
- **Filter limits.** Jetstream accepts at most 100 collections and 10,000
  pinned DIDs. hatk fails at startup with an explicit message rather than
  letting the connection get rejected at the handshake.
- **Delivery is at-least-once** and the cursor is inclusive, so an event may
  arrive more than once across a reconnect. Writes upsert on each record's
  `at://` URI, so duplicates are harmless.

Backfill is unaffected: `getRepo` CAR imports still run against each repo's PDS.

### `privateCollections`

Collections listed here are still indexed, still typed, and still queryable
from your own feeds and XRPC handlers. They are only withheld from the
built-in generic record endpoints: `dev.hatk.getRecords`, `dev.hatk.getRecord`,
and `dev.hatk.searchRecords` return a 404 for them, indistinguishable from a
collection that doesn't exist, and `dev.hatk.describeCollections` omits them
from its list.

Admin-authenticated endpoints like `/admin/search` are not filtered by `privateCollections` and remain accessible to configured admins.

This is not an authorization mechanism. It does not protect your own handlers
or feeds — if a feed you write selects from a private collection and returns
it, that's on your feed, not on hatk. `privateCollections` only stops hatk
from serving the collection on your behalf through the generic endpoints.

```ts
export default defineConfig({
  privateCollections: ['social.switchback.activity'],
})
```

## Database options

| Option     | Type     | Default      | Env        | Description                                                                                                                  |
| ---------- | -------- | ------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `database` | `string` | `':memory:'` | `DATABASE` | SQLite database file path, resolved relative to the config file. Use an absolute path in production (e.g., `/data/hatk.db`). |

## Backfill options

The `backfill` object controls how the server catches up on historical data from the AT Protocol network.

| Option                       | Type       | Default | Env                      | Description                                                                                              |
| ---------------------------- | ---------- | ------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `backfill.parallelism`       | `number`   | `3`     | `BACKFILL_PARALLELISM`   | Number of concurrent repo fetches.                                                                       |
| `backfill.fetchTimeout`      | `number`   | `300`   | `BACKFILL_FETCH_TIMEOUT` | Timeout per repo fetch in seconds.                                                                       |
| `backfill.maxRetries`        | `number`   | `5`     | `BACKFILL_MAX_RETRIES`   | Max retry attempts for failed repo fetches.                                                              |
| `backfill.fullNetwork`       | `boolean`  | `false` | `BACKFILL_FULL_NETWORK`  | Backfill the entire network (not just repos that interact with your collections).                        |
| `backfill.repos`             | `string[]` | --      | `BACKFILL_REPOS`         | Pin specific DIDs to always backfill. Env var is comma-separated.                                        |
| `backfill.signalCollections` | `string[]` | --      | --                       | Collections that trigger a backfill when a new record appears. Defaults to your top-level `collections`. |

## Full-text search

| Option               | Type     | Default | Env                    | Description                                                                                                                                                                   |
| -------------------- | -------- | ------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ftsRebuildInterval` | `number` | `5000`  | `FTS_REBUILD_INTERVAL` | DuckDB only. Rebuild the FTS index every N writes. Lower values mean fresher search results but more CPU usage. SQLite uses incremental FTS updates and ignores this setting. |

## OAuth options

The `oauth` object configures AT Protocol OAuth for authenticated endpoints. Set to `null` or omit entirely to disable auth.

| Option             | Type                  | Default                     | Env            | Description                                                                                                                                                                 |
| ------------------ | --------------------- | --------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth.issuer`     | `string`              | `'http://127.0.0.1:{port}'` | `OAUTH_ISSUER` | The OAuth issuer URL. Typically your server's public URL.                                                                                                                   |
| `oauth.scopes`     | `string[]`            | `['atproto']`               | --             | OAuth scopes to request. Use [granular scopes](https://atproto.com/specs/oauth#scopes) to limit access (e.g., `'repo:xyz.statusphere.status?action=create&action=delete'`). |
| `oauth.clients`    | `OAuthClientConfig[]` | `[]`                        | --             | Allowed OAuth clients. Each entry needs `client_id`, `client_name`, and `redirect_uris`.                                                                                    |
| `oauth.cookieName` | `string`              | `'__hatk_session'`          | --             | Name of the session cookie.                                                                                                                                                 |

### OAuth client fields

Each entry in `oauth.clients` has:

| Field           | Type       | Required | Description                                                        |
| --------------- | ---------- | -------- | ------------------------------------------------------------------ |
| `client_id`     | `string`   | Yes      | Client identifier URL (points to your OAuth client metadata JSON). |
| `client_name`   | `string`   | Yes      | Human-readable name shown during the authorization flow.           |
| `redirect_uris` | `string[]` | Yes      | Allowed redirect URIs after authorization.                         |
| `scope`         | `string`   | No       | Scope override for this specific client.                           |

## Environment variable overrides

Every option that lists an **Env** column can be set via environment variables. Environment variables take precedence over values in `hatk.config.ts`. This is useful for production deployments where you set secrets and infrastructure-specific values through your hosting platform's environment configuration.
