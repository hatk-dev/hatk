// packages/hatk/src/oauth/server.ts

import type { OAuthConfig } from '../config.ts'
import {
  generateKeyPair,
  importPrivateKey,
  computeJwkThumbprint,
  signJwt,
  parseJwt,
  verifyEs256,
  importPublicKey,
  randomToken,
  sha256,
  base64UrlEncode,
} from './crypto.ts'
import { parseDpopProof, createDpopProof } from './dpop.ts'
import { resolveClient, validateRedirectUri, isLoopbackClient } from './client.ts'
import { discoverAuthServer, resolveHandle } from './discovery.ts'
import {
  getServerKey,
  storeServerKey,
  storeOAuthRequest,
  getOAuthRequest,
  deleteOAuthRequest,
  storeAuthCode,
  consumeAuthCode,
  storeSession,
  checkAndStoreDpopJti,
  cleanupExpiredOAuth,
  storeRefreshToken,
  getRefreshToken,
  revokeRefreshToken,
} from './db.ts'
import { emit } from '../logger.ts'
import { querySQL } from '../db.ts'
import { fireOnLoginHook } from './hooks.ts'

const SERVER_KEY_KID = 'appview-oauth-key'

async function resolveHandleForDid(did: string): Promise<string | undefined> {
  const rows = await querySQL('SELECT handle FROM _repos WHERE did = $1', [did]) as { handle: string }[]
  return rows[0]?.handle || undefined
}

/** Convert localhost to 127.0.0.1 for RFC 8252 compliance (PDS requirement). */
function toLoopbackIp(url: string): string {
  return url.replace(/\/\/localhost([:/])/g, '//127.0.0.1$1').replace(/\/\/localhost$/, '//127.0.0.1')
}

/** PDS-facing redirect_uri: loopback must use 127.0.0.1 per RFC 8252. */
function pdsRedirectUri(issuer: string): string {
  if (isLoopbackClient(issuer)) return `${toLoopbackIp(issuer)}/oauth/callback`
  return `${issuer}/oauth/callback`
}

/** PDS-facing client_id: loopback encodes redirect_uri+scope per AT Proto spec, production uses metadata URL. */
function pdsClientId(issuer: string, config?: OAuthConfig): string {
  if (isLoopbackClient(issuer)) {
    const redirectUri = pdsRedirectUri(issuer)
    // Use scope from matching client config (try bare issuer, then metadata URL)
    const client =
      config?.clients.find((c) => c.client_id === issuer) ||
      config?.clients.find((c) => c.client_id === `${issuer}/oauth-client-metadata.json`)
    const scope = client?.scope || 'atproto transition:generic'
    return `http://localhost/?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`
  }
  return `${issuer}/oauth-client-metadata.json`
}

let serverPrivateJwk: JsonWebKey
let serverPublicJwk: JsonWebKey
let serverPrivateKey: CryptoKey
let serverJkt: string
let _plcUrl: string
let _relayUrl: string

export async function initOAuth(_config: OAuthConfig, plcUrl: string, relayUrl: string): Promise<void> {
  _plcUrl = plcUrl
  _relayUrl = relayUrl
  // Load or generate server key pair
  const existing = await getServerKey(SERVER_KEY_KID)
  if (existing) {
    serverPrivateJwk = JSON.parse(existing.privateKey)
    serverPublicJwk = JSON.parse(existing.publicKey)
  } else {
    const kp = await generateKeyPair()
    serverPrivateJwk = kp.privateJwk
    serverPublicJwk = kp.publicJwk
    await storeServerKey(SERVER_KEY_KID, JSON.stringify(serverPrivateJwk), JSON.stringify(serverPublicJwk))
  }
  serverPrivateKey = await importPrivateKey(serverPrivateJwk)
  serverJkt = await computeJwkThumbprint(serverPublicJwk)

  // Periodic cleanup of expired OAuth data
  setInterval(() => cleanupExpiredOAuth().catch(() => {}), 60_000)
}

// --- Metadata Endpoints ---

export function getAuthServerMetadata(issuer: string, config: OAuthConfig) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    pushed_authorization_request_endpoint: `${issuer}/oauth/par`,
    jwks_uri: `${issuer}/oauth/jwks`,
    scopes_supported: config.scopes,
    subject_types_supported: ['public'],
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'fragment'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    dpop_signing_alg_values_supported: ['ES256'],
    require_pushed_authorization_requests: false,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    protected_resources: [issuer],
  }
}

export function getProtectedResourceMetadata(issuer: string, config: OAuthConfig) {
  return {
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: config.scopes,
  }
}

export function getJwks() {
  return {
    keys: [
      {
        ...serverPublicJwk,
        kid: SERVER_KEY_KID,
        use: 'sig',
        alg: 'ES256',
      },
    ],
  }
}

export function getClientMetadata(issuer: string, config: OAuthConfig) {
  // Find the metadata client entry to get its scope
  const metadataClientId = `${issuer}/oauth-client-metadata.json`
  const clientConfig = config.clients.find((c) => c.client_id === metadataClientId)
  return {
    client_id: metadataClientId,
    client_name: clientConfig?.client_name || 'hatk',
    redirect_uris: [`${issuer}/oauth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
    scope: clientConfig?.scope || 'atproto transition:generic',
  }
}

// --- PAR Endpoint ---

export async function handlePar(
  config: OAuthConfig,
  body: Record<string, string>,
  dpopHeader: string,
  requestUrl: string,
): Promise<{ request_uri: string; expires_in: number }> {
  // Validate client DPoP proof
  const dpop = await parseDpopProof(dpopHeader, 'POST', requestUrl)
  const fresh = await checkAndStoreDpopJti(dpop.jti, dpop.iat + 300)
  if (!fresh) throw new Error('DPoP jti replay detected')

  // Validate client
  const clientId = body.client_id
  if (!clientId) throw new Error('client_id is required')
  const client = resolveClient(clientId, config.clients)
  if (!client) throw new Error(`Unknown client: ${clientId}`)

  // Validate redirect_uri
  const redirectUri = body.redirect_uri
  if (!redirectUri) throw new Error('redirect_uri is required')
  if (!validateRedirectUri(client, redirectUri)) throw new Error('Invalid redirect_uri')

  // Validate PKCE
  if (!body.code_challenge) throw new Error('code_challenge is required')
  if (body.code_challenge_method && body.code_challenge_method !== 'S256') throw new Error('Only S256 supported')

  // Resolve DID from login_hint
  let did = body.login_hint
  if (did && !did.startsWith('did:')) {
    did = await resolveHandle(did, _relayUrl)
  }

  // Discover user's PDS auth server
  let pdsRequestUri: string | undefined
  let pdsAuthServer: string | undefined
  let pdsCodeVerifier: string | undefined
  let pdsState: string | undefined

  if (did) {
    const discovery = await discoverAuthServer(did, _plcUrl)
    pdsAuthServer = discovery.authServerEndpoint

    // Create PKCE for our PAR to the PDS
    pdsCodeVerifier = randomToken()
    const pdsCodeChallenge = base64UrlEncode(await sha256(pdsCodeVerifier))
    pdsState = randomToken() // unique state to correlate callback

    // PAR to the PDS
    const parEndpoint =
      discovery.authServerMetadata.pushed_authorization_request_endpoint || `${pdsAuthServer}/oauth/par`
    const serverDpopProof = await createDpopProof(serverPrivateJwk, serverPublicJwk, 'POST', parEndpoint)

    const pdsParBody = new URLSearchParams({
      client_id: pdsClientId(config.issuer, config),
      redirect_uri: pdsRedirectUri(config.issuer),
      response_type: 'code',
      code_challenge: pdsCodeChallenge,
      code_challenge_method: 'S256',
      scope: body.scope || 'atproto transition:generic',
      login_hint: body.login_hint || did,
      state: pdsState,
    })

    const pdsParRes = await fetch(parEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: serverDpopProof },
      body: pdsParBody.toString(),
    })

    if (!pdsParRes.ok) {
      // Handle DPoP nonce retry
      const errBody = await pdsParRes.json().catch(() => ({}))
      if (errBody.error === 'use_dpop_nonce') {
        const nonce = pdsParRes.headers.get('DPoP-Nonce')
        if (nonce) {
          const retryProof = await createDpopProof(
            serverPrivateJwk,
            serverPublicJwk,
            'POST',
            parEndpoint,
            undefined,
            nonce,
          )
          const retryRes = await fetch(parEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: retryProof },
            body: pdsParBody.toString(),
          })
          if (!retryRes.ok) {
            const retryErr = await retryRes.json().catch(() => ({}))
            emit('oauth', 'pds_par_error', {
              status: retryRes.status,
              error: retryErr.error,
              error_description: retryErr.error_description,
              retry: true,
            })
            throw new Error(`PDS PAR failed: ${retryRes.status} ${retryErr.error_description || retryErr.error || ''}`)
          }
          const retryData = await retryRes.json()
          pdsRequestUri = retryData.request_uri
        }
      } else {
        emit('oauth', 'pds_par_error', {
          status: pdsParRes.status,
          error: errBody.error,
          error_description: errBody.error_description,
          endpoint: parEndpoint,
          client_id: pdsParBody.get('client_id'),
          redirect_uri: pdsParBody.get('redirect_uri'),
        })
        throw new Error(`PDS PAR failed: ${pdsParRes.status} ${errBody.error_description || errBody.error || ''}`)
      }
    } else {
      const pdsParData = await pdsParRes.json()
      pdsRequestUri = pdsParData.request_uri
    }
  }

  // Store our authorization request
  const requestUri = `urn:ietf:params:oauth:request_uri:${randomToken()}`
  const expiresAt = Math.floor(Date.now() / 1000) + 600

  await storeOAuthRequest(requestUri, {
    clientId,
    redirectUri,
    scope: body.scope,
    state: body.state,
    codeChallenge: body.code_challenge,
    codeChallengeMethod: body.code_challenge_method || 'S256',
    dpopJkt: dpop.jkt,
    pdsRequestUri,
    pdsAuthServer,
    pdsCodeVerifier,
    pdsState,
    did,
    loginHint: body.login_hint,
    expiresAt,
  })

  return { request_uri: requestUri, expires_in: 600 }
}

// --- Authorize Endpoint ---

export function buildAuthorizeRedirect(config: OAuthConfig, request: any): string {
  if (!request.pds_auth_server || !request.pds_request_uri) {
    throw new Error('Authorization request missing PDS data')
  }
  const params = new URLSearchParams({
    request_uri: request.pds_request_uri,
    client_id: pdsClientId(config.issuer, config),
  })
  return `${request.pds_auth_server}/oauth/authorize?${params}`
}

// --- OAuth Callback (PDS redirects here) ---

export async function handleCallback(
  config: OAuthConfig,
  code: string,
  state: string | null,
  iss: string | null,
): Promise<{ requestUri: string; clientRedirectUri: string; clientState: string | null }> {
  // Find the matching OAuth request by pds_state (unique per PAR)
  const { querySQL } = await import('../db.ts')
  let request: any = null

  if (state) {
    const rows = await querySQL(`SELECT * FROM _oauth_requests WHERE pds_state = $1 AND expires_at > $2`, [
      state,
      Math.floor(Date.now() / 1000),
    ])
    request = rows.length > 0 ? rows[0] : null
  }

  // Fallback: match by iss (legacy requests without pds_state)
  if (!request && iss) {
    const rows = await querySQL(
      `SELECT * FROM _oauth_requests WHERE pds_auth_server = $1 AND expires_at > $2 ORDER BY expires_at DESC`,
      [iss, Math.floor(Date.now() / 1000)],
    )
    request = rows.length > 0 ? rows[0] : null
  }

  if (!request) throw new Error('No matching authorization request found')

  // Exchange code at PDS token endpoint
  const tokenEndpoint = `${request.pds_auth_server}/oauth/token`
  const serverDpopProof = await createDpopProof(serverPrivateJwk, serverPublicJwk, 'POST', tokenEndpoint)

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pdsRedirectUri(config.issuer),
    client_id: pdsClientId(config.issuer, config),
    code_verifier: request.pds_code_verifier,
  })

  let tokenRes = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: serverDpopProof },
    body: tokenBody.toString(),
  })

  // Handle DPoP nonce retry
  if (!tokenRes.ok) {
    const errBody = await tokenRes.json().catch(() => ({}))
    if (errBody.error === 'use_dpop_nonce') {
      const nonce = tokenRes.headers.get('DPoP-Nonce')
      if (nonce) {
        const retryProof = await createDpopProof(
          serverPrivateJwk,
          serverPublicJwk,
          'POST',
          tokenEndpoint,
          undefined,
          nonce,
        )
        tokenRes = await fetch(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: retryProof },
          body: tokenBody.toString(),
        })
        if (!tokenRes.ok) {
          const retryErr = await tokenRes.json().catch(() => ({}))
          emit('oauth', 'pds_token_exchange_error', {
            status: tokenRes.status,
            error: retryErr.error,
            error_description: retryErr.error_description,
            retry: true,
          })
          throw new Error(
            `PDS token exchange failed: ${tokenRes.status} ${retryErr.error_description || retryErr.error || ''}`,
          )
        }
      } else {
        throw new Error(`PDS token exchange failed: DPoP nonce required but not provided`)
      }
    } else {
      emit('oauth', 'pds_token_exchange_error', {
        status: tokenRes.status,
        error: errBody.error,
        error_description: errBody.error_description,
        client_id: tokenBody.get('client_id'),
        redirect_uri: tokenBody.get('redirect_uri'),
      })
      throw new Error(
        `PDS token exchange failed: ${tokenRes.status} ${errBody.error_description || errBody.error || ''}`,
      )
    }
  }

  const tokenData = await tokenRes.json()
  const did = tokenData.sub
  if (!did) throw new Error('PDS token response missing sub (DID)')

  // Store PDS session server-side
  await storeSession(did, {
    pdsEndpoint: request.pds_auth_server.replace('/oauth', ''),
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    dpopJkt: serverJkt,
    tokenExpiresAt: tokenData.expires_in ? Math.floor(Date.now() / 1000) + tokenData.expires_in : undefined,
  })

  await fireOnLoginHook(did)

  // Generate authorization code for the client
  const clientCode = randomToken()
  await storeAuthCode(clientCode, request.request_uri)

  // Update the request with the DID (in case it wasn't set during PAR)
  if (!request.did && did) {
    const { runSQL } = await import('../db.ts')
    await runSQL('UPDATE _oauth_requests SET did = $1 WHERE request_uri = $2', did, request.request_uri)
  }

  // Build redirect back to client
  const params = new URLSearchParams({ code: clientCode, iss: config.issuer })
  if (request.state) params.set('state', request.state)
  const clientRedirectUri = `${request.redirect_uri}?${params}`

  return { requestUri: request.request_uri, clientRedirectUri, clientState: request.state }
}

// --- Token Endpoint ---

export async function handleToken(
  config: OAuthConfig,
  body: Record<string, string>,
  dpopHeader: string,
  requestUrl: string,
): Promise<any> {
  const grantType = body.grant_type
  if (!grantType) throw new Error('grant_type is required')

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(config, body, dpopHeader, requestUrl)
  } else if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(config, body, dpopHeader, requestUrl)
  }
  throw new Error(`Unsupported grant_type: ${grantType}`)
}

async function handleAuthorizationCodeGrant(
  config: OAuthConfig,
  body: Record<string, string>,
  dpopHeader: string,
  requestUrl: string,
) {
  const dpop = await parseDpopProof(dpopHeader, 'POST', requestUrl)
  const fresh = await checkAndStoreDpopJti(dpop.jti, dpop.iat + 300)
  if (!fresh) throw new Error('DPoP jti replay detected')

  const { code, client_id, redirect_uri, code_verifier } = body
  if (!code || !client_id || !redirect_uri || !code_verifier) {
    throw new Error('Missing required parameters')
  }

  // Consume one-time code
  const requestUri = await consumeAuthCode(code)
  if (!requestUri) throw new Error('Invalid or expired authorization code')

  const request = await getOAuthRequest(requestUri)
  if (!request) throw new Error('Authorization request not found')

  // Validate
  if (request.client_id !== client_id) throw new Error('client_id mismatch')
  if (request.redirect_uri !== redirect_uri) throw new Error('redirect_uri mismatch')

  // Verify PKCE
  const challengeHash = base64UrlEncode(await sha256(code_verifier))
  if (challengeHash !== request.code_challenge) throw new Error('PKCE verification failed')

  // Verify DPoP key matches PAR
  if (request.dpop_jkt !== dpop.jkt) throw new Error('DPoP key mismatch')

  // Find the DID from the PDS session (stored during callback)
  const did = request.did
  if (!did) throw new Error('No DID associated with this request')

  // Issue appview access token
  const tokenId = randomToken()
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = 3600

  const accessToken = await signJwt(
    { typ: 'at+jwt', alg: 'ES256', kid: SERVER_KEY_KID },
    {
      iss: config.issuer,
      sub: did,
      aud: config.issuer,
      client_id,
      scope: request.scope || 'atproto',
      jti: tokenId,
      iat: now,
      exp: now + expiresIn,
      cnf: { jkt: dpop.jkt },
    },
    serverPrivateKey,
  )

  // Issue refresh token with rotation support
  const refreshToken = randomToken()
  await storeRefreshToken(refreshToken, {
    clientId: client_id,
    did,
    dpopJkt: dpop.jkt,
    scope: request.scope || 'atproto',
  })

  // Cleanup
  await deleteOAuthRequest(requestUri)

  const handle = await resolveHandleForDid(did)

  return {
    access_token: accessToken,
    token_type: 'DPoP',
    expires_in: expiresIn,
    refresh_token: refreshToken,
    sub: did,
    handle,
  }
}

async function handleRefreshTokenGrant(
  config: OAuthConfig,
  body: Record<string, string>,
  dpopHeader: string,
  requestUrl: string,
) {
  const dpop = await parseDpopProof(dpopHeader, 'POST', requestUrl)
  const fresh = await checkAndStoreDpopJti(dpop.jti, dpop.iat + 300)
  if (!fresh) throw new Error('DPoP jti replay detected')

  const { refresh_token, client_id } = body
  if (!refresh_token || !client_id) throw new Error('Missing required parameters')

  // Look up and validate refresh token
  const stored = await getRefreshToken(refresh_token)
  if (!stored) throw new Error('Invalid refresh token')
  if (stored.revoked) throw new Error('Refresh token revoked')
  if (stored.expires_at && stored.expires_at < Math.floor(Date.now() / 1000)) throw new Error('Refresh token expired')
  if (stored.client_id !== client_id) throw new Error('client_id mismatch')

  // Revoke old refresh token (rotation)
  await revokeRefreshToken(refresh_token)

  const did = stored.did as string
  const scope = (stored.scope as string) || 'atproto'

  // Issue new access token
  const tokenId = randomToken()
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = 3600

  const accessToken = await signJwt(
    { typ: 'at+jwt', alg: 'ES256', kid: SERVER_KEY_KID },
    {
      iss: config.issuer,
      sub: did,
      aud: config.issuer,
      client_id,
      scope,
      jti: tokenId,
      iat: now,
      exp: now + expiresIn,
      cnf: { jkt: dpop.jkt },
    },
    serverPrivateKey,
  )

  // Issue new refresh token (rotation)
  const newRefreshToken = randomToken()
  await storeRefreshToken(newRefreshToken, {
    clientId: client_id,
    did,
    dpopJkt: dpop.jkt,
    scope,
  })

  const handle = await resolveHandleForDid(did)

  return {
    access_token: accessToken,
    token_type: 'DPoP',
    expires_in: expiresIn,
    refresh_token: newRefreshToken,
    sub: did,
    handle,
  }
}

// --- PDS Session Refresh ---

export async function refreshPdsSession(
  config: OAuthConfig,
  session: { did: string; pds_endpoint: string; refresh_token: string; dpop_jkt: string },
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number } | null> {
  if (!session.refresh_token) return null

  const tokenEndpoint = `${session.pds_endpoint}/oauth/token`
  const clientId = pdsClientId(config.issuer, config)
  const dpopProof = await createDpopProof(serverPrivateJwk, serverPublicJwk, 'POST', tokenEndpoint)

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refresh_token,
    client_id: clientId,
  })

  let tokenRes = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopProof },
    body: body.toString(),
  })

  // Handle DPoP nonce retry
  if (!tokenRes.ok) {
    const errBody = await tokenRes.json().catch(() => ({}))
    if (errBody.error === 'use_dpop_nonce') {
      const nonce = tokenRes.headers.get('DPoP-Nonce')
      if (nonce) {
        const retryProof = await createDpopProof(
          serverPrivateJwk,
          serverPublicJwk,
          'POST',
          tokenEndpoint,
          undefined,
          nonce,
        )
        tokenRes = await fetch(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: retryProof },
          body: body.toString(),
        })
      }
    }
  }

  if (!tokenRes.ok) {
    emit('oauth', 'pds_session_refresh_error', {
      status: tokenRes.status,
      did: session.did,
      pds_endpoint: session.pds_endpoint,
    })
    return null
  }

  const tokenData = await tokenRes.json()

  // Update stored session
  await storeSession(session.did, {
    pdsEndpoint: session.pds_endpoint,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || session.refresh_token,
    dpopJkt: session.dpop_jkt,
    tokenExpiresAt: tokenData.expires_in ? Math.floor(Date.now() / 1000) + tokenData.expires_in : undefined,
  })

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: tokenData.expires_in ? Math.floor(Date.now() / 1000) + tokenData.expires_in : undefined,
  }
}

// --- Token Validation (for API calls) ---

export async function authenticate(
  authHeader: string | null,
  dpopHeader: string | null,
  method: string,
  url: string,
): Promise<{ did: string } | null> {
  if (!authHeader) return null

  const dpopMatch = authHeader.match(/^DPoP\s+(.+)$/i)
  if (!dpopMatch) return null
  if (!dpopHeader) return null

  const token = dpopMatch[1]
  const { payload, signatureInput, signature } = parseJwt(token)

  // Check expiration
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp && payload.exp < now) return null

  // Verify DPoP proof
  const dpop = await parseDpopProof(dpopHeader, method, url, undefined, token)

  // Verify token's cnf.jkt matches DPoP key
  if (payload.cnf?.jkt && payload.cnf.jkt !== dpop.jkt) return null

  // Verify token signature with our public key
  const publicKey = await importPublicKey(serverPublicJwk)
  const valid = await verifyEs256(publicKey, signature, signatureInput)
  if (!valid) return null

  return { did: payload.sub }
}
