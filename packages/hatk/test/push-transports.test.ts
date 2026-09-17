import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPushInterface,
  enabledPushTransports,
  initPush,
  isPushEnabled,
  registerToken,
  removeToken,
  unregisterToken,
} from '../src/push.ts'
import { emit } from '../src/logger.ts'
import { querySQL, runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// Push is fire-and-forget by design, so nothing here can be judged by a return
// value. What can be judged: what each transport puts on the wire, which
// device rows survive a vendor's verdict, and that a credential problem on one
// transport never silences the other.

vi.mock('../src/logger.ts', { spy: true })

/**
 * A stand-in for the APNs HTTP/2 client: one session whose requests answer
 * with whatever `respond` was last set to, recording headers and body.
 */
const h2 = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')

  interface Reply {
    status?: number
    body?: string
    error?: string
    hang?: boolean
  }

  class FakeRequest extends EventEmitter {
    chunks: string[] = []
    closed = false
    timeoutMs = 0
    onTimeout: (() => void) | undefined
    constructor(public headers: Record<string, string>) {
      super()
    }
    setTimeout(ms: number, cb: () => void) {
      this.timeoutMs = ms
      this.onTimeout = cb
    }
    write(chunk: string) {
      this.chunks.push(String(chunk))
    }
    close() {
      this.closed = true
    }
    end() {
      const reply = state.reply
      queueMicrotask(() => {
        if (reply.hang) return
        if (reply.error) return this.emit('error', new Error(reply.error))
        this.emit('response', { ':status': reply.status ?? 200 })
        if (reply.body) this.emit('data', Buffer.from(reply.body))
        this.emit('end')
      })
    }
  }

  const state = {
    reply: { status: 200 } as Reply,
    requests: [] as FakeRequest[],
    hosts: [] as string[],
    session: Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      request(headers: Record<string, string>) {
        const req = new FakeRequest(headers)
        state.requests.push(req)
        return req
      },
    }),
  }
  return state
})

vi.mock('node:http2', () => ({
  connect: (host: string) => {
    h2.hosts.push(host)
    h2.session.closed = false
    return h2.session
  },
}))

const DID = 'did:plc:pushtest'
const TOKEN_URI = 'https://oauth2.example/token'

let configDir: string

interface FetchCall {
  url: string
  init?: RequestInit
}

function stubFetch(
  reply: (url: string, n: number) => Response = () => json({ name: 'projects/grain-test/messages/1' }),
  token: (n: number) => Response = () => json({ access_token: 'ya29.test', expires_in: 3600 }),
) {
  const calls: FetchCall[] = []
  let sends = 0
  let tokens = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === TOKEN_URI) return token(++tokens)
      return reply(url, ++sends)
    }),
  )
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const sendCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes('messages:send'))
const tokenCalls = (calls: FetchCall[]) => calls.filter((c) => c.url === TOKEN_URI)
const events = (op: string) => vi.mocked(emit).mock.calls.filter(([mod, o]) => mod === 'push' && o === op)
const tokensFor = async (did: string) =>
  ((await querySQL(`SELECT token, platform FROM _push_tokens WHERE did = $1 ORDER BY token`, [did])) as any[]).map(
    (r) => `${r.platform}:${r.token}`,
  )

const apns = { keyFile: 'apns.p8', keyId: 'KEY123', teamId: 'TEAM456', bundleId: 'social.grain.app' }
const fcm = { keyFile: 'service-account.json' }

beforeAll(async () => {
  await setupFixtureDatabase()
  configDir = mkdtempSync(join(tmpdir(), 'hatk-push-'))

  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  writeFileSync(join(configDir, 'apns.p8'), ec.privateKey.export({ type: 'pkcs8', format: 'pem' }))

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFileSync(
    join(configDir, 'service-account.json'),
    JSON.stringify({
      client_email: 'pusher@grain-test.iam.gserviceaccount.com',
      private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      project_id: 'grain-test',
      token_uri: TOKEN_URI,
    }),
  )
  writeFileSync(join(configDir, 'broken-account.json'), JSON.stringify({ client_email: 'x' }))
  writeFileSync(join(configDir, 'not-json.json'), 'nope')
})

beforeEach(async () => {
  await runSQL(`DELETE FROM _push_tokens`)
  vi.mocked(emit).mockClear()
  h2.requests.length = 0
  h2.hosts.length = 0
  h2.reply = { status: 200 }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('initPush', () => {
  test('each transport is enabled on its own credentials', () => {
    initPush({ apns, fcm }, configDir)
    expect(isPushEnabled()).toBe(true)
    expect(enabledPushTransports()).toEqual(['apns', 'fcm'])

    initPush({ apns }, configDir)
    expect(enabledPushTransports()).toEqual(['apns'])
  })

  test('a missing APNs key disables APNs and leaves FCM sending', () => {
    initPush({ apns: { ...apns, keyFile: 'missing.p8' }, fcm }, configDir)

    expect(enabledPushTransports()).toEqual(['fcm'])
    expect(events('init_error')[0][2]).toMatchObject({ transport: 'apns' })
  })

  test('an unusable FCM account disables FCM and leaves APNs sending', () => {
    initPush({ apns, fcm: { keyFile: 'broken-account.json' } }, configDir)
    expect(enabledPushTransports()).toEqual(['apns'])
    expect(events('init_error')[0][2]).toMatchObject({ transport: 'fcm' })

    initPush({ apns, fcm: { keyFile: 'not-json.json' } }, configDir)
    expect(enabledPushTransports()).toEqual(['apns'])
  })

  test('with no usable transport, push is off entirely', () => {
    initPush({ apns: { ...apns, keyFile: 'missing.p8' }, fcm: { keyFile: 'missing.json' } }, configDir)
    expect(isPushEnabled()).toBe(false)
    expect(enabledPushTransports()).toEqual([])

    initPush({}, configDir)
    expect(isPushEnabled()).toBe(false)
  })
})

describe('send routing', () => {
  test('nothing happens while push is off', async () => {
    initPush({}, configDir)
    await registerToken(DID, 'android-token', 'fcm')
    const calls = stubFetch()

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    expect(calls).toHaveLength(0)
  })

  test('a DID with no devices costs no requests', async () => {
    initPush({ apns, fcm }, configDir)
    const calls = stubFetch()

    await buildPushInterface().send({ did: 'did:plc:nobody', title: 't', body: 'b' })

    expect(calls).toHaveLength(0)
    expect(h2.requests).toHaveLength(0)
  })

  test('a platform this build does not serve is left alone, not guessed at', async () => {
    initPush({ apns, fcm }, configDir)
    await registerToken(DID, 'web-token', 'webpush')
    const calls = stubFetch()

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    expect(calls).toHaveLength(0)
    expect(h2.requests).toHaveLength(0)
    expect(await tokensFor(DID)).toEqual(['webpush:web-token'])
  })

  test('each device is reached over the transport it registered under', async () => {
    initPush({ apns, fcm }, configDir)
    await registerToken(DID, 'ios-token', 'apns')
    await registerToken(DID, 'android-token', 'fcm')
    const calls = stubFetch()

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(1))
    await vi.waitFor(() => expect(h2.requests).toHaveLength(1))
    expect(h2.requests[0].headers[':path']).toBe('/3/device/ios-token')
    expect(JSON.parse(String(sendCalls(calls)[0].init?.body)).message.token).toBe('android-token')
  })
})

describe('APNs', () => {
  beforeEach(() => {
    initPush({ apns }, configDir)
  })

  test('an alert push carries the headers and payload Apple reads', async () => {
    await registerToken(DID, 'ios-token', 'apns')

    await buildPushInterface().send({
      did: DID,
      title: 'New favorite',
      body: 'Someone favorited your gallery',
      data: { type: 'gallery-favorite', uri: 'at://x/y/z' },
      badge: 2,
      collapseId: 'gallery-z',
    })

    await vi.waitFor(() => expect(h2.requests).toHaveLength(1))
    const req = h2.requests[0]
    expect(req.headers).toMatchObject({
      ':method': 'POST',
      ':path': '/3/device/ios-token',
      'apns-topic': 'social.grain.app',
      'apns-push-type': 'alert',
      'apns-collapse-id': 'gallery-z',
    })
    expect(req.timeoutMs).toBe(15_000)

    // The provider token: ES256, our key id, our team.
    const [scheme, jwt] = req.headers.authorization.split(' ')
    expect(scheme).toBe('bearer')
    const [header, claims] = jwt
      .split('.')
      .slice(0, 2)
      .map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()))
    expect(header).toEqual({ alg: 'ES256', kid: 'KEY123' })
    expect(claims.iss).toBe('TEAM456')
    expect(typeof claims.iat).toBe('number')

    // Custom data sits beside `aps`, where the client reads it.
    expect(JSON.parse(req.chunks.join(''))).toEqual({
      aps: { alert: { title: 'New favorite', body: 'Someone favorited your gallery' }, sound: 'default', badge: 2 },
      type: 'gallery-favorite',
      uri: 'at://x/y/z',
    })
    await vi.waitFor(() => expect(events('sent')).toHaveLength(1))
  })

  test('badge and collapse id are omitted when not given', async () => {
    await registerToken(DID, 'ios-token', 'apns')

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(() => expect(h2.requests).toHaveLength(1))
    expect(h2.requests[0].headers['apns-collapse-id']).toBeUndefined()
    expect(JSON.parse(h2.requests[0].chunks.join('')).aps.badge).toBeUndefined()
  })

  test('the provider token is minted once and reused', async () => {
    await registerToken(DID, 'ios-token', 'apns')
    const push = buildPushInterface()

    await push.send({ did: DID, title: 'one', body: 'b' })
    await push.send({ did: DID, title: 'two', body: 'b' })

    await vi.waitFor(() => expect(h2.requests).toHaveLength(2))
    expect(h2.requests[0].headers.authorization).toBe(h2.requests[1].headers.authorization)
  })

  test('a 410 means the device is gone, and its row goes with it', async () => {
    await registerToken(DID, 'ios-token', 'apns')
    h2.reply = { status: 410, body: '{"reason":"Unregistered"}' }

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(async () => expect(await tokensFor(DID)).toEqual([]))
    expect(events('token_removed')[0][2]).toMatchObject({ did: DID, reason: 'expired' })
  })

  test('any other refusal is logged with its status and the device kept', async () => {
    await registerToken(DID, 'ios-token', 'apns')
    h2.reply = { status: 400, body: '{"reason":"BadDeviceToken"}' }

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(() => expect(events('send_error')).toHaveLength(1))
    expect(events('send_error')[0][2]).toMatchObject({ did: DID, status: 400, body: '{"reason":"BadDeviceToken"}' })
    expect(await tokensFor(DID)).toEqual(['apns:ios-token'])
  })

  test('a stream error is logged and does not throw out of send', async () => {
    await registerToken(DID, 'ios-token', 'apns')
    h2.reply = { error: 'ECONNRESET' }

    await expect(buildPushInterface().send({ did: DID, title: 't', body: 'b' })).resolves.toBeUndefined()

    await vi.waitFor(() => expect(events('send_error')).toHaveLength(1))
    expect(events('send_error')[0][2]).toMatchObject({ did: DID, error: 'ECONNRESET' })
  })

  test('a request that never answers is closed at the timeout', async () => {
    await registerToken(DID, 'ios-token', 'apns')
    h2.reply = { hang: true }

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(() => expect(h2.requests).toHaveLength(1))
    h2.requests[0].onTimeout!()
    expect(h2.requests[0].closed).toBe(true)
    expect(events('send_error')[0][2]).toMatchObject({ error: 'APNs request timed out' })
  })

  test('production is the default host and sandbox is opt-in', async () => {
    await registerToken(DID, 'ios-token', 'apns')

    // Force a reconnect so the host choice is observable.
    h2.session.closed = true
    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })
    await vi.waitFor(() => expect(h2.hosts).toEqual(['https://api.push.apple.com']))

    initPush({ apns: { ...apns, production: false } }, configDir)
    h2.session.closed = true
    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })
    await vi.waitFor(() =>
      expect(h2.hosts).toEqual(['https://api.push.apple.com', 'https://api.sandbox.push.apple.com']),
    )
  })
})

describe('FCM', () => {
  beforeEach(() => {
    initPush({ fcm }, configDir)
  })

  test('the service account signs a JWT for the messaging scope', async () => {
    await registerToken(DID, 'android-token', 'fcm')
    const calls = stubFetch()

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(1))
    const [exchange] = tokenCalls(calls)
    const form = exchange.init?.body as URLSearchParams
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [header, claims] = form
      .get('assertion')!
      .split('.')
      .slice(0, 2)
      .map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()))
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(claims).toMatchObject({
      iss: 'pusher@grain-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: TOKEN_URI,
    })
    expect(claims.exp - claims.iat).toBe(3600)
  })

  test('a configured project id overrides the one in the account file', async () => {
    initPush({ fcm: { ...fcm, projectId: 'other-project' } }, configDir)
    await registerToken(DID, 'android-token', 'fcm')
    const calls = stubFetch()

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(1))
    expect(sendCalls(calls)[0].url).toBe('https://fcm.googleapis.com/v1/projects/other-project/messages:send')
  })

  test('a failed token exchange is logged and no message is attempted', async () => {
    await registerToken(DID, 'android-token', 'fcm')
    const calls = stubFetch(undefined, () => new Response('denied', { status: 403 }))

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    expect(sendCalls(calls)).toHaveLength(0)
    expect(events('send_error')[0][2]).toMatchObject({
      transport: 'fcm',
      error: 'FCM token exchange failed: 403 denied',
    })
  })

  test('a token exchange that grants nothing is treated the same', async () => {
    await registerToken(DID, 'android-token', 'fcm')
    const calls = stubFetch(undefined, () => json({}))

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    expect(sendCalls(calls)).toHaveLength(0)
    expect(events('send_error')[0][2]).toMatchObject({ error: 'FCM token exchange returned no access_token' })
  })

  test('a bearer token Google refuses is dropped, so the next send mints a new one', async () => {
    await registerToken(DID, 'android-token', 'fcm')
    const calls = stubFetch((_url, n) => (n === 1 ? json({ error: { status: 'UNAUTHENTICATED' } }, 401) : json({})))
    const push = buildPushInterface()

    await push.send({ did: DID, title: 'one', body: 'b' })
    await vi.waitFor(() => expect(events('send_error')).toHaveLength(1))
    expect(events('send_error')[0][2]).toMatchObject({ transport: 'fcm', status: 401 })

    await push.send({ did: DID, title: 'two', body: 'b' })
    await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(2))
    expect(tokenCalls(calls)).toHaveLength(2)
    // The device itself was fine and is still registered.
    expect(await tokensFor(DID)).toEqual(['fcm:android-token'])
  })

  test('a transient failure keeps the bearer token and the device', async () => {
    await registerToken(DID, 'android-token', 'fcm')
    const calls = stubFetch((_url, n) => (n === 1 ? json({ error: { status: 'UNAVAILABLE' } }, 503) : json({})))
    const push = buildPushInterface()

    await push.send({ did: DID, title: 'one', body: 'b' })
    await vi.waitFor(() => expect(events('send_error')).toHaveLength(1))
    await push.send({ did: DID, title: 'two', body: 'b' })

    await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(2))
    expect(tokenCalls(calls)).toHaveLength(1)
    expect(await tokensFor(DID)).toEqual(['fcm:android-token'])
  })

  test('UNREGISTERED in the body removes the device even on a non-404', async () => {
    await registerToken(DID, 'android-token', 'fcm')
    stubFetch(() => json({ error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'UNREGISTERED' }] } }, 400))

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(async () => expect(await tokensFor(DID)).toEqual([]))
    expect(events('token_removed')[0][2]).toMatchObject({ transport: 'fcm', reason: 'unregistered' })
  })

  test('every device of a DID is sent to', async () => {
    await registerToken(DID, 'android-1', 'fcm')
    await registerToken(DID, 'android-2', 'fcm')
    const calls = stubFetch()

    await buildPushInterface().send({ did: DID, title: 't', body: 'b' })

    await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(2))
    const tokens = sendCalls(calls).map((c) => JSON.parse(String(c.init?.body)).message.token)
    expect(tokens.sort()).toEqual(['android-1', 'android-2'])
  })
})

describe('token registry', () => {
  test('registering the same token again updates its platform', async () => {
    await registerToken(DID, 'tok', 'apns')
    await registerToken(DID, 'tok', 'fcm')

    expect(await tokensFor(DID)).toEqual(['fcm:tok'])
  })

  test('unregistering is scoped to the DID that owns the token', async () => {
    await registerToken(DID, 'tok', 'apns')
    await unregisterToken('did:plc:other', 'tok')
    expect(await tokensFor(DID)).toEqual(['apns:tok'])

    await unregisterToken(DID, 'tok')
    expect(await tokensFor(DID)).toEqual([])
  })

  test('removing a token needs no DID', async () => {
    await registerToken(DID, 'tok', 'apns')
    await removeToken('tok')
    expect(await tokensFor(DID)).toEqual([])
  })
})
