import { beforeEach, expect, test, vi } from 'vitest'

const verifyNotice = vi.fn()
const handleWriteNotice = vi.fn()
const unwatchSpace = vi.fn()
const spaceServiceId = vi.fn()

vi.mock('../src/spaces/index.ts', async () => {
  const notify = await vi.importActual<typeof import('../src/spaces/notify.ts')>('../src/spaces/notify.ts')
  const idx = await vi.importActual<typeof import('../src/spaces/index.ts')>('../src/spaces/index.ts')
  return {
    ...notify,
    spaceDidDocument: idx.spaceDidDocument,
    verifyNotice: (...a: unknown[]) => verifyNotice(...a),
    handleWriteNotice: (...a: unknown[]) => handleWriteNotice(...a),
    unwatchSpace: (...a: unknown[]) => unwatchSpace(...a),
    spaceServiceId: () => spaceServiceId(),
  }
})
vi.mock('../src/spaces/viewer.ts', () => ({
  readableSpacesFor: async () => [],
  viewerCredential: async () => null,
  forgetViewerSpaces: vi.fn(),
  resetViewerSpaces: vi.fn(),
}))

const { createHandler } = await import('../src/server.ts')
const { clearPendingNotices, NoticeError } = await import('../src/spaces/notify.ts')
const { setupFixtureDatabase, PUBLIC_COLLECTION } = await import('./fixture.ts')

const AUTHORITY = 'did:plc:authority'
const SPACE = `at://${AUTHORITY}/space/test.hatk.board/self`
const WRITER = 'did:plc:writer'
const SERVICE_ID = 'did:web:appview.test#atproto_space_syncer'

await setupFixtureDatabase()

function handler(spaces?: { serviceDid?: string; serviceFragment?: string; publicUrl?: string }) {
  return createHandler({
    collections: [PUBLIC_COLLECTION],
    publicDir: null,
    oauth: null,
    admins: [],
    ...(spaces ? { spaces } : {}),
  })
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.useFakeTimers()
  verifyNotice.mockReset()
  verifyNotice.mockResolvedValue(undefined)
  handleWriteNotice.mockReset()
  handleWriteNotice.mockResolvedValue(true)
  unwatchSpace.mockReset()
  unwatchSpace.mockResolvedValue(undefined)
  spaceServiceId.mockReset()
  spaceServiceId.mockReturnValue(SERVICE_ID)
  clearPendingNotices()
})

// --- notifyWrite ---

test('a verified notice is acknowledged and the repo read afterwards', async () => {
  // Answered before syncing: delivery is best-effort by protocol, and a sync
  // failure is not the authority's problem to wait on.
  const res = await handler({ serviceDid: 'did:web:appview.test' })(
    post('/xrpc/com.atproto.space.notifyWrite', { space: SPACE, repo: WRITER, rev: '3a' }),
  )
  expect(res.status).toBe(200)
  expect(handleWriteNotice).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(handleWriteNotice).toHaveBeenCalledWith({ space: SPACE, repo: WRITER, rev: '3a' })
})

test('the notice is verified against the authority the body names', async () => {
  await handler({ serviceDid: 'did:web:appview.test' })(
    post('/xrpc/com.atproto.space.notifyWrite', { space: SPACE, repo: WRITER, rev: '3a' }),
  )
  expect(verifyNotice).toHaveBeenCalledWith('Bearer token', {
    iss: AUTHORITY,
    aud: SERVICE_ID,
    lxm: 'com.atproto.space.notifyWrite',
  })
})

test('an unverified notice changes nothing', async () => {
  verifyNotice.mockRejectedValue(new NoticeError(403, 'Notice signature does not verify'))
  const res = await handler({ serviceDid: 'did:web:appview.test' })(
    post('/xrpc/com.atproto.space.notifyWrite', { space: SPACE, repo: WRITER, rev: '3a' }),
  )
  expect(res.status).toBe(403)
  await vi.advanceTimersByTimeAsync(1000)
  expect(handleWriteNotice).not.toHaveBeenCalled()
})

test('a malformed notice is refused before it is verified', async () => {
  const res = await handler({ serviceDid: 'did:web:appview.test' })(
    post('/xrpc/com.atproto.space.notifyWrite', { repo: WRITER }),
  )
  expect(res.status).toBe(400)
  expect(verifyNotice).not.toHaveBeenCalled()
})

test('an instance that receives no notices has no endpoint to speak of', async () => {
  spaceServiceId.mockReturnValue(null)
  const res = await handler()(post('/xrpc/com.atproto.space.notifyWrite', { space: SPACE, repo: WRITER, rev: '3a' }))
  expect(res.status).toBe(404)
  expect(verifyNotice).not.toHaveBeenCalled()
})

test('a burst about one repo becomes a single read', async () => {
  const h = handler({ serviceDid: 'did:web:appview.test' })
  for (let i = 0; i < 4; i++) {
    await h(post('/xrpc/com.atproto.space.notifyWrite', { space: SPACE, repo: WRITER, rev: `3${i}` }))
  }
  await vi.advanceTimersByTimeAsync(2000)
  expect(handleWriteNotice).toHaveBeenCalledTimes(1)
})

// --- notifySpaceDeleted ---

test('a verified deletion drops the space', async () => {
  const res = await handler({ serviceDid: 'did:web:appview.test' })(
    post('/xrpc/com.atproto.space.notifySpaceDeleted', { space: SPACE }),
  )
  expect(res.status).toBe(200)
  expect(unwatchSpace).toHaveBeenCalledWith(SPACE)
})

test('a deletion is verified as its own method', async () => {
  await handler({ serviceDid: 'did:web:appview.test' })(
    post('/xrpc/com.atproto.space.notifySpaceDeleted', { space: SPACE }),
  )
  expect(verifyNotice.mock.calls[0][1].lxm).toBe('com.atproto.space.notifySpaceDeleted')
})

test('an unverified deletion drops nothing', async () => {
  verifyNotice.mockRejectedValue(new NoticeError(403, 'nope'))
  const res = await handler({ serviceDid: 'did:web:appview.test' })(
    post('/xrpc/com.atproto.space.notifySpaceDeleted', { space: SPACE }),
  )
  expect(res.status).toBe(403)
  expect(unwatchSpace).not.toHaveBeenCalled()
})

test('a deletion naming something that is not a space is refused', async () => {
  const res = await handler({ serviceDid: 'did:web:appview.test' })(
    post('/xrpc/com.atproto.space.notifySpaceDeleted', { space: 'at://did:plc:x/app.bsky.feed.post/1' }),
  )
  expect(res.status).toBe(400)
  expect(unwatchSpace).not.toHaveBeenCalled()
})

// --- The DID document ---

test('the DID document names where to deliver, and publishes no key', async () => {
  // A syncer signs nothing: it verifies inbound notices and presents
  // credentials bound to an ephemeral key, so there is no key to publish.
  const res = await handler({ serviceDid: 'did:web:appview.test', publicUrl: 'https://appview.test' })(
    new Request('http://localhost/.well-known/did.json'),
  )
  expect(res.status).toBe(200)
  const doc = (await res.json()) as any
  expect(doc.id).toBe('did:web:appview.test')
  expect(doc.service).toEqual([
    { id: '#atproto_space_syncer', type: 'AtprotoSpaceService', serviceEndpoint: 'https://appview.test' },
  ])
  expect(doc.verificationMethod).toBeUndefined()
})

test('the delivery endpoint falls back to the origin the request arrived on', async () => {
  const res = await handler({ serviceDid: 'did:web:appview.test' })(
    new Request('http://localhost/.well-known/did.json', { headers: { host: 'appview.test' } }),
  )
  const doc = (await res.json()) as any
  expect(doc.service[0].serviceEndpoint).toBe('http://appview.test')
})

test('a custom fragment is honoured in the document', async () => {
  const res = await handler({ serviceDid: 'did:web:appview.test', serviceFragment: 'hatk' })(
    new Request('http://localhost/.well-known/did.json'),
  )
  const doc = (await res.json()) as any
  expect(doc.service[0].id).toBe('#hatk')
})

test('an instance with no service DID publishes no document', async () => {
  const res = await handler()(new Request('http://localhost/.well-known/did.json'))
  expect(res.status).toBe(404)
})
