// packages/hatk/src/oauth/crypto.ts

const P256_N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
const P256_N_DIV_2 = P256_N / 2n

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = base64.length % 4
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return BigInt('0x' + hex)
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const hex = n.toString(16).padStart(length * 2, '0')
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export async function generateKeyPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  return { privateJwk, publicJwk }
}

export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
}

export async function signEs256(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data as BufferSource)
  const sig = new Uint8Array(signature)
  const r = sig.slice(0, 32)
  const s = sig.slice(32, 64)
  const sBigInt = bytesToBigInt(s)
  // Low-S normalization (AT Protocol requirement)
  if (sBigInt > P256_N_DIV_2) {
    const newS = P256_N - sBigInt
    const normalized = new Uint8Array(64)
    normalized.set(r, 0)
    normalized.set(bigIntToBytes(newS, 32), 32)
    return normalized
  }
  return sig
}

export async function verifyEs256(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature as BufferSource,
    data as BufferSource,
  )
}

export async function computeJwkThumbprint(jwk: {
  kty?: string
  crv?: string
  x?: string
  y?: string
}): Promise<string> {
  const input = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return base64UrlEncode(new Uint8Array(hash))
}

export async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))
}

export function createJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature: Uint8Array,
): string {
  const h = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))
  const p = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const s = base64UrlEncode(signature)
  return `${h}.${p}.${s}`
}

export function parseJwt(token: string): {
  header: any
  payload: any
  signatureInput: Uint8Array
  signature: Uint8Array
} {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])))
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])))
  const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = base64UrlDecode(parts[2])
  return { header, payload, signatureInput, signature }
}

export async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
): Promise<string> {
  const h = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))
  const p = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const input = new TextEncoder().encode(`${h}.${p}`)
  const sig = await signEs256(privateKey, input)
  return `${h}.${p}.${base64UrlEncode(sig)}`
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function randomToken(): string {
  return base64UrlEncode(randomBytes(32))
}
