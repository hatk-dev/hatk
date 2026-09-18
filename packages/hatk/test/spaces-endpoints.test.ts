import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

const readableSpacesFor = vi.fn()
const viewerCredential = vi.fn()

vi.mock('../src/spaces/viewer.ts', () => ({
  readableSpacesFor: (...a: unknown[]) => readableSpacesFor(...a),
  viewerCredential: (...a: unknown[]) => viewerCredential(...a),
  forgetViewerSpaces: vi.fn(),
  resetViewerSpaces: vi.fn(),
}))
vi.mock('../src/spaces/identity.ts', () => ({
  repoEndpoint: async (did: string) => `https://${did.replace(/[^a-z0-9]/gi, '')}.test`,
  spaceHostEndpoint: vi.fn(),
  configureSpaceIdentity: vi.fn(),
  clearSpaceIdentityCache: vi.fn(),
}))

const { createHandler } = await import('../src/server.ts')
const { insertRecord } = await import('../src/database/index.ts')
const { setPrivateCollections } = await import('../src/private-collections.ts')
const { resetSpaceBlobCache } = await import('../src/spaces/blob.ts')
const { PUBLIC_COLLECTION, SPACE_URI, setupFixtureDatabase } = await import('./fixture.ts')

const MEMBER = 'did:plc:member'
const STRANGER = 'did:plc:stranger'
const WRITER = 'did:plc:writer'
const PUBLIC_URI = `at://${WRITER}/${PUBLIC_COLLECTION}/public1`
const SPACE_RECORD = `${SPACE_URI}/${WRITER}/${PUBLIC_COLLECTION}/inspace`

/** The viewer is taken from a header, which is the seam the test harness uses. */
function handler() {
  return createHandler({
    collections: [PUBLIC_COLLECTION],
    publicDir: null,
    oauth: null,
    admins: [],
    resolveViewer: (request) => {
      const did = request.headers.get('x-test-viewer')
      return did ? { did } : null
    },
  })
}

const asViewer = (path: string, did?: string) =>
  new Request(`http://localhost${path}`, { headers: did ? { 'x-test-viewer': did } : {} })

beforeAll(async () => {
  await setupFixtureDatabase()
  await insertRecord(PUBLIC_COLLECTION, PUBLIC_URI, 'cid-public', WRITER, { text: 'public record' })
  await insertRecord(PUBLIC_COLLECTION, SPACE_RECORD, 'cid-space', WRITER, { text: 'members only' })
})

beforeEach(() => {
  setPrivateCollections([])
  readableSpacesFor.mockReset()
  readableSpacesFor.mockImplementation(async (_oauth: unknown, viewer: { did: string } | null) =>
    viewer?.did === MEMBER ? [SPACE_URI] : [],
  )
  viewerCredential.mockReset()
  resetSpaceBlobCache()
})

async function uris(res: Response): Promise<string[]> {
  const body = (await res.json()) as { items: { uri: string }[] }
  return body.items.map((r) => r.uri)
}

test('a signed-out visitor is served the public record and not the space one', async () => {
  const res = await handler()(asViewer(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`))
  expect(await uris(res)).toEqual([PUBLIC_URI])
})

test('a member is served both', async () => {
  const res = await handler()(asViewer(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`, MEMBER))
  expect((await uris(res)).sort()).toEqual([PUBLIC_URI, SPACE_RECORD].sort())
})

test('a signed-in stranger is served no more than a visitor', async () => {
  const res = await handler()(asViewer(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`, STRANGER))
  expect(await uris(res)).toEqual([PUBLIC_URI])
})

test('a space record is not reachable by naming its uri directly', async () => {
  const res = await handler()(asViewer(`/xrpc/dev.hatk.getRecord?uri=${encodeURIComponent(SPACE_RECORD)}`, STRANGER))
  expect(res.status).toBe(404)
})

test('a member can fetch the same record by uri', async () => {
  const res = await handler()(asViewer(`/xrpc/dev.hatk.getRecord?uri=${encodeURIComponent(SPACE_RECORD)}`, MEMBER))
  expect(res.status).toBe(200)
  const { record } = (await res.json()) as { record: { uri: string; space?: string } }
  expect(record.uri).toBe(SPACE_RECORD)
  // The envelope says which space it came from; a public record carries no such field.
  expect(record.space).toBe(SPACE_URI)
})

test('one viewer scope does not leak into the next request', async () => {
  // Each request carries its own scope; a member's answer must not be visible
  // to whoever asks next.
  const h = handler()
  await h(asViewer(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`, MEMBER))
  const res = await h(asViewer(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`))
  expect(await uris(res)).toEqual([PUBLIC_URI])
})

test('requests in flight at the same time keep their own scopes', async () => {
  const h = handler()
  const [memberRes, strangerRes] = await Promise.all([
    h(asViewer(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`, MEMBER)),
    h(asViewer(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`, STRANGER)),
  ])
  expect((await uris(memberRes)).sort()).toEqual([PUBLIC_URI, SPACE_RECORD].sort())
  expect(await uris(strangerRes)).toEqual([PUBLIC_URI])
})

test('a scope that cannot be resolved serves nothing from a space', async () => {
  // Failing to establish the scope must not widen it.
  readableSpacesFor.mockRejectedValue(new Error('authority unreachable'))
  const res = await handler()(asViewer(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}`, MEMBER))
  expect(await uris(res)).toEqual([PUBLIC_URI])
})

test('searching does not return a space record to someone outside it', async () => {
  const res = await handler()(
    asViewer(`/xrpc/dev.hatk.searchRecords?collection=${PUBLIC_COLLECTION}&q=members`, STRANGER),
  )
  const body = (await res.json()) as { items: { uri: string }[] }
  expect(body.items.map((r) => r.uri)).not.toContain(SPACE_RECORD)
})

// --- Blobs ---

test('a space blob is refused to a viewer who may not read the space', async () => {
  viewerCredential.mockResolvedValue(null)
  const res = await handler()(
    asViewer(`/space-blob?space=${encodeURIComponent(SPACE_URI)}&repo=${WRITER}&cid=bafy`, STRANGER),
  )
  expect(res.status).toBe(404)
})

test('a space blob is served to a member with their own credential', async () => {
  viewerCredential.mockResolvedValue({
    space: SPACE_URI,
    readerDid: MEMBER,
    expiresAt: Date.now() + 1000,
    fetch: async () => new Response('png bytes', { headers: { 'content-type': 'image/png' } }),
  })
  const res = await handler()(
    asViewer(`/space-blob?space=${encodeURIComponent(SPACE_URI)}&repo=${WRITER}&cid=bafy`, MEMBER),
  )
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('private, max-age=60, must-revalidate')
  expect(res.headers.get('etag')).toBe('"bafy"')
})

test('a space blob request carries its validator through to the answer', async () => {
  viewerCredential.mockResolvedValue({
    space: SPACE_URI,
    readerDid: MEMBER,
    expiresAt: Date.now() + 1000,
    fetch: async () => new Response('png bytes', { headers: { 'content-type': 'image/png' } }),
  })
  const request = asViewer(`/space-blob?space=${encodeURIComponent(SPACE_URI)}&repo=${WRITER}&cid=bafy`, MEMBER)
  request.headers.set('if-none-match', '"bafy"')
  const res = await handler()(request)
  expect(res.status).toBe(304)
})

test('a malformed space blob request is refused', async () => {
  const res = await handler()(asViewer('/space-blob?repo=did:plc:writer&cid=bafy', MEMBER))
  expect(res.status).toBe(400)
})

test('a space blob has no anonymous path', async () => {
  const res = await handler()(asViewer(`/space-blob?space=${encodeURIComponent(SPACE_URI)}&repo=${WRITER}&cid=bafy`))
  expect(res.status).toBe(401)
})
