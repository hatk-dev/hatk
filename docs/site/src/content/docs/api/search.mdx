---
title: Search
description: Search API endpoints.
---

## `dev.hatk.searchRecords`

Full-text search across a collection using DuckDB's FTS extension with BM25 ranking.

- **Type:** Query (GET)
- **Auth:** None

### Parameters

| Name         | Type    | Required | Default | Description               |
| ------------ | ------- | -------- | ------- | ------------------------- |
| `collection` | string  | Yes      | —       | Collection NSID to search |
| `q`          | string  | Yes      | —       | Search query              |
| `limit`      | integer | No       | `20`    | Results per page (1–100)  |
| `cursor`     | string  | No       | —       | Pagination cursor         |
| `fuzzy`      | boolean | No       | `true`  | Enable fuzzy matching     |

### Example

```bash
curl "http://localhost:3000/xrpc/dev.hatk.searchRecords?collection=fm.teal.alpha.feed.play&q=radiohead"
```

```typescript
const { items, cursor } = await api.query('dev.hatk.searchRecords', {
  collection: 'fm.teal.alpha.feed.play',
  q: 'radiohead',
})
```

### Response

```json
{
  "items": [ ... ],
  "cursor": "..."
}
```

### How it works

Hatk builds a DuckDB full-text search index for each collection. The index is rebuilt periodically based on the `ftsRebuildInterval` config option (default: every 500 writes).

Search uses BM25 ranking to order results by relevance. The `fuzzy` parameter (enabled by default) allows approximate matching for typos and partial terms.

String fields in your record lexicon definitions are automatically included in the FTS index.
