/**
 * Push notification delivery via APNs HTTP/2 and FCM HTTP v1.
 *
 * Provides `push.send()` for use in on-commit hook context. Looks up device
 * tokens, builds a payload per platform, and sends over the transport that
 * platform's tokens belong to. Self-cleans tokens the vendor reports as dead —
 * Apple's 410, Google's UNREGISTERED. Fire-and-forget — failures are logged via
 * `emit()` but never throw.
 *
 * Either transport can be configured alone. A deployment with only an APNs key
 * still sends to iOS, and Android tokens simply sit unused until an FCM service
 * account is supplied.
 */
import { connect, type ClientHttp2Session } from 'node:http2'
import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { resolve } from 'node:path'
import { emit } from './logger.ts'
import { runSQL, querySQL } from './database/db.ts'

export interface ApnsConfig {
  keyFile: string
  keyId: string
  teamId: string
  bundleId: string
  production?: boolean
}

/**
 * Firebase Cloud Messaging, for Android devices.
 *
 * `keyFile` is a Google service-account JSON with the Firebase Messaging role,
 * resolved like the APNs key: relative to the config file. The project id is
 * read from that file unless overridden here.
 */
export interface FcmConfig {
  keyFile: string
  projectId?: string
}

export interface PushConfig {
  apns?: ApnsConfig
  fcm?: FcmConfig
}

export interface PushPayload {
  did: string
  title: string
  body: string
  data?: Record<string, string>
  collapseId?: string
  badge?: number
}

export interface PushInterface {
  send: (payload: PushPayload) => Promise<void>
}

interface FcmCredentials {
  clientEmail: string
  privateKey: string
  projectId: string
  tokenUri: string
}

let pushConfig: PushConfig | null = null
let apnsKey: string | null = null
let cachedJwt: { token: string; expires: number } | null = null
let http2Session: ClientHttp2Session | null = null
let fcmCredentials: FcmCredentials | null = null
let cachedFcmToken: { token: string; expires: number } | null = null

/** Where a service account trades its signed JWT for a bearer token. */
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'

/** The only scope FCM sending needs. */
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

/**
 * Initialize push with config. Must be called before send().
 *
 * Each transport is loaded on its own: a missing or malformed credential
 * disables that platform and leaves the other one sending, rather than taking
 * push down entirely.
 */
export function initPush(config: PushConfig, configDir: string): void {
  pushConfig = config
  apnsKey = null
  fcmCredentials = null
  cachedJwt = null
  cachedFcmToken = null

  if (config.apns) {
    const keyPath = resolve(configDir, config.apns.keyFile)
    try {
      apnsKey = readFileSync(keyPath, 'utf8')
    } catch {
      emit('push', 'init_error', { transport: 'apns', error: `APNs key file not found: ${keyPath}` })
    }
  }

  if (config.fcm) {
    const keyPath = resolve(configDir, config.fcm.keyFile)
    try {
      const account = JSON.parse(readFileSync(keyPath, 'utf8')) as {
        client_email?: string
        private_key?: string
        project_id?: string
        token_uri?: string
      }
      const projectId = config.fcm.projectId ?? account.project_id
      if (!account.client_email || !account.private_key || !projectId) {
        throw new Error('needs client_email, private_key and a project id')
      }
      fcmCredentials = {
        clientEmail: account.client_email,
        privateKey: account.private_key,
        projectId,
        tokenUri: account.token_uri ?? GOOGLE_TOKEN_URI,
      }
    } catch (err) {
      emit('push', 'init_error', {
        transport: 'fcm',
        error: `FCM service account unusable (${keyPath}): ${(err as Error).message}`,
      })
    }
  }

  if (!apnsKey && !fcmCredentials) pushConfig = null
}

/** Check if push is configured and at least one transport is usable. */
export function isPushEnabled(): boolean {
  return pushConfig !== null && (apnsKey !== null || fcmCredentials !== null)
}

/** Which platforms this process can actually deliver to, for startup logging. */
export function enabledPushTransports(): string[] {
  const transports: string[] = []
  if (apnsKey) transports.push('apns')
  if (fcmCredentials) transports.push('fcm')
  return transports
}

/** Build the push interface injected into hook contexts. */
export function buildPushInterface(): PushInterface {
  return { send }
}

/** Create a JWT for APNs authentication (cached for 50 minutes). */
function getApnsJwt(): string {
  if (cachedJwt && Date.now() < cachedJwt.expires) return cachedJwt.token
  const apns = pushConfig?.apns
  if (!apns || !apnsKey) throw new Error('APNs not initialized')

  const header = Buffer.from(
    JSON.stringify({
      alg: 'ES256',
      kid: apns.keyId,
    }),
  ).toString('base64url')

  const now = Math.floor(Date.now() / 1000)
  const claims = Buffer.from(
    JSON.stringify({
      iss: apns.teamId,
      iat: now,
    }),
  ).toString('base64url')

  const signer = createSign('SHA256')
  signer.update(`${header}.${claims}`)
  const signature = signer.sign(apnsKey, 'base64url')

  const token = `${header}.${claims}.${signature}`
  cachedJwt = { token, expires: Date.now() + 50 * 60 * 1000 }
  return token
}

/** Get or create an HTTP/2 connection to APNs. */
function getHttp2Session(): ClientHttp2Session {
  if (http2Session && !http2Session.closed && !http2Session.destroyed) {
    return http2Session
  }
  const host =
    pushConfig?.apns?.production !== false ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com'
  emit('push', 'connecting', { host })
  http2Session = connect(host, {
    peerMaxConcurrentStreams: 100,
  })
  http2Session.on('connect', () => {
    emit('push', 'connected', { host })
  })
  http2Session.on('error', (err: Error) => {
    emit('push', 'connection_error', { host, error: err.message })
    http2Session = null
  })
  http2Session.on('close', () => {
    http2Session = null
  })
  return http2Session
}

/** Send a push notification to all devices registered for a DID. */
async function send(payload: PushPayload): Promise<void> {
  if (!isPushEnabled()) return

  const tokens = (await querySQL(`SELECT token, platform FROM _push_tokens WHERE did = $1`, [payload.did])) as {
    token: string
    platform: string
  }[]

  if (tokens.length === 0) return

  // A device is reachable over exactly one transport, named by the platform it
  // registered under. An unrecognized platform is left alone rather than
  // guessed at — the row may belong to a client this build doesn't serve yet.
  const apnsTokens = tokens.filter((t) => t.platform === 'apns')
  const fcmTokens = tokens.filter((t) => t.platform === 'fcm')

  if (apnsKey && apnsTokens.length > 0) {
    const jwt = getApnsJwt()
    const aps: Record<string, unknown> = {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
    }
    if (payload.badge !== undefined) {
      aps.badge = payload.badge
    }
    const apnsPayload = JSON.stringify({
      aps,
      ...(payload.data || {}),
    })

    for (const { token } of apnsTokens) {
      sendToApns(token, apnsPayload, jwt, payload).catch(() => {})
    }
  }

  if (fcmCredentials && fcmTokens.length > 0) {
    // One access token serves every device in this fan-out; it's minted once
    // and cached for the hour Google grants it.
    let accessToken: string
    try {
      accessToken = await getFcmAccessToken()
    } catch (err) {
      emit('push', 'send_error', { did: payload.did, transport: 'fcm', error: (err as Error).message })
      return
    }
    for (const { token } of fcmTokens) {
      sendToFcm(token, accessToken, payload).catch(() => {})
    }
  }
}

/** Send a single APNs push and handle the response. */
async function sendToApns(token: string, payload: string, jwt: string, original: PushPayload): Promise<void> {
  const apns = pushConfig?.apns
  if (!apns) return
  const session = getHttp2Session()
  const headers: Record<string, string> = {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    authorization: `bearer ${jwt}`,
    'apns-topic': apns.bundleId,
    'apns-push-type': 'alert',
  }
  if (original.collapseId) {
    headers['apns-collapse-id'] = original.collapseId
  }

  return new Promise<void>((resolve) => {
    const req = session.request(headers)
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }

    req.setTimeout(15_000, () => {
      req.close()
      emit('push', 'send_error', { did: original.did, error: 'APNs request timed out' })
      done()
    })
    let status = 0
    let body = ''

    req.on('response', (headers) => {
      status = headers[':status'] as number
    })
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', async () => {
      if (settled) return
      if (status === 200) {
        emit('push', 'sent', { did: original.did, token: token.slice(0, 8) + '...' })
      } else if (status === 410) {
        // Token is no longer valid — remove it
        await removeToken(token).catch(() => {})
        emit('push', 'token_removed', { did: original.did, reason: 'expired' })
      } else {
        emit('push', 'send_error', {
          did: original.did,
          status,
          body: body.slice(0, 200),
        })
      }
      done()
    })
    req.on('error', (err: Error) => {
      if (settled) return
      emit('push', 'send_error', { did: original.did, error: err.message })
      done()
    })

    req.write(payload)
    req.end()
  })
}

/**
 * Mint an OAuth2 access token for the FCM HTTP v1 API.
 *
 * The service account signs a JWT asserting the messaging scope, and Google
 * trades it for a bearer token good for an hour. Cached with a minute of
 * headroom so one can't expire between minting and the send that uses it.
 */
async function getFcmAccessToken(): Promise<string> {
  if (cachedFcmToken && Date.now() < cachedFcmToken.expires) return cachedFcmToken.token
  if (!fcmCredentials) throw new Error('FCM not initialized')

  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claims = Buffer.from(
    JSON.stringify({
      iss: fcmCredentials.clientEmail,
      scope: FCM_SCOPE,
      aud: fcmCredentials.tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url')

  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  const assertion = `${header}.${claims}.${signer.sign(fcmCredentials.privateKey, 'base64url')}`

  const res = await fetch(fcmCredentials.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`FCM token exchange failed: ${res.status} ${body.slice(0, 200)}`)
  }

  const granted = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!granted.access_token) throw new Error('FCM token exchange returned no access_token')

  cachedFcmToken = {
    token: granted.access_token,
    expires: Date.now() + ((granted.expires_in ?? 3600) - 60) * 1000,
  }
  return cachedFcmToken.token
}

/** Send a single FCM push and handle the response. */
async function sendToFcm(token: string, accessToken: string, original: PushPayload): Promise<void> {
  // Data-only, deliberately: a `notification` block has the Android SDK draw
  // the alert itself while the app is backgrounded, which skips the client's
  // handler and with it the tap destination it derives from `type` and `uri`.
  // FCM only carries strings in `data`, so everything is sent as one.
  const data: Record<string, string> = { title: original.title, body: original.body }
  for (const [key, value] of Object.entries(original.data ?? {})) {
    data[key] = String(value)
  }

  const message: Record<string, unknown> = {
    token,
    data,
    android: {
      // Data-only messages are "normal" priority by default, which lets Doze
      // hold one until the device next wakes. These are alerts somebody is
      // waiting on, so they go high, the way APNs alert pushes do.
      priority: 'HIGH',
      ...(original.collapseId ? { collapse_key: original.collapseId } : {}),
    },
    // `badge` has no FCM equivalent — an Android launcher badges from the
    // notification the client posts, not from the payload.
  }

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmCredentials!.projectId}/messages:send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(15_000),
  })

  if (res.ok) {
    emit('push', 'sent', { did: original.did, transport: 'fcm', token: token.slice(0, 8) + '...' })
    return
  }

  const body = await res.text().catch(() => '')

  // Google's word for a token that no longer belongs to an install — the same
  // fact Apple reports as a 410.
  if (res.status === 404 || body.includes('UNREGISTERED')) {
    await removeToken(token).catch(() => {})
    emit('push', 'token_removed', { did: original.did, transport: 'fcm', reason: 'unregistered' })
    return
  }

  // The bearer token was refused: drop it so the next send mints a fresh one
  // rather than replaying a credential Google has already rejected.
  if (res.status === 401 || res.status === 403) {
    cachedFcmToken = null
  }

  emit('push', 'send_error', {
    did: original.did,
    transport: 'fcm',
    status: res.status,
    body: body.slice(0, 200),
  })
}

/** Register a push token for a DID. Upserts on conflict. */
export async function registerToken(did: string, token: string, platform: string): Promise<void> {
  await runSQL(
    `INSERT INTO _push_tokens (did, token, platform, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (did, token) DO UPDATE SET platform = excluded.platform`,
    [did, token, platform, new Date().toISOString()],
  )
}

/** Remove a push token. */
export async function removeToken(token: string): Promise<void> {
  await runSQL(`DELETE FROM _push_tokens WHERE token = $1`, [token])
}

/** Unregister a specific token for a DID. */
export async function unregisterToken(did: string, token: string): Promise<void> {
  await runSQL(`DELETE FROM _push_tokens WHERE did = $1 AND token = $2`, [did, token])
}
