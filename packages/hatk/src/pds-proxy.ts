// Shared PDS proxy functions — used by both HTTP route handlers and XRPC handlers.

import type { OAuthConfig } from './config.ts'
import { getSession, getServerKey, deleteSession } from './oauth/db.ts'
import { createDpopProof } from './oauth/dpop.ts'
import { refreshPdsSession } from './oauth/server.ts'
import { validateRecord } from '@bigmoves/lexicon'
import { getLexiconArray } from './database/schema.ts'
import { insertRecord, deleteRecord as dbDeleteRecord } from './database/db.ts'
import { emit } from './logger.ts'

export class ProxyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export class ScopeMissingProxyError extends ProxyError {
  constructor() {
    super(401, 'ScopeMissingError')
  }
}

// --- Low-level PDS proxy with DPoP + nonce retry + token refresh ---

interface PdsProxyResult {
  ok: boolean
  status: number
  body: Record<string, unknown>
  headers: Headers
}

type FetchFn = (token: string, nonce?: string) => Promise<PdsProxyResult>

/** Shared retry logic: DPoP nonce handling + token refresh. */
async function withDpopRetry(
  oauthConfig: OAuthConfig,
  session: { access_token: string; pds_endpoint: string; did: string; refresh_token: string; dpop_jkt: string },
  doFetch: FetchFn,
): Promise<PdsProxyResult> {
  let accessToken = session.access_token

  let result = await doFetch(accessToken)
  if (result.ok) return result

  let nonce: string | undefined

  // Step 1: handle DPoP nonce requirement
  if (result.body.error === 'use_dpop_nonce') {
    nonce = result.headers.get('DPoP-Nonce') || undefined
    if (nonce) {
      result = await doFetch(accessToken, nonce)
      if (result.ok) return result
    }
  }

  // Step 2: handle insufficient scope — clear session so user re-authenticates with updated scopes
  if (result.body.error === 'ScopeMissingError') {
    await deleteSession(session.did)
    throw new ScopeMissingProxyError()
  }

  // Step 3: handle expired PDS token — refresh and retry
  if (result.body.error === 'invalid_token') {
    const refreshed = await refreshPdsSession(oauthConfig, session)
    if (refreshed) {
      accessToken = refreshed.accessToken
      result = await doFetch(accessToken, nonce)
      if (result.ok) return result
      if (result.body.error === 'use_dpop_nonce') {
        nonce = result.headers.get('DPoP-Nonce') || undefined
        if (nonce) result = await doFetch(accessToken, nonce)
      }
    }
  }

  return result
}

async function proxyToPds(
  oauthConfig: OAuthConfig,
  session: { access_token: string; pds_endpoint: string; did: string; refresh_token: string; dpop_jkt: string },
  method: string,
  pdsUrl: string,
  body: unknown,
): Promise<PdsProxyResult> {
  const serverKey = await getServerKey('appview-oauth-key')
  const privateJwk = JSON.parse(serverKey!.privateKey)
  const publicJwk = JSON.parse(serverKey!.publicKey)

  return withDpopRetry(oauthConfig, session, async (token, nonce) => {
    const proof = await createDpopProof(privateJwk, publicJwk, method, pdsUrl, token, nonce)
    const res = await fetch(pdsUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${token}`,
        DPoP: proof,
      },
      body: JSON.stringify(body),
    })
    const resBody: Record<string, unknown> = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body: resBody, headers: res.headers }
  })
}

/** Proxy a raw binary request to the user's PDS with DPoP + nonce retry + token refresh. */
async function proxyToPdsRaw(
  oauthConfig: OAuthConfig,
  session: { access_token: string; pds_endpoint: string; did: string; refresh_token: string; dpop_jkt: string },
  pdsUrl: string,
  body: Uint8Array,
  contentType: string,
): Promise<PdsProxyResult> {
  const serverKey = await getServerKey('appview-oauth-key')
  const privateJwk = JSON.parse(serverKey!.privateKey)
  const publicJwk = JSON.parse(serverKey!.publicKey)

  return withDpopRetry(oauthConfig, session, async (token, nonce) => {
    const proof = await createDpopProof(privateJwk, publicJwk, 'POST', pdsUrl, token, nonce)
    const res = await fetch(pdsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        Authorization: `DPoP ${token}`,
        DPoP: proof,
      },
      body: Buffer.from(body),
    })
    const resBody: Record<string, unknown> = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body: resBody, headers: res.headers }
  })
}

// --- High-level proxy functions ---

export async function pdsCreateRecord(
  oauthConfig: OAuthConfig,
  viewer: { did: string },
  input: { collection: string; repo?: string; rkey?: string; record: Record<string, unknown> },
): Promise<{ uri?: string; cid?: string }> {
  const validationError = validateRecord(getLexiconArray(), input.collection, input.record)
  if (validationError) {
    throw new ProxyError(
      400,
      `InvalidRecord: ${validationError.path ? validationError.path + ': ' : ''}${validationError.message}`,
    )
  }

  const session = await getSession(viewer.did)
  if (!session) throw new ProxyError(401, 'No PDS session for user')

  const pdsUrl = `${session.pds_endpoint}/xrpc/com.atproto.repo.createRecord`
  const pdsBody = {
    repo: viewer.did,
    collection: input.collection,
    rkey: input.rkey,
    record: input.record,
  }

  const pdsRes = await proxyToPds(oauthConfig, session, 'POST', pdsUrl, pdsBody)
  if (!pdsRes.ok) throw new ProxyError(pdsRes.status, String(pdsRes.body.error || 'PDS write failed'))

  try {
    await insertRecord(input.collection, String(pdsRes.body.uri), String(pdsRes.body.cid), viewer.did, input.record)
  } catch (err: unknown) {
    emit('pds-proxy', 'local_index_error', {
      op: 'createRecord',
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return pdsRes.body as { uri?: string; cid?: string }
}

export async function pdsDeleteRecord(
  oauthConfig: OAuthConfig,
  viewer: { did: string },
  input: { collection: string; rkey: string },
): Promise<Record<string, unknown>> {
  const session = await getSession(viewer.did)
  if (!session) throw new ProxyError(401, 'No PDS session for user')

  const pdsUrl = `${session.pds_endpoint}/xrpc/com.atproto.repo.deleteRecord`
  const pdsBody = {
    repo: viewer.did,
    collection: input.collection,
    rkey: input.rkey,
  }

  const pdsRes = await proxyToPds(oauthConfig, session, 'POST', pdsUrl, pdsBody)
  if (!pdsRes.ok) throw new ProxyError(pdsRes.status, String(pdsRes.body.error || 'PDS delete failed'))

  try {
    const uri = `at://${viewer.did}/${input.collection}/${input.rkey}`
    await dbDeleteRecord(input.collection, uri)
  } catch (err: unknown) {
    emit('pds-proxy', 'local_index_error', {
      op: 'deleteRecord',
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return pdsRes.body
}

export async function pdsPutRecord(
  oauthConfig: OAuthConfig,
  viewer: { did: string },
  input: { collection: string; rkey: string; record: Record<string, unknown>; repo?: string },
): Promise<{ uri?: string; cid?: string }> {
  const validationError = validateRecord(getLexiconArray(), input.collection, input.record)
  if (validationError) {
    throw new ProxyError(
      400,
      `InvalidRecord: ${validationError.path ? validationError.path + ': ' : ''}${validationError.message}`,
    )
  }

  const session = await getSession(viewer.did)
  if (!session) throw new ProxyError(401, 'No PDS session for user')

  const pdsUrl = `${session.pds_endpoint}/xrpc/com.atproto.repo.putRecord`
  const pdsBody = {
    repo: viewer.did,
    collection: input.collection,
    rkey: input.rkey,
    record: input.record,
  }

  const pdsRes = await proxyToPds(oauthConfig, session, 'POST', pdsUrl, pdsBody)
  if (!pdsRes.ok) throw new ProxyError(pdsRes.status, String(pdsRes.body.error || 'PDS write failed'))

  try {
    await insertRecord(input.collection, String(pdsRes.body.uri), String(pdsRes.body.cid), viewer.did, input.record)
  } catch (err: unknown) {
    emit('pds-proxy', 'local_index_error', { op: 'putRecord', error: err instanceof Error ? err.message : String(err) })
  }

  return pdsRes.body as { uri?: string; cid?: string }
}

export async function pdsUploadBlob(
  oauthConfig: OAuthConfig,
  viewer: { did: string },
  body: Uint8Array,
  contentType: string,
): Promise<{ blob: unknown }> {
  const session = await getSession(viewer.did)
  if (!session) throw new ProxyError(401, 'No PDS session for user')

  const pdsUrl = `${session.pds_endpoint}/xrpc/com.atproto.repo.uploadBlob`
  const pdsRes = await proxyToPdsRaw(oauthConfig, session, pdsUrl, body, contentType)
  if (!pdsRes.ok) throw new ProxyError(pdsRes.status, String(pdsRes.body.error || 'PDS upload failed'))

  return pdsRes.body as { blob: unknown }
}
