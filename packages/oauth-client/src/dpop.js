// DPoP key management (IndexedDB) and proof creation

import { randomString, sha256Base64Url, signJwt } from './crypto.js'

const DB_VERSION = 1
const KEY_STORE = 'dpop-keys'
const KEY_ID = 'dpop-key'

const dbPromises = new Map()

function openDatabase(namespace) {
  const existing = dbPromises.get(namespace)
  if (existing) return existing

  const promise = new Promise((resolve, reject) => {
    const req = indexedDB.open(`appview-oauth-${namespace}`, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: 'id' })
      }
    }
  })

  dbPromises.set(namespace, promise)
  return promise
}

async function getStoredKey(namespace) {
  const db = await openDatabase(namespace)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readonly')
    const req = tx.objectStore(KEY_STORE).get(KEY_ID)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function storeKey(namespace, privateKey, publicJwk) {
  const db = await openDatabase(namespace)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite')
    const req = tx.objectStore(KEY_STORE).put({
      id: KEY_ID,
      privateKey,
      publicJwk,
      createdAt: Date.now(),
    })
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function getOrCreateDPoPKey(namespace) {
  const existing = await getStoredKey(namespace)
  if (existing) return existing

  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // non-extractable private key
    ['sign'],
  )

  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  await storeKey(namespace, keyPair.privateKey, publicJwk)

  return { id: KEY_ID, privateKey: keyPair.privateKey, publicJwk, createdAt: Date.now() }
}

export async function clearDPoPKey(namespace) {
  const db = await openDatabase(namespace)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite')
    const req = tx.objectStore(KEY_STORE).delete(KEY_ID)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function createDPoPProof(namespace, method, url, accessToken) {
  const keyData = await getOrCreateDPoPKey(namespace)
  const { kty, crv, x, y } = keyData.publicJwk

  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty, crv, x, y } }
  const payload = {
    jti: randomString(16),
    htm: method,
    htu: url.split('?')[0],
    iat: Math.floor(Date.now() / 1000),
  }

  if (accessToken) {
    payload.ath = await sha256Base64Url(accessToken)
  }

  return signJwt(header, payload, keyData.privateKey)
}
