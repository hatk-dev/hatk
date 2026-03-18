---
title: Records
description: Create, read, update, and delete AT Protocol records.
---

## `dev.hatk.getRecord`

Fetch a single record by its AT URI.

- **Type:** Query (GET)
- **Auth:** None

### Parameters

| Name  | Type            | Required | Description              |
| ----- | --------------- | -------- | ------------------------ |
| `uri` | string (AT URI) | Yes      | The AT URI of the record |

### Example

```bash
curl "http://127.0.0.1:3000/xrpc/dev.hatk.getRecord?uri=at://did:plc:abc/fm.teal.alpha.feed.play/123"
```

```typescript
import { callXrpc } from "$hatk/client";

const { record } = await callXrpc("dev.hatk.getRecord", {
  uri: "at://did:plc:abc/fm.teal.alpha.feed.play/123",
});
```

### Response

```json
{
  "record": { ... }
}
```

---

## `dev.hatk.getRecords`

List records from a collection with optional filters and pagination.

- **Type:** Query (GET)
- **Auth:** None

### Parameters

| Name         | Type    | Required | Default | Description              |
| ------------ | ------- | -------- | ------- | ------------------------ |
| `collection` | string  | Yes      | —       | Collection NSID          |
| `limit`      | integer | No       | `20`    | Results per page (1–100) |
| `cursor`     | string  | No       | —       | Pagination cursor        |
| `sort`       | string  | No       | —       | Sort field               |
| `order`      | string  | No       | —       | Sort order               |

Additional filter parameters are accepted based on the collection's schema — any field defined in the record lexicon can be used as a query parameter.

### Example

```bash
curl "http://127.0.0.1:3000/xrpc/dev.hatk.getRecords?collection=fm.teal.alpha.feed.play&limit=10"
```

```typescript
import { callXrpc } from "$hatk/client";

const { items, cursor } = await callXrpc("dev.hatk.getRecords", {
  collection: "fm.teal.alpha.feed.play",
  limit: 10,
});
```

### Response

```json
{
  "items": [ ... ],
  "cursor": "..."
}
```

---

## `dev.hatk.createRecord`

Create a record via the authenticated user's PDS.

- **Type:** Procedure (POST)
- **Auth:** Required (session cookie or DPoP token)

### Input

| Name         | Type         | Required | Description     |
| ------------ | ------------ | -------- | --------------- |
| `collection` | string       | Yes      | Collection NSID |
| `repo`       | string (DID) | Yes      | The user's DID  |
| `record`     | object       | Yes      | The record data |

### Example

```bash
curl -X POST "http://127.0.0.1:3000/xrpc/dev.hatk.createRecord" \
  -H "Authorization: DPoP <token>" \
  -H "Content-Type: application/json" \
  -d '{"collection":"fm.teal.alpha.feed.play","repo":"did:plc:abc","record":{"createdAt":"2025-01-01T00:00:00Z"}}'
```

```typescript
import { callXrpc } from "$hatk/client";

const { uri, cid } = await callXrpc("dev.hatk.createRecord", {
  collection: "fm.teal.alpha.feed.play",
  repo: userDid,
  record: { createdAt: new Date().toISOString() },
})
```

### Response

```json
{
  "uri": "at://did:plc:abc/fm.teal.alpha.feed.play/123",
  "cid": "bafyrei..."
}
```

---

## `dev.hatk.putRecord`

Create or update a record at a specific rkey via the authenticated user's PDS.

- **Type:** Procedure (POST)
- **Auth:** Required (session cookie or DPoP token)

### Input

| Name         | Type         | Required | Description                                    |
| ------------ | ------------ | -------- | ---------------------------------------------- |
| `collection` | string       | Yes      | Collection NSID                                |
| `rkey`       | string       | Yes      | Record key                                     |
| `record`     | object       | Yes      | The record data                                |
| `repo`       | string (DID) | No       | The user's DID (inferred from auth if omitted) |

### Example

```bash
curl -X POST "http://127.0.0.1:3000/xrpc/dev.hatk.putRecord" \
  -H "Authorization: DPoP <token>" \
  -H "Content-Type: application/json" \
  -d '{"collection":"fm.teal.alpha.feed.play","rkey":"self","record":{"createdAt":"2025-01-01T00:00:00Z"}}'
```

```typescript
import { callXrpc } from "$hatk/client";

const { uri, cid } = await callXrpc("dev.hatk.putRecord", {
  collection: "fm.teal.alpha.feed.play",
  rkey: "self",
  record: { createdAt: new Date().toISOString() },
});
```

### Response

```json
{
  "uri": "at://did:plc:abc/fm.teal.alpha.feed.play/self",
  "cid": "bafyrei..."
}
```

---

## `dev.hatk.deleteRecord`

Delete a record via the authenticated user's PDS.

- **Type:** Procedure (POST)
- **Auth:** Required (session cookie or DPoP token)

### Input

| Name         | Type   | Required | Description     |
| ------------ | ------ | -------- | --------------- |
| `collection` | string | Yes      | Collection NSID |
| `rkey`       | string | Yes      | Record key      |

### Example

```bash
curl -X POST "http://127.0.0.1:3000/xrpc/dev.hatk.deleteRecord" \
  -H "Authorization: DPoP <token>" \
  -H "Content-Type: application/json" \
  -d '{"collection":"fm.teal.alpha.feed.play","rkey":"123"}'
```

```typescript
import { callXrpc } from "$hatk/client";

await callXrpc("dev.hatk.deleteRecord", {
  collection: "fm.teal.alpha.feed.play",
  rkey: "123",
});
```

### Response

```json
{}
```
