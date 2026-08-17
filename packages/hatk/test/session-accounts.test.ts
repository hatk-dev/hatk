import { beforeAll, expect, test } from 'vitest'
import {
  createAccountsCookie,
  createSessionCookie,
  getAccountsCookieName,
  getSessionCookieName,
  initSession,
  parseAccountsCookie,
  parseSessionCookie,
  withAccount,
  withoutAccount,
  type SessionData,
} from '../src/oauth/session.ts'

// The accounts cookie is what authorizes `/auth/switch` to re-issue a session
// for a different DID without going back to the PDS. Its integrity is the only
// thing standing between "switch to an account I'm signed in as" and "assume
// any identity I can name", so these tests pin that boundary.

const alice: SessionData = { did: 'did:plc:alice', handle: 'alice.test' }
const bob: SessionData = { did: 'did:plc:bob', handle: 'bob.test' }

const privateJwk: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
}

function request(cookies: Record<string, string>): Request {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return new Request('http://localhost/', { headers: cookie ? { cookie } : {} })
}

beforeAll(() => {
  initSession(privateJwk)
})

test('accounts round-trip through the cookie', async () => {
  const value = await createAccountsCookie([alice, bob])
  const parsed = await parseAccountsCookie(request({ [getAccountsCookieName()]: value }))
  expect(parsed).toEqual([alice, bob])
})

test('no cookie means no accounts', async () => {
  expect(await parseAccountsCookie(request({}))).toEqual([])
})

test('a forged accounts cookie is rejected outright', async () => {
  // Anyone can write a cookie; only the server can encrypt one. A plaintext
  // list of DIDs must not be readable as an entitlement.
  const forged = Buffer.from(JSON.stringify({ accounts: [alice], ts: Math.floor(Date.now() / 1000) })).toString(
    'base64url',
  )
  expect(await parseAccountsCookie(request({ [getAccountsCookieName()]: forged }))).toEqual([])
  expect(await parseAccountsCookie(request({ [getAccountsCookieName()]: `${forged}.${forged}` }))).toEqual([])
})

test('a tampered ciphertext is rejected', async () => {
  const value = await createAccountsCookie([alice])
  const [iv, ciphertext] = value.split('.')
  const flipped = `${ciphertext.slice(0, -2)}${ciphertext.slice(-2) === 'AA' ? 'BB' : 'AA'}`
  expect(await parseAccountsCookie(request({ [getAccountsCookieName()]: `${iv}.${flipped}` }))).toEqual([])
})

test('the accounts cookie is separate from the session cookie', async () => {
  // The session names the active account; the accounts cookie names the set
  // that may be switched to. Reading one as the other must not work.
  expect(getAccountsCookieName()).not.toBe(getSessionCookieName())
  const session = await createSessionCookie(alice)
  expect(await parseAccountsCookie(request({ [getAccountsCookieName()]: session }))).toEqual([])

  const accounts = await createAccountsCookie([alice])
  expect(await parseSessionCookie(request({ [getSessionCookieName()]: accounts }))).toBeNull()
})

test('an expired accounts cookie is ignored', async () => {
  const stale = await createAccountsCookie([alice])
  const parsed = await parseAccountsCookie(request({ [getAccountsCookieName()]: stale }))
  expect(parsed).toEqual([alice])

  // 31 days on, past the 30-day max age.
  const realNow = Date.now
  Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000
  try {
    expect(await parseAccountsCookie(request({ [getAccountsCookieName()]: stale }))).toEqual([])
  } finally {
    Date.now = realNow
  }
})

test('adding an account keeps its position and refreshes the handle', async () => {
  const list = withAccount(withAccount([], alice), bob)
  expect(list).toEqual([alice, bob])

  const renamed = withAccount(list, { did: alice.did, handle: 'alice-renamed.test' })
  expect(renamed).toEqual([{ did: alice.did, handle: 'alice-renamed.test' }, bob])
})

test('signing out drops only that account', async () => {
  expect(withoutAccount([alice, bob], alice.did)).toEqual([bob])
  expect(withoutAccount([alice, bob], 'did:plc:nobody')).toEqual([alice, bob])
})

test('the list is capped so the cookie cannot grow without bound', async () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ did: `did:plc:user${i}`, handle: `user${i}.test` }))
  const parsed = await parseAccountsCookie(
    request({ [getAccountsCookieName()]: await createAccountsCookie(many) }),
  )
  expect(parsed).toHaveLength(10)
  // The most recent survive.
  expect(parsed.at(-1)?.did).toBe('did:plc:user14')
})
