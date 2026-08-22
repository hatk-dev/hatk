import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPushInterface, initPush, isPushEnabled, registerToken } from '../src/push.ts'
import { querySQL, runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// Android devices register under the `fcm` platform and were previously skipped
// by send() — the tokens were stored and never used, so a phone could hold a
// valid registration and receive nothing, forever, with no error anywhere.

const DID = 'did:plc:pushtest'
const TOKEN_URI = 'https://oauth2.example/token'

let configDir: string

interface StubbedSend {
  status: number
  body?: unknown
}

/** Answer the token exchange, then hand out the queued send responses in order. */
function stubFetch(sends: StubbedSend[] = [{ status: 200, body: { name: 'projects/grain-test/messages/1' } }]) {
  const calls: { url: string; init?: RequestInit }[] = []
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === TOKEN_URI) {
        return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const next = sends[Math.min(i++, sends.length - 1)]
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

const sendCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('messages:send'))
const tokenCalls = (calls: { url: string }[]) => calls.filter((c) => c.url === TOKEN_URI)

/** The `message` object a messages:send call carried. */
function messageOf(call: { init?: RequestInit }): any {
  return JSON.parse(String(call.init?.body)).message
}

beforeAll(async () => {
  await setupFixtureDatabase()

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  configDir = mkdtempSync(join(tmpdir(), 'hatk-fcm-'))
  writeFileSync(
    join(configDir, 'service-account.json'),
    JSON.stringify({
      client_email: 'pusher@grain-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      project_id: 'grain-test',
      token_uri: TOKEN_URI,
    }),
  )
})

beforeEach(async () => {
  await runSQL(`DELETE FROM _push_tokens`)
  initPush({ fcm: { keyFile: 'service-account.json' } }, configDir)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('FCM alone is enough to enable push', () => {
  expect(isPushEnabled()).toBe(true)
})

test('an Android device is sent a data-only message it can route itself', async () => {
  await registerToken(DID, 'android-token', 'fcm')
  const calls = stubFetch()

  await buildPushInterface().send({
    did: DID,
    title: 'New favorite',
    body: 'Someone favorited your gallery',
    data: { type: 'gallery-favorite', uri: 'at://did:plc:someone/social.grain.gallery/abc' },
    badge: 3,
  })

  await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(1))
  const call = sendCalls(calls)[0]
  expect(call.url).toBe('https://fcm.googleapis.com/v1/projects/grain-test/messages:send')
  expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer ya29.test')

  const message = messageOf(call)
  expect(message.token).toBe('android-token')
  // A notification block would have the SDK draw the alert while the app is
  // backgrounded, which skips the handler that reads type and uri.
  expect(message.notification).toBeUndefined()
  expect(message.data).toEqual({
    title: 'New favorite',
    body: 'Someone favorited your gallery',
    type: 'gallery-favorite',
    uri: 'at://did:plc:someone/social.grain.gallery/abc',
  })
  expect(message.android.priority).toBe('HIGH')
})

test('an iOS token is left alone when only FCM is configured', async () => {
  await registerToken(DID, 'android-token', 'fcm')
  await registerToken(DID, 'ios-token', 'apns')
  const calls = stubFetch()

  await buildPushInterface().send({ did: DID, title: 'New follower', body: 'Someone followed you' })

  await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(1))
  expect(messageOf(sendCalls(calls)[0]).token).toBe('android-token')
})

test('a token Google reports as unregistered is deleted', async () => {
  await registerToken(DID, 'stale-token', 'fcm')
  stubFetch([
    {
      status: 404,
      body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
    },
  ])

  await buildPushInterface().send({ did: DID, title: 'New comment', body: 'Someone commented' })

  await vi.waitFor(async () => {
    const rows = (await querySQL(`SELECT token FROM _push_tokens WHERE did = $1`, [DID])) as unknown[]
    expect(rows).toHaveLength(0)
  })
})

test('one access token serves a burst of sends', async () => {
  await registerToken(DID, 'android-token', 'fcm')
  const calls = stubFetch()
  const push = buildPushInterface()

  await push.send({ did: DID, title: 'First', body: 'one' })
  await push.send({ did: DID, title: 'Second', body: 'two' })

  await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(2))
  expect(tokenCalls(calls)).toHaveLength(1)
})

test('a collapse id rides along as FCM’s collapse key', async () => {
  await registerToken(DID, 'android-token', 'fcm')
  const calls = stubFetch()

  await buildPushInterface().send({
    did: DID,
    title: 'New favorite',
    body: 'Someone favorited your gallery',
    collapseId: 'gallery-abc',
  })

  await vi.waitFor(() => expect(sendCalls(calls)).toHaveLength(1))
  expect(messageOf(sendCalls(calls)[0]).android.collapse_key).toBe('gallery-abc')
})
