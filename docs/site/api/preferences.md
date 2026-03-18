---
title: Preferences
description: Store and retrieve per-user preferences.
---

## `dev.hatk.getPreferences`

Get all preferences for the authenticated user.

- **Type:** Query (GET)
- **Auth:** Required (session cookie or DPoP token)

### Example

```bash
curl "http://127.0.0.1:3000/xrpc/dev.hatk.getPreferences" \
  -H "Authorization: DPoP <token>"
```

```typescript
import { callXrpc } from "$hatk/client";

const { preferences } = await callXrpc("dev.hatk.getPreferences");
```

### Response

```json
{
  "preferences": {
    "theme": "dark",
    "notifications": true
  }
}
```

---

## `dev.hatk.putPreference`

Set a single preference by key for the authenticated user.

- **Type:** Procedure (POST)
- **Auth:** Required (session cookie or DPoP token)

### Input

| Name    | Type   | Required | Description      |
| ------- | ------ | -------- | ---------------- |
| `key`   | string | Yes      | Preference key   |
| `value` | any    | Yes      | Preference value |

### Example

```bash
curl -X POST "http://127.0.0.1:3000/xrpc/dev.hatk.putPreference" \
  -H "Authorization: DPoP <token>" \
  -H "Content-Type: application/json" \
  -d '{"key":"theme","value":"dark"}'
```

```typescript
import { callXrpc } from "$hatk/client";

await callXrpc("dev.hatk.putPreference", {
  key: "theme",
  value: "dark",
});
```

### Response

```json
{}
```
