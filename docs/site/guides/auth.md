---
title: Auth
description: Add authentication to your hatk app with OAuth and session cookies.
---

# Auth

hatk handles AT Protocol OAuth entirely server-side. When a user signs in, hatk runs the OAuth flow with their PDS (Personal Data Server), then stores the session in an encrypted cookie. Your frontend just calls `login(handle)` and `logout()` -- no token management, no client-side OAuth libraries.

## How it works

1. User enters their handle, frontend calls `login(handle)`
2. Browser redirects to the user's PDS for authorization
3. PDS redirects back to your server, which completes the token exchange
4. Server sets an encrypted session cookie
5. On subsequent requests, `parseViewer(cookies)` reads the cookie to identify the user

## Configuration

Enable OAuth in `hatk.config.ts` by adding an `oauth` section:

```typescript
// hatk.config.ts
import { defineConfig } from "@hatk/hatk/config";

export default defineConfig({
  // ... other config
  oauth: {
    issuer: "https://my-app.example.com",
    scopes: ["atproto"],
    clients: [
      {
        client_id: "https://my-app.example.com/oauth-client-metadata.json",
        client_name: "my-hatk-app",
        scope: "atproto",
        redirect_uris: ["https://my-app.example.com/oauth/callback"],
      },
      // Local development client
      {
        client_id: "http://127.0.0.1:3000/oauth-client-metadata.json",
        client_name: "my-hatk-app",
        scope: "atproto",
        redirect_uris: ["http://127.0.0.1:3000/oauth/callback"],
      },
    ],
  },
});
```

### OAuth config options

| Field     | Description                                                                |
| --------- | -------------------------------------------------------------------------- |
| `issuer`  | Your app's public URL. Used for OAuth metadata discovery. Optional in dev. |
| `scopes`  | Array of OAuth scopes your app needs                                       |
| `clients` | Array of OAuth client configurations (one per environment)                 |

### Scopes

Scopes control what the token can do:

- `atproto` -- base AT Protocol access (read-only)
- `repo:<collection>?action=create&action=delete` -- write access to a specific collection

For example, an app that creates and deletes status records:

```typescript
scopes: ["atproto repo:xyz.statusphere.status?action=create&action=delete"],
```

## Frontend auth

`login` and `logout` are generated helpers available from `$hatk/client`. They handle the full OAuth redirect flow.

### Login

`login(handle)` redirects the browser to the user's PDS for authorization. After the user approves, they're redirected back to your app with an active session:

```typescript
import { login } from "$hatk/client";

await login("alice.bsky.social");
// Browser redirects to PDS → user approves → redirects back with session cookie
```

### Logout

`logout()` clears the session cookie:

```typescript
import { logout } from "$hatk/client";

await logout();
```

### Login form example

A minimal Svelte login form using `login` and `logout`:

```svelte
<script lang="ts">
  import { login, logout } from '$hatk/client'
  import { invalidateAll } from '$app/navigation'

  let { data } = $props()
  let handle = $state('')
  let loading = $state(false)
  let error = $state('')

  async function handleLogin() {
    if (!handle.trim()) return
    loading = true
    error = ''
    try {
      await login(handle)
    } catch (e: any) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function handleLogout() {
    await logout()
    await invalidateAll()
  }
</script>

{#if data.viewer}
  <p>Signed in as <code>{data.viewer.did}</code></p>
  <button onclick={handleLogout}>Sign out</button>
{:else}
  <form onsubmit={handleLogin}>
    <input type="text" bind:value={handle} placeholder="your.handle" />
    <button type="submit" disabled={loading}>
      {loading ? 'Signing in...' : 'Sign in'}
    </button>
  </form>
  {#if error}
    <p style="color: red;">{error}</p>
  {/if}
{/if}
```

## Native app clients

hatk supports native app OAuth clients (iOS, Android, etc.) that use a custom URL scheme for redirects and communicate directly with the PAR and token endpoints.

### Client configuration

Register a native client in `hatk.config.ts` using a custom scheme `client_id` and `redirect_uri`:

```typescript
clients: [
  // Native iOS app
  {
    client_id: "my-app://app",
    client_name: "my-app-native",
    scope: "atproto repo:xyz.statusphere.status?action=create",
    redirect_uris: ["my-app://oauth/callback"],
  },
],
```

### Account creation

Native clients can trigger account creation by sending `prompt=create` in the PAR request. When `prompt=create` is set, the `login_hint` parameter is treated as a **PDS hostname** (not a handle or DID), since the user doesn't have an account yet.

```
POST /oauth/par
Content-Type: application/x-www-form-urlencoded

client_id=my-app://app
&redirect_uri=my-app://oauth/callback
&response_type=code
&code_challenge=<challenge>
&code_challenge_method=S256
&scope=atproto
&prompt=create
&login_hint=selfhosted.social
```

The `login_hint` should be the bare hostname of the PDS where the account will be created:

- **Production:** `selfhosted.social` (or your PDS domain)
- **Local development:** `localhost:2583`

hatk will automatically prepend the correct scheme (`https://` for production, `http://` for localhost) and discover the PDS auth server via its protected resource metadata. The `prompt=create` parameter is forwarded to the PDS so it shows the signup page instead of the login page.

## Server-side auth

### `parseViewer` in layouts

Use `parseViewer(cookies)` in your `+layout.server.ts` to read the session cookie and pass the viewer to all routes:

```typescript
// app/routes/+layout.server.ts
import { parseViewer } from "$hatk/client";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ cookies }) => {
  const viewer = await parseViewer(cookies);
  return { viewer };
};
```

`parseViewer` returns `{ did: string; handle?: string }` if a valid session exists, or `null` if the user is not signed in. The `viewer` is then available in `data.viewer` on every page through SvelteKit's layout data flow.

### `ctx.viewer` in handlers

In XRPC handlers and feed generators, the authenticated user is available as `ctx.viewer`:

```typescript
import { defineQuery } from "$hatk";

export default defineQuery("my.app.getPrivateData", async (ctx) => {
  if (!ctx.viewer) throw new Error("Authentication required");

  const { did } = ctx.viewer;
  const rows = await ctx.db.query(
    `SELECT * FROM my_table WHERE did = $1`,
    [did],
  );

  return ctx.ok({ items: rows });
});
```

`ctx.viewer` is the same `{ did: string; handle?: string }` shape in both XRPC handlers and feed `generate`/`hydrate` functions.

## Complete example

Here's the full auth flow from config to login form to protected data.

### 1. Configure OAuth

```typescript
// hatk.config.ts
import { defineConfig } from "@hatk/hatk/config";

export default defineConfig({
  // ...
  oauth: {
    scopes: ["atproto repo:xyz.statusphere.status?action=create&action=delete"],
    clients: [
      {
        client_id: "http://127.0.0.1:3000/oauth-client-metadata.json",
        client_name: "statusphere",
        scope: "atproto repo:xyz.statusphere.status?action=create&action=delete",
        redirect_uris: ["http://127.0.0.1:3000/oauth/callback"],
      },
    ],
  },
});
```

### 2. Parse the viewer in your layout

```typescript
// app/routes/+layout.server.ts
import { parseViewer } from "$hatk/client";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ cookies }) => {
  const viewer = await parseViewer(cookies);
  return { viewer };
};
```

### 3. Build the login form

```svelte
<!-- app/routes/+page.svelte -->
<script lang="ts">
  import { login, logout } from '$hatk/client'
  import { invalidateAll } from '$app/navigation'

  let { data } = $props()
  let handle = $state('')

  async function doLogin() {
    if (!handle.trim()) return
    try {
      await login(handle.trim())
    } catch {
      alert('Handle not found. Check spelling and try again.')
    }
  }

  async function doLogout() {
    await logout()
    await invalidateAll()
  }
</script>

{#if data.viewer}
  <p>Signed in as {data.viewer.did}</p>
  <button onclick={doLogout}>Sign out</button>

  <!-- Authenticated content here -->
{:else}
  <form onsubmit={(e) => { e.preventDefault(); doLogin() }}>
    <input bind:value={handle} placeholder="Enter your handle (e.g. alice.bsky.social)" />
    <button type="submit">Sign in</button>
  </form>
{/if}
```

### 4. Protect a server endpoint

```typescript
// server/xrpc/getMyData.ts
import { defineQuery } from "$hatk";

export default defineQuery("my.app.getMyData", async (ctx) => {
  if (!ctx.viewer) throw new Error("Authentication required");

  const rows = await ctx.db.query(
    `SELECT * FROM "xyz.statusphere.status" WHERE did = $1`,
    [ctx.viewer.did],
  );

  return ctx.ok({ items: rows });
});
```
