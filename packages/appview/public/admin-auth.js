function g(s) {
  const t = s instanceof Uint8Array ? s : new Uint8Array(s)
  let o = ''
  for (let e = 0; e < t.length; e++) o += String.fromCharCode(t[e])
  return btoa(o).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function f(s = 32) {
  return g(crypto.getRandomValues(new Uint8Array(s)))
}
async function D(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}
async function k(s) {
  return g(await D(s))
}
async function E(s, t, o) {
  const e = new TextEncoder(),
    n = g(e.encode(JSON.stringify(s))),
    r = g(e.encode(JSON.stringify(t))),
    a = `${n}.${r}`,
    i = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, o, e.encode(a))
  return `${a}.${g(i)}`
}
const x = 1,
  d = 'dpop-keys',
  p = 'dpop-key',
  y = /* @__PURE__ */ new Map()
function m(s) {
  const t = y.get(s)
  if (t) return t
  const o = new Promise((e, n) => {
    const r = indexedDB.open(`appview-oauth-${s}`, x)
    ;((r.onerror = () => n(r.error)),
      (r.onsuccess = () => e(r.result)),
      (r.onupgradeneeded = (a) => {
        const i = a.target.result
        i.objectStoreNames.contains(d) || i.createObjectStore(d, { keyPath: 'id' })
      }))
  })
  return (y.set(s, o), o)
}
async function $(s) {
  const t = await m(s)
  return new Promise((o, e) => {
    const r = t.transaction(d, 'readonly').objectStore(d).get(p)
    ;((r.onsuccess = () => o(r.result || null)), (r.onerror = () => e(r.error)))
  })
}
async function b(s, t, o) {
  const e = await m(s)
  return new Promise((n, r) => {
    const i = e.transaction(d, 'readwrite').objectStore(d).put({
      id: p,
      privateKey: t,
      publicJwk: o,
      createdAt: Date.now(),
    })
    ;((i.onsuccess = () => n()), (i.onerror = () => r(i.error)))
  })
}
async function P(s) {
  const t = await $(s)
  if (t) return t
  const o = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      !1,
      // non-extractable private key
      ['sign'],
    ),
    e = await crypto.subtle.exportKey('jwk', o.publicKey)
  return (await b(s, o.privateKey, e), { id: p, privateKey: o.privateKey, publicJwk: e, createdAt: Date.now() })
}
async function v(s) {
  const t = await m(s)
  return new Promise((o, e) => {
    const r = t.transaction(d, 'readwrite').objectStore(d).delete(p)
    ;((r.onsuccess = () => o()), (r.onerror = () => e(r.error)))
  })
}
async function w(s, t, o, e) {
  const n = await P(s),
    { kty: r, crv: a, x: i, y: c } = n.publicJwk,
    h = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: r, crv: a, x: i, y: c } },
    l = {
      jti: f(16),
      htm: t,
      htu: o.split('?')[0],
      iat: Math.floor(Date.now() / 1e3),
    }
  return (e && (l.ath = await k(e)), E(h, l, n.privateKey))
}
function U(s) {
  const t = (e) => `appview_${s}_${e}`,
    o = /* @__PURE__ */ new Set(['codeVerifier', 'oauthState', 'redirectUri'])
  return {
    get(e) {
      return (o.has(e) ? sessionStorage : localStorage).getItem(t(e))
    },
    set(e, n) {
      ;(o.has(e) ? sessionStorage : localStorage).setItem(t(e), n)
    },
    remove(e) {
      ;(o.has(e) ? sessionStorage : localStorage).removeItem(t(e))
    },
    clear() {
      for (const e of o) sessionStorage.removeItem(t(e))
      for (const e of ['accessToken', 'refreshToken', 'tokenExpiresAt', 'userDid', 'clientId'])
        localStorage.removeItem(t(e))
    },
  }
}
const S = 5e3
async function A(s, t) {
  const o = `appview_${s}_lock_${t}`,
    e = `${Date.now()}_${Math.random()}`,
    n = Date.now() + S
  for (; Date.now() < n; ) {
    const r = localStorage.getItem(o)
    if (r) {
      const a = parseInt(r.split('_')[0])
      if (Date.now() - a > S) localStorage.removeItem(o)
      else {
        await new Promise((i) => setTimeout(i, 50))
        continue
      }
    }
    if ((localStorage.setItem(o, e), await new Promise((a) => setTimeout(a, 10)), localStorage.getItem(o) === e))
      return e
  }
  return null
}
function O(s, t, o) {
  const e = `appview_${s}_lock_${t}`
  localStorage.getItem(e) === o && localStorage.removeItem(e)
}
const _ = 6e4
class K {
  /**
   * @param {object} opts
   * @param {string} opts.server - Appview server URL (e.g. 'https://my-appview.example.com')
   * @param {string} [opts.clientId] - OAuth client_id (defaults to current origin)
   * @param {string} [opts.redirectUri] - Callback URL (defaults to current page)
   * @param {string} [opts.scope] - OAuth scope (defaults to 'atproto')
   */
  constructor({ server: t, clientId: o, redirectUri: e, scope: n }) {
    ;((this.server = t.replace(/\/$/, '')),
      (this.clientId = o || window.location.origin),
      (this.redirectUri = e || window.location.origin + window.location.pathname),
      (this.scope = n || 'atproto'),
      (this.namespace = this.clientId.replace(/[^a-z0-9]/gi, '_').slice(0, 32)),
      (this.storage = U(this.namespace)),
      (this._initPromise = null))
  }
  /** Ensure DPoP key exists in IndexedDB. */
  async init() {
    return (this._initPromise || (this._initPromise = P(this.namespace)), this._initPromise)
  }
  /** Start the OAuth login flow (redirects the browser). */
  async login(t) {
    await this.init()
    const o = f(32),
      e = await k(o),
      n = f(16)
    ;(this.storage.set('codeVerifier', o),
      this.storage.set('oauthState', n),
      this.storage.set('clientId', this.clientId),
      this.storage.set('redirectUri', this.redirectUri))
    const r = `${this.server}/oauth/par`,
      a = await w(this.namespace, 'POST', r),
      i = new URLSearchParams({
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        response_type: 'code',
        code_challenge: e,
        code_challenge_method: 'S256',
        scope: this.scope,
        state: n,
      })
    t && i.set('login_hint', t)
    const c = await fetch(r, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: a,
      },
      body: i.toString(),
    })
    if (!c.ok) {
      const u = await c.json().catch(() => ({}))
      throw new Error(`PAR failed: ${u.error || c.status}`)
    }
    const { request_uri: h } = await c.json(),
      l = new URLSearchParams({
        request_uri: h,
        client_id: this.clientId,
      })
    window.location.href = `${this.server}/oauth/authorize?${l}`
  }
  /**
   * Handle the OAuth callback after the redirect.
   * Call this on page load — returns true if a callback was processed.
   */
  async handleCallback() {
    const t = new URLSearchParams(window.location.search),
      o = t.get('code'),
      e = t.get('state'),
      n = t.get('error')
    if (n) throw new Error(`OAuth error: ${n} - ${t.get('error_description') || ''}`)
    if (!o || !e) return !1
    const r = this.storage.get('oauthState')
    if (e !== r) throw new Error('OAuth state mismatch')
    const a = this.storage.get('codeVerifier'),
      i = this.storage.get('clientId'),
      c = this.storage.get('redirectUri')
    if (!a || !i || !c) throw new Error('Missing OAuth session data')
    await this.init()
    const h = `${this.server}/oauth/token`,
      l = await w(this.namespace, 'POST', h),
      u = await fetch(h, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: l,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: o,
          redirect_uri: c,
          client_id: i,
          code_verifier: a,
        }),
      })
    if (!u.ok) {
      const I = await u.json().catch(() => ({}))
      throw new Error(`Token exchange failed: ${I.error_description || u.statusText}`)
    }
    const T = await u.json()
    return (
      this._storeTokens(T),
      this.storage.remove('codeVerifier'),
      this.storage.remove('oauthState'),
      this.storage.remove('redirectUri'),
      window.history.replaceState({}, document.title, window.location.pathname),
      !0
    )
  }
  /** Whether the user is currently logged in (has a non-expired token). */
  get isLoggedIn() {
    return !!this.storage.get('accessToken') && !!this.storage.get('userDid')
  }
  /** The logged-in user's DID, or null. */
  get did() {
    return this.storage.get('userDid')
  }
  /**
   * Make an authenticated fetch request.
   * Automatically adds DPoP proof and Authorization header.
   * Auto-refreshes expired tokens.
   */
  async fetch(t, o = {}) {
    await this.init()
    const e = t.startsWith('http') ? t : `${this.server}${t}`,
      n = (o.method || 'GET').toUpperCase(),
      r = await this._getValidToken()
    if (!r) throw new Error('Not authenticated')
    const a = await w(this.namespace, n, e, r),
      i = {
        ...o.headers,
        Authorization: `DPoP ${r}`,
        DPoP: a,
      }
    return fetch(e, { ...o, method: n, headers: i })
  }
  /** Log out — clear all stored tokens and DPoP keys. */
  async logout() {
    ;(this.storage.clear(), await v(this.namespace), (this._initPromise = null))
  }
  // --- Private ---
  _storeTokens(t) {
    ;(this.storage.set('accessToken', t.access_token),
      t.refresh_token && this.storage.set('refreshToken', t.refresh_token),
      t.sub && this.storage.set('userDid', t.sub))
    const o = Date.now() + (t.expires_in || 3600) * 1e3
    this.storage.set('tokenExpiresAt', o.toString())
  }
  async _getValidToken() {
    const t = this.storage.get('accessToken'),
      o = parseInt(this.storage.get('tokenExpiresAt') || '0')
    if (t && Date.now() < o - _) return t
    const e = this.storage.get('refreshToken')
    if (!e) return null
    const n = await A(this.namespace, 'refresh')
    if (!n) return (await new Promise((r) => setTimeout(r, 150)), this.storage.get('accessToken'))
    try {
      const r = this.storage.get('accessToken'),
        a = parseInt(this.storage.get('tokenExpiresAt') || '0')
      if (r && Date.now() < a - _) return r
      const i = `${this.server}/oauth/token`,
        c = await w(this.namespace, 'POST', i),
        h = await fetch(i, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: c,
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: e,
            client_id: this.storage.get('clientId') || this.clientId,
          }),
        })
      if (!h.ok) return (this.storage.clear(), null)
      const l = await h.json()
      return (this._storeTokens(l), l.access_token)
    } finally {
      O(this.namespace, 'refresh', n)
    }
  }
}
export { K as OAuthClient }
