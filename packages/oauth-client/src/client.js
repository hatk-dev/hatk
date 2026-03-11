// Browser OAuth client for AT Protocol hatk servers
//
// Usage:
//   const client = new OAuthClient({ server: 'https://my-appview.example.com' })
//   await client.login('alice.bsky.social')
//   // ...user approves on PDS...
//   await client.handleCallback()
//   const res = await client.fetch('/xrpc/fm.teal.getFeed?feed=recent')

import { randomString, sha256Base64Url } from './crypto.js'
import { getOrCreateDPoPKey, createDPoPProof, clearDPoPKey } from './dpop.js'
import { createStorage, acquireLock, releaseLock } from './storage.js'

const TOKEN_REFRESH_BUFFER_MS = 60_000 // refresh 60s before expiry

export class OAuthClient {
  /**
   * @param {object} opts
   * @param {string} opts.server - Hatk server URL (e.g. 'https://my-appview.example.com')
   * @param {string} [opts.clientId] - OAuth client_id (defaults to current origin)
   * @param {string} [opts.redirectUri] - Callback URL (defaults to current page)
   * @param {string} [opts.scope] - OAuth scope (defaults to 'atproto')
   */
  constructor({ server, clientId, redirectUri, scope }) {
    this.server = server.replace(/\/$/, '')
    this.clientId = clientId || window.location.origin
    this.redirectUri = redirectUri || window.location.origin + window.location.pathname
    this.scope = scope || 'atproto'
    this.namespace = this.clientId.replace(/[^a-z0-9]/gi, '_').slice(0, 32)
    this.storage = createStorage(this.namespace)
    this._initPromise = null
  }

  /** Ensure DPoP key exists in IndexedDB. */
  async init() {
    if (!this._initPromise) {
      this._initPromise = getOrCreateDPoPKey(this.namespace)
    }
    return this._initPromise
  }

  /** Start the OAuth login flow (redirects the browser). */
  async login(handle) {
    await this.init()

    // Generate PKCE
    const codeVerifier = randomString(32)
    const codeChallenge = await sha256Base64Url(codeVerifier)
    const state = randomString(16)

    // Store flow state in sessionStorage
    this.storage.set('codeVerifier', codeVerifier)
    this.storage.set('oauthState', state)
    this.storage.set('clientId', this.clientId)
    this.storage.set('redirectUri', this.redirectUri)

    // Create DPoP proof for PAR request
    const parUrl = `${this.server}/oauth/par`
    const dpopProof = await createDPoPProof(this.namespace, 'POST', parUrl)

    // Send Pushed Authorization Request
    const parBody = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: this.scope,
      state,
    })
    if (handle) parBody.set('login_hint', handle)

    const parRes = await fetch(parUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: dpopProof,
      },
      body: parBody.toString(),
    })

    if (!parRes.ok) {
      const err = await parRes.json().catch(() => ({}))
      throw new Error(`PAR failed: ${err.error || parRes.status}`)
    }

    const { request_uri } = await parRes.json()

    // Redirect to authorize endpoint
    const authorizeParams = new URLSearchParams({
      request_uri,
      client_id: this.clientId,
    })
    window.location.href = `${this.server}/oauth/authorize?${authorizeParams}`
  }

  /**
   * Handle the OAuth callback after the redirect.
   * Call this on page load — returns true if a callback was processed.
   */
  async handleCallback() {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const error = params.get('error')

    if (error) throw new Error(`OAuth error: ${error} - ${params.get('error_description') || ''}`)
    if (!code || !state) return false

    // Verify state (CSRF)
    const storedState = this.storage.get('oauthState')
    if (state !== storedState) throw new Error('OAuth state mismatch')

    const codeVerifier = this.storage.get('codeVerifier')
    const clientId = this.storage.get('clientId')
    const redirectUri = this.storage.get('redirectUri')
    if (!codeVerifier || !clientId || !redirectUri) throw new Error('Missing OAuth session data')

    await this.init()

    // Exchange code for tokens (with DPoP proof)
    const tokenUrl = `${this.server}/oauth/token`
    const dpopProof = await createDPoPProof(this.namespace, 'POST', tokenUrl)

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: dpopProof,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      }),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({}))
      throw new Error(`Token exchange failed: ${err.error_description || tokenRes.statusText}`)
    }

    const tokens = await tokenRes.json()
    this._storeTokens(tokens)

    // Clean up flow state
    this.storage.remove('codeVerifier')
    this.storage.remove('oauthState')
    this.storage.remove('redirectUri')

    // Clear URL params
    window.history.replaceState({}, document.title, window.location.pathname)
    return true
  }

  /** Whether the user is currently logged in (has a non-expired token). */
  get isLoggedIn() {
    return !!this.storage.get('accessToken') && !!this.storage.get('userDid')
  }

  /** The logged-in user's DID, or null. */
  get did() {
    return this.storage.get('userDid')
  }

  /** The logged-in user's handle, or null. */
  get handle() {
    return this.storage.get('userHandle')
  }

  /**
   * Make an authenticated fetch request.
   * Automatically adds DPoP proof and Authorization header.
   * Auto-refreshes expired tokens.
   */
  async fetch(path, opts = {}) {
    await this.init()

    const url = path.startsWith('http') ? path : `${this.server}${path}`
    const method = (opts.method || 'GET').toUpperCase()

    const token = await this._getValidToken()
    if (!token) throw new Error('Not authenticated')

    const dpopProof = await createDPoPProof(this.namespace, method, url, token)

    const headers = {
      ...opts.headers,
      Authorization: `DPoP ${token}`,
      DPoP: dpopProof,
    }

    const res = await fetch(url, { ...opts, method, headers })

    // If PDS rejected due to insufficient scope, re-authenticate with current scopes
    if (res.status === 403) {
      const body = await res
        .clone()
        .json()
        .catch(() => ({}))
      if (body.error === 'ScopeMissingError') {
        this.login(this.did)
        throw new Error('Re-authenticating with updated scopes')
      }
    }

    return res
  }

  /** Log out — clear all stored tokens and DPoP keys. */
  async logout() {
    this.storage.clear()
    await clearDPoPKey(this.namespace)
    this._initPromise = null
  }

  // --- Private ---

  _storeTokens(tokens) {
    this.storage.set('accessToken', tokens.access_token)
    if (tokens.refresh_token) this.storage.set('refreshToken', tokens.refresh_token)
    if (tokens.sub) this.storage.set('userDid', tokens.sub)
    if (tokens.handle) this.storage.set('userHandle', tokens.handle)
    const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000
    this.storage.set('tokenExpiresAt', expiresAt.toString())
  }

  async _getValidToken() {
    const token = this.storage.get('accessToken')
    const expiresAt = parseInt(this.storage.get('tokenExpiresAt') || '0')

    if (token && Date.now() < expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return token
    }

    // Try to refresh
    const refreshToken = this.storage.get('refreshToken')
    if (!refreshToken) return null

    // Multi-tab lock to prevent duplicate refreshes
    const lockValue = await acquireLock(this.namespace, 'refresh')
    if (!lockValue) {
      // Another tab is refreshing — wait and retry
      await new Promise((r) => setTimeout(r, 150))
      return this.storage.get('accessToken')
    }

    try {
      // Double-check after acquiring lock
      const fresh = this.storage.get('accessToken')
      const freshExp = parseInt(this.storage.get('tokenExpiresAt') || '0')
      if (fresh && Date.now() < freshExp - TOKEN_REFRESH_BUFFER_MS) return fresh

      const tokenUrl = `${this.server}/oauth/token`
      const dpopProof = await createDPoPProof(this.namespace, 'POST', tokenUrl)

      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: dpopProof,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.storage.get('clientId') || this.clientId,
        }),
      })

      if (!res.ok) {
        // Refresh failed — clear session
        this.storage.clear()
        return null
      }

      const tokens = await res.json()
      this._storeTokens(tokens)
      return tokens.access_token
    } finally {
      releaseLock(this.namespace, 'refresh', lockValue)
    }
  }
}
