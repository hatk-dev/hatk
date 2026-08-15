import { beforeAll, expect, test } from 'vitest'
import { createHandler } from '../src/server.ts'
import { insertRecord } from '../src/database/index.ts'
import { setRepoStatus } from '../src/database/db.ts'
import { setupFixtureDatabase, PRIVATE_COLLECTION, PUBLIC_COLLECTION } from './fixture.ts'

const ADMIN_DID = 'did:plc:admin'

function handler() {
  return createHandler({
    collections: [PRIVATE_COLLECTION, PUBLIC_COLLECTION],
    publicDir: null,
    oauth: null,
    admins: [ADMIN_DID],
    resolveViewer: () => ({ did: ADMIN_DID }),
  })
}

function get(h: ReturnType<typeof handler>, path: string, headers?: Record<string, string>) {
  return h(new Request(`http://localhost${path}`, { headers }))
}

beforeAll(async () => {
  await setupFixtureDatabase()
  await insertRecord(PUBLIC_COLLECTION, `at://${ADMIN_DID}/${PUBLIC_COLLECTION}/1`, 'cid1', ADMIN_DID, { text: 'a' })
  await insertRecord(PUBLIC_COLLECTION, `at://${ADMIN_DID}/${PUBLIC_COLLECTION}/2`, 'cid2', ADMIN_DID, { text: 'b' })
  await insertRecord(PRIVATE_COLLECTION, `at://${ADMIN_DID}/${PRIVATE_COLLECTION}/1`, 'cid3', ADMIN_DID, { text: 'c' })
})

test('/admin/info reports a count for every collection', async () => {
  const res = await get(handler(), '/admin/info')
  expect(res.status).toBe(200)
  const body = await res.json()
  // Counts come back from a single UNION ALL query — every registered
  // collection must still be represented, private ones included.
  expect(body.collections).toEqual({ [PRIVATE_COLLECTION]: 1, [PUBLIC_COLLECTION]: 2 })
})

test('/admin/info counts repos by status', async () => {
  await setRepoStatus('did:plc:one', 'active')
  await setRepoStatus('did:plc:two', 'pending')
  const body = await (await get(handler(), '/admin/info')).json()
  expect(body.repos).toMatchObject({ active: 1, pending: 1 })
})

test('an admin action invalidates the cached rollups', async () => {
  const h = handler()
  await setRepoStatus('did:plc:three', 'active')
  const before = await (await get(h, '/admin/info')).json()
  expect(before.repos.active).toBe(2)

  const takedown = await h(
    new Request('http://localhost/admin/takedown', {
      method: 'POST',
      body: JSON.stringify({ did: 'did:plc:three' }),
    }),
  )
  expect(takedown.status).toBe(200)

  // Within the cache TTL, but the takedown must still be reflected.
  const after = await (await get(h, '/admin/info')).json()
  expect(after.repos.active).toBe(1)
  expect(after.repos.takendown).toBe(1)
})

test('the admin page revalidates with an ETag instead of resending itself', async () => {
  const h = handler()
  const first = await get(h, '/admin', { 'accept-encoding': 'gzip' })
  expect(first.status).toBe(200)
  expect(first.headers.get('content-encoding')).toBe('gzip')

  const etag = first.headers.get('etag')
  expect(etag).toBeTruthy()

  const second = await get(h, '/admin', { 'if-none-match': etag! })
  expect(second.status).toBe(304)
})

test('the admin page still serves uncompressed when gzip is not accepted', async () => {
  const res = await get(handler(), '/admin', { 'accept-encoding': 'identity' })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-encoding')).toBeNull()
  expect(await res.text()).toContain('<!doctype html>')
})
