---
title: Feeds
description: Feed API endpoints.
---

## `dev.hatk.getFeed`

Retrieve a named feed of items.

- **Type:** Query (GET)
- **Auth:** None

### Parameters

| Name     | Type    | Required | Default | Description              |
| -------- | ------- | -------- | ------- | ------------------------ |
| `feed`   | string  | Yes      | —       | Feed name                |
| `limit`  | integer | No       | `30`    | Results per page (1–100) |
| `cursor` | string  | No       | —       | Pagination cursor        |

### Example

```bash
curl "http://localhost:3000/xrpc/dev.hatk.getFeed?feed=recent&limit=20"
```

```typescript
const { items, cursor } = await api.query('dev.hatk.getFeed', {
  feed: 'recent',
  limit: 20,
})
```

### Response

```json
{
  "items": [ ... ],
  "cursor": "..."
}
```

---

## `dev.hatk.describeFeeds`

List all available feeds.

- **Type:** Query (GET)
- **Auth:** None
- **Parameters:** None

### Example

```bash
curl "http://localhost:3000/xrpc/dev.hatk.describeFeeds"
```

### Response

```json
{
  "feeds": [
    { "name": "recent", "label": "Recent" },
    { "name": "popular", "label": "Popular" }
  ]
}
```

---

See [Feeds guide](/guides/feeds) for how to define feeds with `defineFeed()`.
