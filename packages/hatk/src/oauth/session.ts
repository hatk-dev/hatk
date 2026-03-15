// SSR session cookie — signed HttpOnly cookie for server-side viewer resolution.
// Separate from OAuth protocol flows but uses the same server keypair.

import { base64UrlEncode, base64UrlDecode } from './crypto.ts'

let _privateJwk: JsonWebKey
let _cookieName = '__hatk_session'
const MAX_AGE = 30 * 24 * 60 * 60 // 30 days in seconds

export function getSessionCookieName(): string {
  return _cookieName
}

export function initSession(privateJwk: JsonWebKey, cookieName?: string): void {
  _privateJwk = privateJwk
  if (cookieName) _cookieName = cookieName
}

async function hmacKey(usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(JSON.stringify(_privateJwk, Object.keys(_privateJwk).sort())),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

export async function createSessionCookie(did: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const payload = `${did}.${timestamp}`
  const key = await hmacKey('sign')
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${base64UrlEncode(new Uint8Array(sig))}`
}

export function sessionCookieHeader(value: string, secure: boolean): string {
  const parts = [
    `${_cookieName}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${MAX_AGE}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookieHeader(): string {
  return `${_cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

export async function parseSessionCookie(request: Request): Promise<{ did: string } | null> {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return null
  const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith(`${_cookieName}=`))
  if (!match) return null
  const value = match.slice(_cookieName.length + 1)
  const parts = value.split('.')
  // Format: did:plc:xxx.timestamp.signature — DID contains dots so take last 2 parts
  if (parts.length < 3) return null
  const signature = parts.pop()!
  const timestamp = parts.pop()!
  const did = parts.join('.')
  const ts = Number(timestamp)
  if (isNaN(ts) || (Date.now() / 1000 - ts) > MAX_AGE) return null
  const payload = `${did}.${timestamp}`
  const key = await hmacKey('verify')
  const sigBytes = base64UrlDecode(signature) as Uint8Array<ArrayBuffer>
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload))
  if (!valid) return null
  return { did }
}
