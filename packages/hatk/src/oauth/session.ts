// SSR session cookie — AES-GCM encrypted HttpOnly cookie for server-side viewer resolution.
// Separate from OAuth protocol flows but uses the same server keypair for key derivation.

import { base64UrlEncode, base64UrlDecode } from './crypto.ts'

let _privateJwk: JsonWebKey
let _cookieName = '__hatk_session'
const MAX_AGE = 30 * 24 * 60 * 60 // 30 days in seconds

export type SessionData = { did: string; handle: string }

export function getSessionCookieName(): string {
  return _cookieName
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

export async function createSessionCookie(data: SessionData): Promise<string> {
  const payload = JSON.stringify({ ...data, ts: Math.floor(Date.now() / 1000) })
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await aesKey()
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(payload))
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`
}

export function sessionCookieHeader(value: string, secure: boolean): string {
  const parts = [`${_cookieName}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${MAX_AGE}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookieHeader(): string {
  return `${_cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

export async function parseSessionCookie(request: Request): Promise<SessionData | null> {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return null
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${_cookieName}=`))
  if (!match) return null
  const value = match.slice(_cookieName.length + 1)
  const parts = value.split('.')
  if (parts.length !== 2) return null
  try {
    const iv = base64UrlDecode(parts[0]) as Uint8Array<ArrayBuffer>
    const ciphertext = base64UrlDecode(parts[1]) as Uint8Array<ArrayBuffer>
    const key = await aesKey()
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    const data = JSON.parse(new TextDecoder().decode(plaintext))
    if (!data.did || !data.handle || !data.ts) return null
    if (Date.now() / 1000 - data.ts > MAX_AGE) return null
    return { did: data.did, handle: data.handle }
  } catch {
    return null
  }
}
