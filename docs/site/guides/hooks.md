---
title: Hooks
description: Run custom logic at key points in the server lifecycle.
---

Hooks let you run custom logic at key points in the Hatk lifecycle, like when a user logs in via OAuth. Define them with `defineHook()` in the `server/` directory.

## `on-login`

The `on-login` hook runs after a successful OAuth login. The most common use is calling `ensureRepo` to backfill the user's data so it's available immediately:

```typescript
// server/on-login.ts
import { defineHook } from '$hatk'

export default defineHook('on-login', async ({ did, ensureRepo }) => {
  await ensureRepo(did)
})
```

This is three lines, but it's important: without it, a new user's existing records won't appear until the firehose (the AT Protocol's real-time event stream) delivers them. `ensureRepo` fetches the user's repository from their PDS and indexes it right away.

## Hook context

The `on-login` handler receives:

| Field | Type | Description |
| --- | --- | --- |
| `did` | string | The DID (decentralized identifier) of the user who logged in |
| `ensureRepo` | `(did: string) => Promise<void>` | Marks the user's repo as pending and triggers a backfill from their PDS |

## Error handling

If a hook throws, the error is logged but does not block the login flow. The user still completes authentication successfully.
