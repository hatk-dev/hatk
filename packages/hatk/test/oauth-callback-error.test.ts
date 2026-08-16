import { beforeAll, beforeEach, expect, test } from 'vitest'
import { handleCallbackError } from '../src/oauth/server.ts'
import { OAUTH_DDL, storeOAuthRequest } from '../src/oauth/db.ts'
import { querySQL, runSQL } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

// The PDS reports a denied (or otherwise failed) authorization by redirecting to
// our callback with `error` and no `code`. These tests pin the shape of the URL
// we hand back, since that URL is the only thing the app has to render from.

const ISSUER = 'https://example.app'

const config = { issuer: ISSUER } as any

async function storeRequest(overrides: { pdsState: string; redirectUri: string; state?: string }) {
  await storeOAuthRequest(`urn:ietf:params:oauth:request_uri:${overrides.pdsState}`, {
    clientId: `${ISSUER}/client-metadata.json`,
    redirectUri: overrides.redirectUri,
    state: overrides.state,
    codeChallenge: 'challenge',
    dpopJkt: 'jkt',
    pdsState: overrides.pdsState,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
}

beforeAll(async () => {
  await setupFixtureDatabase()
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
})

beforeEach(async () => {
  await runSQL('DELETE FROM _oauth_requests')
})

test('server-initiated login sends the error home', async () => {
  await storeRequest({ pdsState: 'pds-state-1', redirectUri: '/', state: 'pds-state-1' })

  const location = await handleCallbackError(config, 'access_denied', 'User denied', 'pds-state-1')

  expect(location.startsWith('/?')).toBe(true)
  const params = new URLSearchParams(location.slice(2))
  expect(params.get('error')).toBe('access_denied')
  expect(params.get('error_description')).toBe('User denied')
})

test('client flow echoes the client state and our issuer', async () => {
  await storeRequest({
    pdsState: 'pds-state-2',
    redirectUri: 'https://example.app/oauth/callback',
    state: 'client-state',
  })

  const location = await handleCallbackError(config, 'access_denied', null, 'pds-state-2')
  const url = new URL(location)

  expect(url.origin + url.pathname).toBe('https://example.app/oauth/callback')
  expect(url.searchParams.get('error')).toBe('access_denied')
  expect(url.searchParams.get('state')).toBe('client-state')
  // Without `iss`, the redirect re-enters the server-side callback branch
  // instead of falling through to the SPA that knows how to render the error.
  expect(url.searchParams.get('iss')).toBe(ISSUER)
})

test('the pending request is discarded', async () => {
  await storeRequest({ pdsState: 'pds-state-3', redirectUri: '/' })

  await handleCallbackError(config, 'access_denied', null, 'pds-state-3')

  const rows = await querySQL('SELECT * FROM _oauth_requests WHERE pds_state = $1', ['pds-state-3'])
  expect(rows).toHaveLength(0)
})

test('an unmatched state still lands somewhere renderable', async () => {
  const location = await handleCallbackError(config, 'access_denied', null, 'never-stored')

  expect(location).toBe('/?error=access_denied')
})
