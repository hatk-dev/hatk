import { beforeAll, beforeEach, expect, test } from 'vitest'
import { createHandler } from '../src/server.ts'
import { OAUTH_DDL, storeSession, deleteSession } from '../src/oauth/db.ts'
import { runSQL } from '../src/database/db.ts'
import {
  createAccountsCookie,
  createSessionCookie,
  getAccountsCookieName,
  getSessionCookieName,
  initSession,
  parseSessionCookie,
  type SessionData,
} from '../src/oauth/session.ts'
import { setupFixtureDatabase } from './fixture.ts'

// `/auth/switch` hands a browser a session cookie for a different DID without
// asking the PDS. What stops that from being an impersonation endpoint is the
// encrypted accounts cookie, so these tests are mostly about who gets refused.

const alice: SessionData = { did: 'did:plc:alice', handle: 'alice.test' }
const bob: SessionData = { did: 'did:plc:bob', handle: 'bob.test' }
const mallory: SessionData = { did: 'did:plc:mallory', handle: 'mallory.test' }

const privateJwk: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
}

function handler() {
  return createHandler({ collections: [], publicDir: null, oauth: null, admins: [] })
}

async function cookieHeaderFor(active: SessionData | null, accounts: SessionData[]): Promise<string> {
  const parts: string[] = []
  if (active) parts.push(`${getSessionCookieName()}=${await createSessionCookie(active)}`)
  if (accounts.length) parts.push(`${getAccountsCookieName()}=${await createAccountsCookie(accounts)}`)
  return parts.join('; ')
}

function switchRequest(cookie: string, did: unknown): Request {
  return new Request('http://localhost/auth/switch', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ did }),
  })
}

/** The session cookie a response hands back, decrypted. */
async function issuedSession(res: Response): Promise<SessionData | null> {
  const setCookies = res.headers.getSetCookie()
  const session = setCookies.find((c) => c.startsWith(`${getSessionCookieName()}=`))
  if (!session) return null
  return parseSessionCookie(new Request('http://localhost/', { headers: { cookie: session.split(';')[0] } }))
}

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  initSession(privateJwk)
})

beforeEach(async () => {
  await runSQL('DELETE FROM _oauth_sessions')
  for (const account of [alice, bob]) {
    await storeSession(account.did, {
      pdsEndpoint: 'https://pds.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      dpopJkt: 'jkt',
    })
  }
})

test('switches to another account the browser has signed in as', async () => {
  const cookie = await cookieHeaderFor(alice, [alice, bob])
  const res = await handler()(switchRequest(cookie, bob.did))

  expect(res.status).toBe(200)
  expect(await issuedSession(res)).toEqual(bob)
})

test('refuses a DID the browser never signed in as', async () => {
  // Mallory has a live server-side grant — that alone must not be enough.
  await storeSession(mallory.did, {
    pdsEndpoint: 'https://pds.test',
    accessToken: 'access',
    refreshToken: 'refresh',
    dpopJkt: 'jkt',
  })
  const cookie = await cookieHeaderFor(alice, [alice, bob])
  const res = await handler()(switchRequest(cookie, mallory.did))

  expect(res.status).toBe(403)
  expect(await issuedSession(res)).toBeNull()
})

test('refuses when the accounts cookie is forged', async () => {
  const forged = Buffer.from(JSON.stringify({ accounts: [bob], ts: Math.floor(Date.now() / 1000) })).toString(
    'base64url',
  )
  const cookie = `${getSessionCookieName()}=${await createSessionCookie(alice)}; ${getAccountsCookieName()}=${forged}`
  const res = await handler()(switchRequest(cookie, bob.did))

  expect(res.status).toBe(403)
  expect(await issuedSession(res)).toBeNull()
})

test('refuses with no accounts cookie at all', async () => {
  const cookie = `${getSessionCookieName()}=${await createSessionCookie(alice)}`
  const res = await handler()(switchRequest(cookie, bob.did))

  expect(res.status).toBe(403)
})

test('a dead grant 409s and drops the account from the list', async () => {
  await deleteSession(bob.did)
  const cookie = await cookieHeaderFor(alice, [alice, bob])
  const res = await handler()(switchRequest(cookie, bob.did))

  expect(res.status).toBe(409)
  expect(await issuedSession(res)).toBeNull()
  // The pruned list comes back so the client stops offering the dead account.
  const accountsCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${getAccountsCookieName()}=`))
  expect(accountsCookie).toBeDefined()
})

test('rejects a missing or non-string did', async () => {
  const cookie = await cookieHeaderFor(alice, [alice, bob])
  expect((await handler()(switchRequest(cookie, undefined))).status).toBe(400)
  expect((await handler()(switchRequest(cookie, 42))).status).toBe(400)
})

test('GET is not a switch — only POST', async () => {
  const cookie = await cookieHeaderFor(alice, [alice, bob])
  const res = await handler()(new Request('http://localhost/auth/switch', { headers: { cookie } }))
  expect(res.status).not.toBe(200)
})

test('lists the accounts a browser may switch between', async () => {
  await deleteSession(bob.did)
  const cookie = await cookieHeaderFor(alice, [alice, bob])
  const res = await handler()(new Request('http://localhost/auth/accounts', { headers: { cookie } }))

  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.active).toBe(alice.did)
  expect(body.accounts).toEqual([
    { ...alice, available: true },
    { ...bob, available: false },
  ])
})

test('logout drops the signed-out account from the list', async () => {
  const cookie = await cookieHeaderFor(alice, [alice, bob])
  const res = await handler()(new Request('http://localhost/auth/logout', { method: 'POST', headers: { cookie } }))

  expect(res.status).toBe(200)
  const setCookies = res.headers.getSetCookie()
  // Session cleared...
  expect(setCookies.some((c) => c.startsWith(`${getSessionCookieName()}=;`))).toBe(true)

  // ...and the remaining list no longer contains alice, so nothing can switch
  // back into the account that just signed out.
  const accountsCookie = setCookies.find((c) => c.startsWith(`${getAccountsCookieName()}=`))!
  const listed = await handler()(
    new Request('http://localhost/auth/accounts', { headers: { cookie: accountsCookie.split(';')[0] } }),
  )
  const body = await listed.json()
  expect(body.accounts.map((a: SessionData) => a.did)).toEqual([bob.did])
})

test('signing out the last account clears the list entirely', async () => {
  const cookie = await cookieHeaderFor(alice, [alice])
  const res = await handler()(new Request('http://localhost/auth/logout', { method: 'POST', headers: { cookie } }))

  const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${getAccountsCookieName()}=;`))
  expect(cleared).toBeDefined()
  expect(cleared).toContain('Max-Age=0')
})

test('an account signed in before the accounts cookie existed is still listed', async () => {
  // Sessions predating this feature have a session cookie and no accounts
  // cookie. If /auth/accounts reports an empty list for them, the switcher
  // shows nothing, and signing into a second account replaces the first —
  // which reads to the user as their account being dropped.
  const cookie = `${getSessionCookieName()}=${await createSessionCookie(alice)}`
  const res = await handler()(new Request('http://localhost/auth/accounts', { headers: { cookie } }))

  const body = await res.json()
  expect(body.active).toBe(alice.did)
  expect(body.accounts.map((a: SessionData) => a.did)).toEqual([alice.did])
})

test('listing heals the accounts cookie so the next switch works', async () => {
  const cookie = `${getSessionCookieName()}=${await createSessionCookie(alice)}`
  const listed = await handler()(new Request('http://localhost/auth/accounts', { headers: { cookie } }))

  const healed = listed.headers.getSetCookie().find((c) => c.startsWith(`${getAccountsCookieName()}=`))
  expect(healed).toBeDefined()

  // With the healed cookie, alice is switchable rather than a stranger.
  const withHealed = `${cookie}; ${healed!.split(';')[0]}`
  const res = await handler()(switchRequest(withHealed, alice.did))
  expect(res.status).toBe(200)
})
