// packages/appview/src/oauth/client.ts

import type { OAuthClientConfig } from '../config.ts'

export interface ClientMetadata {
  client_id: string
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: string
  dpop_bound_access_tokens: boolean
  scope: string
}

export function isLoopbackClient(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    const host = url.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

export function getLoopbackClientMetadata(clientId: string): ClientMetadata {
  return {
    client_id: clientId,
    client_name: 'Loopback Client',
    redirect_uris: [clientId],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
    scope: 'atproto',
  }
}

export function resolveClient(clientId: string, registeredClients: OAuthClientConfig[]): ClientMetadata | null {
  if (isLoopbackClient(clientId)) return getLoopbackClientMetadata(clientId)

  const found = registeredClients.find((c) => c.client_id === clientId)
  if (!found) return null

  return {
    client_id: found.client_id,
    client_name: found.client_name,
    redirect_uris: found.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
    scope: 'atproto',
  }
}

export function validateRedirectUri(clientMetadata: ClientMetadata, redirectUri: string): boolean {
  if (isLoopbackClient(clientMetadata.client_id)) {
    // Loopback: match by origin only
    try {
      const clientOrigin = new URL(clientMetadata.client_id).origin
      const redirectOrigin = new URL(redirectUri).origin
      return clientOrigin === redirectOrigin
    } catch {
      return false
    }
  }
  return clientMetadata.redirect_uris.includes(redirectUri)
}
