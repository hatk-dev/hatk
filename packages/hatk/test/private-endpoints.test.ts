import { beforeAll, beforeEach, expect, test } from 'vitest'
import { createHandler } from '../src/server.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { insertRecord } from '../src/database/index.ts'
import { setupFixtureDatabase, PRIVATE_COLLECTION, PUBLIC_COLLECTION } from './fixture.ts'

// A collection that is never registered in the fixture and never marked
// private — used as the "genuinely unknown" baseline for the indistinguishability
// assertions below.
const UNREGISTERED_COLLECTION = 'xyz.nonexistent.collection'

const PRIVATE_URI = `at://did:plc:test/${PRIVATE_COLLECTION}/private1`
const PUBLIC_URI = `at://did:plc:test/${PUBLIC_COLLECTION}/public1`

function handler() {
  return createHandler({
    collections: [PRIVATE_COLLECTION, PUBLIC_COLLECTION],
    publicDir: null,
    oauth: null,
    admins: [],
  })
}

beforeAll(async () => {
  // Registers schemas for PRIVATE_COLLECTION and PUBLIC_COLLECTION, so
  // getSchema(collection) finds a real entry for both — unlike the rest of
  // hatk's test suite, where no schema is ever registered and every collection
  // 404s as "unknown" regardless of the guard.
  await setupFixtureDatabase()

  // A real row in each collection so getRecord has something to find pre-guard.
  // Without an inserted row, a point lookup 404s "Record not found" whether or
  // not the guard exists (no data either way), which would make the getRecord
  // assertions just as vacuous as the ones this rewrite is replacing.
  await insertRecord(PRIVATE_COLLECTION, PRIVATE_URI, 'cid1', 'did:plc:test', { text: 'private record' })
  await insertRecord(PUBLIC_COLLECTION, PUBLIC_URI, 'cid2', 'did:plc:test', { text: 'public record' })
})

beforeEach(() => {
  setPrivateCollections([PRIVATE_COLLECTION])
})

test('getRecords 404s for a private collection, even though its schema is registered', async () => {
  const res = await handler()(new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${PRIVATE_COLLECTION}`))
  expect(res.status).toBe(404)
})

test('getRecords succeeds for a registered public collection', async () => {
  const res = await handler()(new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.items).toHaveLength(1)
  expect(body.items[0].uri).toBe(PUBLIC_URI)
})

test('searchRecords 404s for a private collection, even though its schema is registered', async () => {
  const res = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.searchRecords?collection=${PRIVATE_COLLECTION}&q=record`),
  )
  expect(res.status).toBe(404)
})

test('searchRecords succeeds for a registered public collection', async () => {
  const res = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.searchRecords?collection=${PUBLIC_COLLECTION}&q=record`),
  )
  expect(res.status).toBe(200)
})

test('getRecord 404s for a uri in a private collection, even though the record exists', async () => {
  const res = await handler()(new Request(`http://localhost/xrpc/dev.hatk.getRecord?uri=${PRIVATE_URI}`))
  expect(res.status).toBe(404)
})

test('getRecord succeeds for a uri in a registered public collection', async () => {
  const res = await handler()(new Request(`http://localhost/xrpc/dev.hatk.getRecord?uri=${PUBLIC_URI}`))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.record.uri).toBe(PUBLIC_URI)
})

test('the guard does not 403, which would confirm the collection exists', async () => {
  const res = await handler()(new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${PRIVATE_COLLECTION}`))
  expect(res.status).not.toBe(403)
})

test('a collection that is not private is not blocked by the guard (empty allowlist)', async () => {
  setPrivateCollections([])
  const res = await handler()(new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`))
  expect(res.status).toBe(200)
})

test('getRecords: private rejection is byte-identical in shape to an unknown-collection rejection', async () => {
  const unregisteredRes = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${UNREGISTERED_COLLECTION}`),
  )
  const privateRes = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.getRecords?collection=${PRIVATE_COLLECTION}`),
  )

  expect(privateRes.status).toBe(unregisteredRes.status)

  // Normalize the collection name out of each body so only the response
  // *shape* is compared — a registered-but-private collection and a
  // collection that plain doesn't exist must be indistinguishable.
  const unregisteredBody = (await unregisteredRes.text()).replaceAll(UNREGISTERED_COLLECTION, '<collection>')
  const privateBody = (await privateRes.text()).replaceAll(PRIVATE_COLLECTION, '<collection>')
  expect(privateBody).toBe(unregisteredBody)
})

test('getRecord: private rejection is byte-identical to a not-found rejection', async () => {
  const missingRes = await handler()(
    new Request(`http://localhost/xrpc/dev.hatk.getRecord?uri=at://did:plc:test/${UNREGISTERED_COLLECTION}/nope`),
  )
  const privateRes = await handler()(new Request(`http://localhost/xrpc/dev.hatk.getRecord?uri=${PRIVATE_URI}`))

  expect(privateRes.status).toBe(missingRes.status)
  expect(await privateRes.text()).toBe(await missingRes.text())
})
