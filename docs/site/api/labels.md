---
title: Labels
description: Label API endpoints.
---

## `dev.hatk.describeLabels`

List all available label definitions.

- **Type:** Query (GET)
- **Auth:** None
- **Parameters:** None

### Example

```bash
curl "http://127.0.0.1:3000/xrpc/dev.hatk.describeLabels"
```

### Response

```json
{
  "definitions": [
    {
      "identifier": "explicit",
      "severity": "alert",
      "blurs": "media",
      "defaultSetting": "warn"
    }
  ]
}
```

## `dev.hatk.createReport`

Report an account or record for moderation review. Reports appear in the admin interface for review.

- **Type:** Procedure (POST)
- **Auth:** Required (OAuth)

### Input

| Field     | Type   | Required | Description                                |
| --------- | ------ | -------- | ------------------------------------------ |
| `subject` | union  | Yes      | `{ did }` for accounts, `{ uri, cid }` for records |
| `label`   | string | Yes      | Label identifier (must match a defined label) |
| `reason`  | string | No       | Free-text explanation (max 2000 chars)     |

### Example

```bash
curl -X POST "http://127.0.0.1:3000/xrpc/dev.hatk.createReport" \
  -H "Authorization: DPoP <token>" \
  -H "Content-Type: application/json" \
  -d '{"subject": {"uri": "at://did:plc:abc/app.bsky.feed.post/123", "cid": "bafyrei..."}, "label": "spam"}'
```

### Response

```json
{
  "id": 1,
  "subject": { "uri": "at://did:plc:abc/app.bsky.feed.post/123", "cid": "bafyrei..." },
  "label": "spam",
  "reportedBy": "did:plc:reporter",
  "createdAt": "2026-03-24T12:00:00.000Z"
}
```

---

See [Labels guide](/guides/labels) for how to define labels and hydrate them in responses.
