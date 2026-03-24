---
title: API Overview
description: XRPC endpoints served by your Hatk server.
---

Hatk serves [XRPC](https://atproto.com/specs/xrpc) endpoints at `/xrpc/{nsid}`. All built-in endpoints use the `dev.hatk` namespace.

## Protocol

- **Queries** are GET requests with parameters in the query string
- **Procedures** are POST requests with JSON (or binary) request bodies
- All responses are JSON unless otherwise noted

## Authentication

hatk supports two authentication methods:

**Session cookies** (recommended for SvelteKit apps) -- `login()`, `logout()`, and `parseViewer()` from `$hatk/client` handle the full OAuth flow and store the session in an encrypted cookie. See the [Auth guide](/guides/auth).

**DPoP browser tokens** -- for direct XRPC calls from external clients, pass an OAuth DPoP bearer token in the `Authorization` header:

```
Authorization: DPoP <token>
```

Configure OAuth in your `hatk.config.ts` to enable authentication. See [Configuration](/getting-started/configuration).

## Client usage

The generated `callXrpc()` function from `$hatk/client` provides typed access to all endpoints:

```typescript
import { callXrpc } from "$hatk/client";

// Query (GET)
const { items, cursor } = await callXrpc("dev.hatk.getRecords", {
  collection: "fm.teal.alpha.feed.play",
  limit: 10,
});

// Procedure (POST)
const { uri, cid } = await callXrpc("dev.hatk.createRecord", {
  collection: "fm.teal.alpha.feed.play",
  repo: userDid,
  record: { createdAt: new Date().toISOString() },
});

// Pass SvelteKit's fetch for SSR deduplication
const data = await callXrpc("dev.hatk.getFeed", { feed: "recent" }, fetch);
```

The optional third parameter `customFetch` accepts a fetch function. Pass SvelteKit's `fetch` from load functions to enable request deduplication between server and client renders.

## Built-in endpoints

| Endpoint                             | Type      | Auth | Description                     |
| ------------------------------------ | --------- | ---- | ------------------------------- |
| [`getRecord`](/api/records)          | Query     | No   | Fetch a single record by AT URI |
| [`getRecords`](/api/records)         | Query     | No   | List records with filters       |
| [`createRecord`](/api/records)       | Procedure | Yes  | Create a record via user's PDS  |
| [`putRecord`](/api/records)          | Procedure | Yes  | Create or update a record       |
| [`deleteRecord`](/api/records)       | Procedure | Yes  | Delete a record                 |
| [`getFeed`](/api/feeds)              | Query     | No   | Retrieve a named feed           |
| [`describeFeeds`](/api/feeds)        | Query     | No   | List available feeds            |
| [`searchRecords`](/api/search)       | Query     | No   | Full-text search                |
| [`uploadBlob`](/api/blobs)           | Procedure | Yes  | Upload a binary blob            |
| [`getPreferences`](/api/preferences) | Query     | Yes  | Get user preferences            |
| [`putPreference`](/api/preferences)  | Procedure | Yes  | Set a preference                |
| [`describeLabels`](/api/labels)      | Query     | No   | List label definitions          |
| [`createReport`](/api/labels)        | Procedure | Yes  | Report an account or record     |
| `describeCollections`                | Query     | No   | List indexed collections        |
