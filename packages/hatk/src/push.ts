/**
 * Push notification delivery via APNs HTTP/2.
 *
 * Provides `push.send()` for use in on-commit hook context. Looks up device
 * tokens, builds APNs payloads, and sends via HTTP/2. Self-cleans invalid
 * tokens on Apple 410 responses. Fire-and-forget — failures are logged via
 * `emit()` but never throw.
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

export interface PushConfig {
  apns: ApnsConfig
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

let pushConfig: PushConfig | null = null
let apnsKey: string | null = null
let cachedJwt: { token: string; expires: number } | null = null
let http2Session: ClientHttp2Session | null = null

/** Initialize push with config. Must be called before send(). */
export function initPush(config: PushConfig, configDir: string): void {
  pushConfig = config
  const keyPath = resolve(configDir, config.apns.keyFile)
  try {
    apnsKey = readFileSync(keyPath, 'utf8')
  } catch {
    emit('push', 'init_error', { error: `APNs key file not found: ${keyPath}` })
    pushConfig = null
  }
}

/** Check if push is configured and available. */
export function isPushEnabled(): boolean {
  return pushConfig !== null && apnsKey !== null
}

/** Build the push interface injected into hook contexts. */
export function buildPushInterface(): PushInterface {
  return { send }
}

/** Create a JWT for APNs authentication (cached for 50 minutes). */
function getApnsJwt(): string {
  if (cachedJwt && Date.now() < cachedJwt.expires) return cachedJwt.token
  if (!pushConfig || !apnsKey) throw new Error('Push not initialized')

  const header = Buffer.from(JSON.stringify({
    alg: 'ES256',
    kid: pushConfig.apns.keyId,
  })).toString('base64url')

  const now = Math.floor(Date.now() / 1000)
  const claims = Buffer.from(JSON.stringify({
    iss: pushConfig.apns.teamId,
    iat: now,
  })).toString('base64url')

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
  const host = pushConfig?.apns.production !== false
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com'
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
  if (!pushConfig || !apnsKey) return

  const tokens = await querySQL(
    `SELECT token, platform FROM _push_tokens WHERE did = $1`,
    [payload.did],
  ) as { token: string; platform: string }[]

  if (tokens.length === 0) return

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

  for (const { token, platform } of tokens) {
    if (platform !== 'apns') continue
    sendToApns(token, apnsPayload, jwt, payload).catch(() => {})
  }
}

/** Send a single APNs push and handle the response. */
async function sendToApns(
  token: string,
  payload: string,
  jwt: string,
  original: PushPayload,
): Promise<void> {
  const session = getHttp2Session()
  const headers: Record<string, string> = {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    'authorization': `bearer ${jwt}`,
    'apns-topic': pushConfig!.apns.bundleId,
    'apns-push-type': 'alert',
  }
  if (original.collapseId) {
    headers['apns-collapse-id'] = original.collapseId
  }

  return new Promise<void>((resolve) => {
    const req = session.request(headers)
    let settled = false
    const done = () => { if (settled) return; settled = true; resolve() }

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
