// SSR session cookie — AES-GCM encrypted HttpOnly cookie for server-side viewer resolution.
// Separate from OAuth protocol flows but uses the same server keypair for key derivation.

import { base64UrlEncode, base64UrlDecode } from './crypto.ts'

let _privateJwk: JsonWebKey
let _cookieName = '__hatk_session'
const MAX_AGE = 30 * 24 * 60 * 60 // 30 days in seconds

/** Most accounts one browser can keep signed in at once. */
const MAX_ACCOUNTS = 10

export type SessionData = { did: string; handle: string }

export function getSessionCookieName(): string {
  return _cookieName
}

/**
 * Companion cookie listing every account this browser has signed in as.
 *
 * The session cookie names the *active* account; this one is the set the
 * browser is entitled to switch between without going back to the PDS. It's
 * encrypted with the same key, so a client can't add a DID to it and assume
 * that identity — which is the whole security gate on `/auth/switch`.
 */
export function getAccountsCookieName(): string {
  return `${_cookieName}_accounts`
}

export function initSession(privateJwk: JsonWebKey, cookieName?: string): void {
  _privateJwk = privateJwk
  if (cookieName) _cookieName = cookieName
}

async function aesKey(): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(JSON.stringify(_privateJwk, Object.keys(_privateJwk).sort()))
  const keyMaterial = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('hatk-session-cookie') },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encrypt(payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await aesKey()
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`
}

async function decrypt(value: string): Promise<any | null> {
  const parts = value.split('.')
  if (parts.length !== 2) return null
  try {
    const iv = base64UrlDecode(parts[0]) as Uint8Array<ArrayBuffer>
    const ciphertext = base64UrlDecode(parts[1]) as Uint8Array<ArrayBuffer>
    const key = await aesKey()
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    return null
  }
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return null
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
  return match ? match.slice(name.length + 1) : null
}

function cookieHeader(name: string, value: string, secure: boolean): string {
  const parts = [`${name}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${MAX_AGE}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export async function createSessionCookie(data: SessionData): Promise<string> {
  return encrypt({ ...data, ts: Math.floor(Date.now() / 1000) })
}

export function sessionCookieHeader(value: string, secure: boolean): string {
  return cookieHeader(_cookieName, value, secure)
}

export function clearSessionCookieHeader(): string {
  return `${_cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

export async function parseSessionCookie(request: Request): Promise<SessionData | null> {
  const value = readCookie(request, _cookieName)
  if (!value) return null
  const data = await decrypt(value)
  if (!data?.did || !data.handle || !data.ts) return null
  if (Date.now() / 1000 - data.ts > MAX_AGE) return null
  return { did: data.did, handle: data.handle }
}

// --- Accounts cookie ---

export async function createAccountsCookie(accounts: SessionData[]): Promise<string> {
  return encrypt({ accounts: accounts.slice(-MAX_ACCOUNTS), ts: Math.floor(Date.now() / 1000) })
}

export function accountsCookieHeader(value: string, secure: boolean): string {
  return cookieHeader(getAccountsCookieName(), value, secure)
}

export function clearAccountsCookieHeader(): string {
  return `${getAccountsCookieName()}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

/** Every account this browser has signed in as, oldest first. */
export async function parseAccountsCookie(request: Request): Promise<SessionData[]> {
  const value = readCookie(request, getAccountsCookieName())
  if (!value) return []
  const data = await decrypt(value)
  if (!data?.ts || !Array.isArray(data.accounts)) return []
  if (Date.now() / 1000 - data.ts > MAX_AGE) return []
  return data.accounts.filter((a: unknown): a is SessionData => {
    const account = a as SessionData
    return !!account && typeof account.did === 'string' && typeof account.handle === 'string'
  })
}

/**
 * Add (or refresh) an account in the browser's list. Existing entries keep
 * their position so the switcher doesn't reshuffle; a re-login just updates
 * the handle.
 */
export function withAccount(accounts: SessionData[], account: SessionData): SessionData[] {
  const index = accounts.findIndex((a) => a.did === account.did)
  if (index === -1) return [...accounts, account]
  const next = [...accounts]
  next[index] = account
  return next
}

export function withoutAccount(accounts: SessionData[], did: string): SessionData[] {
  return accounts.filter((a) => a.did !== did)
}
