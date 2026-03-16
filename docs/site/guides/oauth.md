---
title: OAuth
description: Authenticate users with AT Protocol OAuth.
---

Hatk includes a browser OAuth client (`@hatk/oauth-client`) that implements AT Protocol's DPoP-protected OAuth 2.0 flow with PKCE.

## Setup

Create an auth helper module in your frontend:

```typescript
// src/lib/auth.ts
import { OAuthClient } from '@hatk/oauth-client'

let client: OAuthClient | null = null

export function getOAuthClient(): OAuthClient {
  if (!client) {
    client = new OAuthClient({
      server: window.location.origin,
      clientId: window.location.origin + '/oauth-client-metadata.json',
      redirectUri: window.location.origin + '/oauth/callback',
      scope: 'atproto repo:xyz.statusphere.status?action=create&action=delete',
    })
  }
  return client
}
```

### Constructor options

| Option        | Default                  | Description                                           |
| ------------- | ------------------------ | ----------------------------------------------------- |
| `server`      | —                        | Hatk server URL                                       |
| `clientId`    | `window.location.origin` | OAuth client ID (must match client metadata endpoint) |
| `redirectUri` | current page URL         | Where to redirect after authorization                 |
| `scope`       | `'atproto'`              | OAuth scopes to request                               |

### Scopes

The `scope` string controls what the token can do:

- `atproto` — base AT Protocol access
- `repo:<collection>?action=create&action=delete` — write access to a specific collection

Example requesting create and delete access to status records:

```
atproto repo:xyz.statusphere.status?action=create&action=delete
```

## Login

Call `login()` with a handle to start the OAuth flow. This redirects the browser to the user's PDS for authorization:

```typescript
export async function login(handle: string): Promise<void> {
  await getOAuthClient().login(handle)
}
```

The flow uses Pushed Authorization Requests (PAR) with PKCE and DPoP proofs.

## Handling the callback

After the user approves, the PDS redirects back to your `redirectUri`. Handle this in your root layout:

```typescript
export async function handleCallback(): Promise<boolean> {
  return getOAuthClient().handleCallback()
}
```

Returns `true` if a callback was processed, `false` if no OAuth params were present. The scaffold's root layout calls this on mount:

```svelte
onMount(async () => {
  const handled = await handleCallback()
  if (handled) goto('/', { replaceState: true })
  getOAuthClient()
  ready = true
})
```

## Checking auth state

```typescript
export function isLoggedIn(): boolean {
  return !!client?.isLoggedIn
}

export function viewerDid(): string | null {
  return client?.did ?? null
}
```

- `isLoggedIn` — checks for a valid access token and stored DID
- `did` — returns the authenticated user's DID

## Authenticated fetch

The OAuth client provides a `fetch` method that automatically adds DPoP proof and Authorization headers:

```typescript
export function getAuthFetch(): typeof fetch {
  const c = client
  if (c?.isLoggedIn) {
    return (url: string | URL | Request, opts?: RequestInit) =>
      c.fetch(typeof url === 'string' ? url : url.toString(), opts)
  }
  return fetch.bind(globalThis)
}
```

Pass this to the [API client](/guides/api-client) so all requests are authenticated when a user is logged in:

```typescript
export const api = createClient<XrpcSchema>(origin, {
  fetch: (url, opts) => getAuthFetch()(url as string, opts),
})
```

## Token refresh

Tokens are automatically refreshed when they expire. The client:

- Refreshes 60 seconds before expiry
- Uses a multi-tab lock to prevent duplicate refresh requests
- Falls back gracefully if refresh fails (clears session)

No manual token management is needed.

## Logout

```typescript
export async function logout(): Promise<void> {
  await getOAuthClient().logout()
}
```

This clears all stored tokens and DPoP keys from browser storage.

## How it works

The OAuth flow uses these endpoints on your hatk server:

| Endpoint                          | Purpose                                           |
| --------------------------------- | ------------------------------------------------- |
| `POST /oauth/par`                 | Pushed Authorization Request — initiates the flow |
| `GET /oauth/authorize`            | Redirects to the user's PDS                       |
| `POST /oauth/token`               | Exchanges authorization code for tokens           |
| `GET /oauth/jwks`                 | Public keys for token verification                |
| `GET /oauth/client-metadata.json` | Client metadata discovery                         |

All token requests include DPoP proofs (ECDSA P-256 key pairs stored in IndexedDB), which bind access tokens to the specific browser that requested them.

## Server-side: `viewer`

On the backend, authenticated requests populate `ctx.viewer` in your XRPC handlers and feed generators:

```typescript
export default defineQuery('my.endpoint', async (ctx) => {
  if (!ctx.viewer) throw new Error('Authentication required')
  const { did } = ctx.viewer
  // ...
})
```

## Config

Enable OAuth in `config.yaml`:

```yaml
oauth:
  issuer: https://my-hatk.example.com
  clients:
    - client_id: https://my-hatk.example.com/oauth-client-metadata.json
      client_name: My App
      scope: atproto transition:generic
```

See [Configuration](/getting-started/configuration) for all OAuth options.
