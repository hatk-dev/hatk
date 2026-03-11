// Namespaced browser storage for OAuth state and tokens
//
// sessionStorage: PKCE verifier, OAuth state (per-tab, cleared on callback)
// localStorage: tokens, user DID (shared across tabs)

export function createStorage(namespace) {
  const key = (name) => `appview_${namespace}_${name}`

  // sessionStorage keys (per-tab OAuth flow state)
  const SESSION_KEYS = new Set(['codeVerifier', 'oauthState', 'redirectUri'])

  return {
    get(name) {
      const store = SESSION_KEYS.has(name) ? sessionStorage : localStorage
      return store.getItem(key(name))
    },
    set(name, value) {
      const store = SESSION_KEYS.has(name) ? sessionStorage : localStorage
      store.setItem(key(name), value)
    },
    remove(name) {
      const store = SESSION_KEYS.has(name) ? sessionStorage : localStorage
      store.removeItem(key(name))
    },
    clear() {
      for (const name of SESSION_KEYS) sessionStorage.removeItem(key(name))
      for (const name of ['accessToken', 'refreshToken', 'tokenExpiresAt', 'userDid', 'clientId']) {
        localStorage.removeItem(key(name))
      }
    },
  }
}

// Multi-tab lock for token refresh coordination
const LOCK_TIMEOUT = 5000

export async function acquireLock(namespace, lockName) {
  const lockKey = `appview_${namespace}_lock_${lockName}`
  const lockValue = `${Date.now()}_${Math.random()}`
  const deadline = Date.now() + LOCK_TIMEOUT

  while (Date.now() < deadline) {
    const existing = localStorage.getItem(lockKey)
    if (existing) {
      const ts = parseInt(existing.split('_')[0])
      if (Date.now() - ts > LOCK_TIMEOUT) {
        localStorage.removeItem(lockKey)
      } else {
        await new Promise((r) => setTimeout(r, 50))
        continue
      }
    }

    localStorage.setItem(lockKey, lockValue)
    await new Promise((r) => setTimeout(r, 10))
    if (localStorage.getItem(lockKey) === lockValue) return lockValue
  }
  return null
}

export function releaseLock(namespace, lockName, lockValue) {
  const lockKey = `appview_${namespace}_lock_${lockName}`
  if (localStorage.getItem(lockKey) === lockValue) localStorage.removeItem(lockKey)
}
