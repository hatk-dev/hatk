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

export async function resolveHandle(handle: string, relayUrl?: string): Promise<string> {
  const baseUrl = relayUrl?.includes('localhost:2583') ? 'http://localhost:2583' : 'https://bsky.social'
  const res = await fetch(`${baseUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`)
  if (!res.ok) throw new Error(`resolveHandle failed: ${res.status}`)
  const data = await res.json()
  return data.did
}
