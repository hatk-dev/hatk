import { resolveTxt } from 'node:dns/promises'

// packages/hatk/src/oauth/discovery.ts

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  pushed_authorization_request_endpoint?: string
  jwks_uri: string
  dpop_signing_alg_values_supported?: string[]
  [key: string]: unknown
}

export async function resolveDid(did: string, plcUrl: string): Promise<any> {
  if (did.startsWith('did:web:')) {
    const domain = did.slice('did:web:'.length)
    const res = await fetch(`https://${domain}/.well-known/did.json`)
    if (!res.ok) throw new Error(`did:web resolution failed: ${res.status}`)
    return res.json()
  }
  const res = await fetch(`${plcUrl}/${did}`)
  if (!res.ok) throw new Error(`PLC resolution failed: ${res.status}`)
  return res.json()
}

export function getPdsEndpoint(didDoc: any): string | null {
  const service = didDoc.service?.find((s: any) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer')
  return service?.serviceEndpoint || null
}

export async function fetchProtectedResourceMetadata(
  pdsEndpoint: string,
): Promise<{ authorization_servers: string[] }> {
  const res = await fetch(`${pdsEndpoint}/.well-known/oauth-protected-resource`)
  if (!res.ok) throw new Error(`Protected resource metadata failed: ${res.status}`)
  return res.json()
}

export async function fetchAuthServerMetadata(authServerEndpoint: string): Promise<AuthServerMetadata> {
  const res = await fetch(`${authServerEndpoint}/.well-known/oauth-authorization-server`)
  if (!res.ok) throw new Error(`Auth server metadata failed: ${res.status}`)
  return res.json()
}

export async function discoverAuthServer(
  did: string,
  plcUrl: string,
): Promise<{
  pdsEndpoint: string
  authServerEndpoint: string
  authServerMetadata: AuthServerMetadata
}> {
  const didDoc = await resolveDid(did, plcUrl)
  const pdsEndpoint = getPdsEndpoint(didDoc)
  if (!pdsEndpoint) throw new Error(`No PDS endpoint in DID document for ${did}`)

  const protectedResource = await fetchProtectedResourceMetadata(pdsEndpoint)
  const authServerEndpoint = protectedResource.authorization_servers[0]
  if (!authServerEndpoint) throw new Error(`No auth server for PDS ${pdsEndpoint}`)

  const authServerMetadata = await fetchAuthServerMetadata(authServerEndpoint)
  return { pdsEndpoint, authServerEndpoint, authServerMetadata }
}

const HANDLE_RESOLVE_TIMEOUT_MS = 5000

/** The DNS method: a `_atproto.<handle>` TXT record carrying `did=...`. */
async function resolveHandleViaDns(handle: string): Promise<string | null> {
  try {
    for (const chunks of await resolveTxt(`_atproto.${handle}`)) {
      const txt = chunks.join('')
      if (txt.startsWith('did=')) return txt.slice('did='.length).trim()
    }
  } catch {
    // No record, or not a resolvable name: not this method.
  }
  return null
}

/** The HTTPS method: `https://<handle>/.well-known/atproto-did`, the DID as plain text. */
async function resolveHandleViaWellKnown(handle: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`, {
      signal: AbortSignal.timeout(HANDLE_RESOLVE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const did = (await res.text()).trim().split('\n')[0].trim()
    return did.startsWith('did:') ? did : null
  } catch {
    return null
  }
}

/**
 * A handle to its DID.
 *
 * The protocol defines two ways, and both are asked first: the DNS TXT record
 * and the well-known document. Either answers for a handle on any PDS, which
 * is what lets somebody from another host sign in here. A handle neither
 * method knows — a dev network's `.test` names, which have no DNS and no TLS
 * — falls back to asking a PDS: the local one in dev, the one behind a
 * self-hosted relay, or bsky.social.
 */
export async function resolveHandle(handle: string, relayUrl?: string): Promise<string> {
  const direct = (await resolveHandleViaDns(handle)) ?? (await resolveHandleViaWellKnown(handle))
  if (direct) return direct

  let baseUrl: string
  if (relayUrl?.includes('localhost:2583')) {
    baseUrl = 'http://localhost:2583'
  } else if (!relayUrl || relayUrl.includes('bsky.network')) {
    baseUrl = 'https://bsky.social'
  } else {
    baseUrl = relayUrl.replace(/^ws/, 'http') // wss://pds.example → https://pds.example
  }
  const res = await fetch(`${baseUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`)
  if (!res.ok) throw new Error(`resolveHandle failed: ${res.status}`)
  const data = await res.json()
  return data.did
}
