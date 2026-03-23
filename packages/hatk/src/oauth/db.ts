// packages/hatk/src/oauth/db.ts

import { querySQL, runSQL } from '../database/db.ts'

// --- DDL ---

export const OAUTH_DDL = `
CREATE TABLE IF NOT EXISTS _oauth_keys (
  kid TEXT PRIMARY KEY,
  private_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS _oauth_sessions (
  did TEXT PRIMARY KEY,
  pds_endpoint TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  dpop_jkt TEXT NOT NULL,
  token_expires_at INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS _oauth_requests (
  request_uri TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT,
  state TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  dpop_jkt TEXT NOT NULL,
  pds_request_uri TEXT,
  pds_auth_server TEXT,
  pds_endpoint TEXT,
  pds_code_verifier TEXT,
  pds_state TEXT,
  did TEXT,
  login_hint TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS _oauth_codes (
  code TEXT PRIMARY KEY,
  request_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS _oauth_refresh_tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  did TEXT NOT NULL,
  dpop_jkt TEXT NOT NULL,
  scope TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS _oauth_dpop_jtis (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`

// --- Key Management ---

export async function getServerKey(kid: string): Promise<{ privateKey: string; publicKey: string } | null> {
  const rows = (await querySQL('SELECT private_key, public_key FROM _oauth_keys WHERE kid = $1', [kid])) as { private_key: string; public_key: string }[]
  if (rows.length === 0) return null
  return { privateKey: rows[0].private_key, publicKey: rows[0].public_key }
}

export async function storeServerKey(kid: string, privateKey: string, publicKey: string): Promise<void> {
  await runSQL('INSERT OR REPLACE INTO _oauth_keys (kid, private_key, public_key) VALUES ($1, $2, $3)', [
    kid,
    privateKey,
    publicKey,
  ])
}

// --- OAuth Request Storage ---

export async function storeOAuthRequest(
  requestUri: string,
  data: {
    clientId: string
    redirectUri: string
    scope?: string
    state?: string
    codeChallenge: string
    codeChallengeMethod?: string
    dpopJkt: string
    pdsRequestUri?: string
    pdsAuthServer?: string
    pdsEndpoint?: string
    pdsCodeVerifier?: string
    pdsState?: string
    did?: string
    loginHint?: string
    expiresAt: number
  },
): Promise<void> {
  await runSQL(
    `INSERT INTO _oauth_requests (request_uri, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, dpop_jkt, pds_request_uri, pds_auth_server, pds_endpoint, pds_code_verifier, pds_state, did, login_hint, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      requestUri,
      data.clientId,
      data.redirectUri,
      data.scope || null,
      data.state || null,
      data.codeChallenge,
      data.codeChallengeMethod || 'S256',
      data.dpopJkt,
      data.pdsRequestUri || null,
      data.pdsAuthServer || null,
      data.pdsEndpoint || null,
      data.pdsCodeVerifier || null,
      data.pdsState || null,
      data.did || null,
      data.loginHint || null,
      data.expiresAt,
    ],
  )
}

export async function getOAuthRequest(requestUri: string): Promise<any | null> {
  const rows = await querySQL('SELECT * FROM _oauth_requests WHERE request_uri = $1 AND expires_at > $2', [
    requestUri,
    Math.floor(Date.now() / 1000),
  ])
  return rows.length > 0 ? rows[0] : null
}

export async function deleteOAuthRequest(requestUri: string): Promise<void> {
  await runSQL('DELETE FROM _oauth_requests WHERE request_uri = $1', [requestUri])
}

// --- Authorization Codes ---

export async function storeAuthCode(code: string, requestUri: string): Promise<void> {
  await runSQL('INSERT INTO _oauth_codes (code, request_uri, created_at) VALUES ($1, $2, $3)', [
    code,
    requestUri,
    Math.floor(Date.now() / 1000),
  ])
}

export async function consumeAuthCode(code: string): Promise<string | null> {
  const rows = (await querySQL('SELECT request_uri FROM _oauth_codes WHERE code = $1', [code])) as { request_uri: string }[]
  if (rows.length === 0) return null
  await runSQL('DELETE FROM _oauth_codes WHERE code = $1', [code])
  return rows[0].request_uri
}

// --- Sessions ---

export async function storeSession(
  did: string,
  data: {
    pdsEndpoint: string
    accessToken: string
    refreshToken?: string
    dpopJkt: string
    tokenExpiresAt?: number
  },
): Promise<void> {
  await runSQL(
    `INSERT OR REPLACE INTO _oauth_sessions (did, pds_endpoint, access_token, refresh_token, dpop_jkt, token_expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)`,
    [did, data.pdsEndpoint, data.accessToken, data.refreshToken || null, data.dpopJkt, data.tokenExpiresAt || null],
  )
}

export async function getSession(did: string): Promise<any | null> {
  const rows = await querySQL('SELECT * FROM _oauth_sessions WHERE did = $1', [did])
  return rows.length > 0 ? rows[0] : null
}

export async function deleteSession(did: string): Promise<void> {
  await runSQL('DELETE FROM _oauth_sessions WHERE did = $1', [did])
}

// --- Refresh Tokens ---

export async function storeRefreshToken(
  token: string,
  data: {
    clientId: string
    did: string
    dpopJkt: string
    scope?: string
    expiresAt?: number
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = data.expiresAt ?? now + 14 * 86400 // 14 days default
  await runSQL(
    `INSERT INTO _oauth_refresh_tokens (token, client_id, did, dpop_jkt, scope, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [token, data.clientId, data.did, data.dpopJkt, data.scope || null, now, expiresAt],
  )
}

export async function getRefreshToken(token: string): Promise<any | null> {
  const rows = await querySQL('SELECT * FROM _oauth_refresh_tokens WHERE token = $1', [token])
  return rows.length > 0 ? rows[0] : null
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await runSQL('UPDATE _oauth_refresh_tokens SET revoked = 1 WHERE token = $1', [token])
}

// --- DPoP JTI Replay Protection ---

export async function checkAndStoreDpopJti(jti: string, expiresAt: number): Promise<boolean> {
  const rows = await querySQL('SELECT 1 FROM _oauth_dpop_jtis WHERE jti = $1', [jti])
  if (rows.length > 0) return false
  await runSQL('INSERT INTO _oauth_dpop_jtis (jti, expires_at) VALUES ($1, $2)', [jti, expiresAt])
  return true
}

export async function cleanupExpiredOAuth(): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await runSQL('DELETE FROM _oauth_dpop_jtis WHERE expires_at < $1', [now])
  await runSQL('DELETE FROM _oauth_requests WHERE expires_at < $1', [now])
  await runSQL('DELETE FROM _oauth_codes WHERE created_at < $1', [now - 600])
  await runSQL('DELETE FROM _oauth_refresh_tokens WHERE revoked = 1 OR (expires_at IS NOT NULL AND expires_at < $1)', [
    now,
  ])
}
