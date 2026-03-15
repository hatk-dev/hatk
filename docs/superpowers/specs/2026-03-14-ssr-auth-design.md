# SSR Auth Design

## Context

hatk apps use DPoP-bound JWT auth for API requests, managed by `@hatk/oauth-client` in the browser. During SSR, the server has no way to identify the viewer — the Vite SSR middleware creates a bare `Request` with no headers, and DPoP tokens don't travel with page navigations. This causes a flash: the server renders the "Sign in" form, then the client hydrates and swaps in the authenticated UI.

## Goals

1. Server knows the viewer during SSR — no auth UI flash
2. `callXrpc` during SSR is automatically authenticated
3. Framework-agnostic — works with Svelte, React, Vue
4. No new database tables or dependencies
5. Coexists with existing client-side OAuth

## Design

### Cookie Lifecycle

During the OAuth callback (`/oauth/callback`), after storing the PDS session, the server sets an `HttpOnly` cookie. The cookie value is a signed token: `did.timestamp.signature` — the user's DID, a Unix timestamp (seconds), and an HMAC-SHA256 signature using the server's existing OAuth keypair.

Cookie attributes:
- `HttpOnly` — not accessible to JavaScript
- `Secure` — HTTPS only in production
- `SameSite=Lax` — sent on navigations, not cross-site requests
- `Path=/`
- `Max-Age=2592000` (30 days)

Cookie name defaults to `__hatk_session`. Configurable via `oauth: { cookieName: 'my_app_session' }` in `hatk.config.ts` for apps sharing a domain.

A new `POST /auth/logout` endpoint clears the cookie (`Max-Age=0`).

On SSR requests, the server parses the cookie, verifies the signature, checks the timestamp isn't expired, and extracts the DID. Invalid or missing cookie → `viewer = null`. No DB lookup needed.

### Threading the Viewer Through SSR

The Vite plugin SSR middleware forwards the `Cookie` header when constructing the Request (currently creates a bare `new Request(url)`).

Before calling `renderPage`, the server resolves the viewer from the cookie and sets `globalThis.__hatk_viewer = viewer` (where viewer is `{ did: string } | null`). After rendering, it clears `globalThis.__hatk_viewer` to prevent leaking between requests.

`callXrpc` in the globalThis bridge automatically picks up `globalThis.__hatk_viewer` and passes it to handlers. Template code doesn't change — `await callXrpc('dev.hatk.getFeed', { feed: 'mine' })` just works with auth context.

### Component Access

The generated `hatk.generated.client.ts` exports a `getViewer()` function:
- During SSR: reads `globalThis.__hatk_viewer`
- In the browser: delegates to the OAuth client's `viewerDid()`

Components use `getViewer()` to conditionally render auth UI. The server already knows if you're logged in, so no flash.

### Always On

If OAuth is configured, the session cookie is always set during callback. Templates that don't use `getViewer()` during SSR just never read it. No config flag needed to enable — you use it or you don't.

## What Changes Where

- **`oauth/server.ts`** — `createSessionCookie(did, keypair)` and `parseSessionCookie(cookie, keypair)` helpers. HMAC-SHA256 sign/verify.
- **`server.ts`** — `/oauth/callback` sets `Set-Cookie` header. New `POST /auth/logout` route. `resolveViewerFromCookie(request)` parses cookie → `{ did } | null`.
- **`vite-plugin.ts`** — SSR middleware forwards `Cookie` header in Request. Before render, resolve viewer and set `globalThis.__hatk_viewer`. Clear after render.
- **`xrpc.ts`** — `callXrpc` globalThis bridge passes `globalThis.__hatk_viewer` as the viewer argument.
- **`cli.ts` (codegen)** — `hatk.generated.client.ts` gets `getViewer()` export.
- **`dev-entry.ts`** — Export cookie resolution so vite plugin can call it via module runner.

## Not In Scope

- Per-route auth requirements (middleware/guards)
- Role-based access control
- Cookie refresh/rotation (cookie outlives or matches PDS session)
- CSRF protection beyond `SameSite=Lax`
