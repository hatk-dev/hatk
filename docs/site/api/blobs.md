---
title: Blobs
description: Upload binary data via the user's PDS.
---

## `dev.hatk.uploadBlob`

Upload a binary blob (image, audio, etc.) via the authenticated user's PDS.

- **Type:** Procedure (POST)
- **Auth:** Required (session cookie or DPoP token)
- **Content-Type:** `*/*` (set to the blob's MIME type)

### Request

Send the raw binary data as the request body with the appropriate `Content-Type` header.

```bash
curl -X POST "http://127.0.0.1:3000/xrpc/dev.hatk.uploadBlob" \
  -H "Authorization: DPoP <token>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
```

### Client usage

```typescript
import { callXrpc } from "$hatk/client";

const result = await callXrpc("dev.hatk.uploadBlob", file);
// result.blob contains the blob reference
```

### Response

```json
{
  "blob": {
    "$type": "blob",
    "ref": { "$link": "bafkrei..." },
    "mimeType": "image/jpeg",
    "size": 123456
  }
}
```

## Using blobs in records

After uploading, reference the blob in a record field:

```typescript
import { callXrpc } from "$hatk/client";

const uploadResult = await callXrpc("dev.hatk.uploadBlob", imageFile);

await callXrpc("dev.hatk.createRecord", {
  collection: "fm.teal.alpha.feed.play",
  repo: userDid,
  record: {
    createdAt: new Date().toISOString(),
    image: uploadResult.blob,
  },
});
```
