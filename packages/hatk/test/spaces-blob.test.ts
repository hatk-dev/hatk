import { beforeEach, expect, test, vi } from 'vitest'

const viewerCredential = vi.fn()

vi.mock('../src/spaces/viewer.ts', () => ({
  viewerCredential: (...a: unknown[]) => viewerCredential(...a),
  readableSpacesFor: vi.fn(),
  forgetViewerSpaces: vi.fn(),
  resetViewerSpaces: vi.fn(),
}))
vi.mock('../src/spaces/identity.ts', () => ({
  repoEndpoint: async (did: string) => `https://${did.replace(/[^a-z0-9]/gi, '')}.test`,
  spaceHostEndpoint: vi.fn(),
  configureSpaceIdentity: vi.fn(),
  clearSpaceIdentityCache: vi.fn(),
}))

const { parseSpaceBlobRequest, serveSpaceBlob } = await import('../src/spaces/blob.ts')

const SPACE = 'at://did:plc:authority/space/test.hatk.board/self'
const WRITER = 'did:plc:writer'
const VIEWER = { did: 'did:plc:member' }
const oauth = { issuer: 'https://appview.test', scopes: ['atproto'], clients: [] } as any
const request = { space: SPACE, repo: WRITER, cid: 'bafyimage' }

let credentialFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  credentialFetch = vi.fn(async () => new Response('bytes', { headers: { 'content-type': 'image/png' } }))
  viewerCredential.mockReset()
  viewerCredential.mockResolvedValue({ space: SPACE, readerDid: VIEWER.did, expiresAt: 0, fetch: credentialFetch })
})

// --- Parsing ---

test('a request names the space, the repo holding the blob, and the cid', () => {
  expect(parseSpaceBlobRequest(new URLSearchParams({ space: SPACE, repo: WRITER, cid: 'bafy' }))).toEqual({
    space: SPACE,
    repo: WRITER,
    cid: 'bafy',
  })
})

test('did is accepted as an alias for repo', () => {
  // Servers hosting one account let `did` appear to work, so clients send it.
  expect(parseSpaceBlobRequest(new URLSearchParams({ space: SPACE, did: WRITER, cid: 'bafy' }))?.repo).toBe(WRITER)
})

test('an incomplete or malformed request is refused', () => {
  expect(parseSpaceBlobRequest(new URLSearchParams({ space: SPACE, repo: WRITER }))).toBeNull()
  expect(parseSpaceBlobRequest(new URLSearchParams({ repo: WRITER, cid: 'bafy' }))).toBeNull()
  expect(parseSpaceBlobRequest(new URLSearchParams({ space: 'at://x/y/z', repo: WRITER, cid: 'bafy' }))).toBeNull()
  expect(parseSpaceBlobRequest(new URLSearchParams({ space: SPACE, repo: 'alice.test', cid: 'bafy' }))).toBeNull()
})

// --- Serving ---

test('a signed-out request is refused before anything is fetched', async () => {
  const res = await serveSpaceBlob(oauth, null, request)
  expect(res.status).toBe(401)
  expect(viewerCredential).not.toHaveBeenCalled()
})

test('a viewer who may not read the space gets the same answer as a missing blob', async () => {
  // Distinguishing "you may not" from "it is not there" is itself information
  // about a private space.
  viewerCredential.mockResolvedValue(null)
  expect((await serveSpaceBlob(oauth, VIEWER, request)).status).toBe(404)
})

test('the blob is fetched from the repo that holds it, with the viewer credential', async () => {
  await serveSpaceBlob(oauth, VIEWER, request)
  const url = new URL(credentialFetch.mock.calls[0][0].toString())
  expect(url.origin).toBe('https://didplcwriter.test')
  expect(url.pathname).toBe('/xrpc/com.atproto.space.getBlob')
  expect(Object.fromEntries(url.searchParams)).toEqual({ space: SPACE, repo: WRITER, cid: 'bafyimage' })
})

test('bytes come back renderable and uncacheable', async () => {
  const res = await serveSpaceBlob(oauth, VIEWER, request)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/png')
  // This response is one viewer's; the next request for the same URL may be
  // somebody with no right to it.
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await res.text()).toBe('bytes')
})

test('a content type the repo chose is not echoed back unchecked', async () => {
  // The record naming this blob was written by an account hatk does not
  // control, and so was its mime type.
  credentialFetch.mockResolvedValue(new Response('<script/>', { headers: { 'content-type': 'text/html' } }))
  const res = await serveSpaceBlob(oauth, VIEWER, request)
  expect(res.headers.get('content-type')).toBe('application/octet-stream')
})

test('a content type with parameters is still recognised', async () => {
  credentialFetch.mockResolvedValue(
    new Response('bytes', { headers: { 'content-type': 'image/jpeg; charset=binary' } }),
  )
  expect((await serveSpaceBlob(oauth, VIEWER, request)).headers.get('content-type')).toBe('image/jpeg')
})

test('a refusal from the repo host is passed through', async () => {
  credentialFetch.mockResolvedValue(new Response('nope', { status: 404 }))
  expect((await serveSpaceBlob(oauth, VIEWER, request)).status).toBe(404)
})

test('a credential the repo host rejects reads as absent, not as unauthorized', async () => {
  credentialFetch.mockResolvedValue(new Response('nope', { status: 401 }))
  expect((await serveSpaceBlob(oauth, VIEWER, request)).status).toBe(404)
})

test('an unreachable repo host is reported as an upstream failure', async () => {
  credentialFetch.mockRejectedValue(new Error('offline'))
  expect((await serveSpaceBlob(oauth, VIEWER, request)).status).toBe(502)
})
