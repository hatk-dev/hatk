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

Authenticated endpoints require an OAuth DPoP bearer token in the `Authorization` header:

```
Authorization: DPoP <token>
```

Configure OAuth in your `config.yaml` to enable authentication. See [Configuration](/getting-started/configuration).

## Client usage

The generated client provides typed methods for all endpoints:

```typescript
// Query (GET)
const result = await api.query('dev.hatk.getRecords', {
  collection: 'fm.teal.alpha.feed.play',
  limit: 10,
})

// Procedure (POST)
const result = await api.call('dev.hatk.createRecord', {
  collection: 'fm.teal.alpha.feed.play',
  repo: userDid,
  record: { createdAt: new Date().toISOString() },
})

// Upload binary data
const result = await api.upload(file)
```

## Built-in endpoints

| Endpoint                              | Type      | Auth | Description                     |
| ------------------------------------- | --------- | ---- | ------------------------------- |
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
| `describeCollections`                 | Query     | No   | List indexed collections        |
