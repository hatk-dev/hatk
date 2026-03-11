// Browser crypto utilities for OAuth (DPoP, PKCE, JWT)

export function base64UrlEncode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomString(byteLength = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))
}

export async function sha256Base64Url(data) {
  return base64UrlEncode(await sha256(data))
}

export async function signJwt(header, payload, privateKey) {
  const enc = new TextEncoder()
  const h = base64UrlEncode(enc.encode(JSON.stringify(header)))
  const p = base64UrlEncode(enc.encode(JSON.stringify(payload)))
  const input = `${h}.${p}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(input))
  return `${input}.${base64UrlEncode(sig)}`
}
