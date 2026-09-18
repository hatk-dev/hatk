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

const { asPreset, parseSpaceBlobRequest, resetSpaceBlobCache, serveSpaceBlob, spaceBlobUrl } =
  await import('../src/spaces/blob.ts')
const { default: sharp } = await import('sharp')

/** A photograph-shaped source: flat colour would compress to nothing and prove nothing. */
async function photo(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  return bytes(
    sharp({
      create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 }, background: '#888' },
    })
      .jpeg({ quality: 95 })
      .toBuffer(),
  )
}

/** Node's Buffer is not a `BodyInit` as far as the type checker is concerned. */
async function bytes(buf: Promise<Buffer>): Promise<Uint8Array<ArrayBuffer>> {
  const out = await buf
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength) as Uint8Array<ArrayBuffer>
}

const SPACE = 'at://did:plc:authority/space/test.hatk.board/self'
const WRITER = 'did:plc:writer'
const VIEWER = { did: 'did:plc:member' }
const oauth = { issuer: 'https://appview.test', scopes: ['atproto'], clients: [] } as any
const request = { space: SPACE, repo: WRITER, cid: 'bafyimage' }

const IMAGE = { 'content-type': 'image/jpeg' }

let credentialFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  credentialFetch = vi.fn(async () => new Response('bytes', { headers: { 'content-type': 'image/png' } }))
  viewerCredential.mockReset()
  viewerCredential.mockResolvedValue({ space: SPACE, readerDid: VIEWER.did, expiresAt: 0, fetch: credentialFetch })
  resetSpaceBlobCache()
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

test('bytes come back renderable, and cacheable by the one browser shown them', async () => {
  const res = await serveSpaceBlob(oauth, VIEWER, request)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/png')
  // `private` and no more: the viewer's own browser may keep what it was
  // shown, and no cache between here and there may.
  expect(res.headers.get('cache-control')).toBe('private, max-age=60, must-revalidate')
  // Two people signing in on one browser must not share an entry.
  expect(res.headers.get('vary')).toBe('cookie, authorization')
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

// --- Revalidation ---

test('the cid is the etag, because a cid is a hash of the bytes it names', async () => {
  const res = await serveSpaceBlob(oauth, VIEWER, request)
  expect(res.headers.get('etag')).toBe('"bafyimage"')
})

test('a browser that already holds the blob is told so, and no bytes are fetched', async () => {
  const res = await serveSpaceBlob(oauth, VIEWER, request, '"bafyimage"')
  expect(res.status).toBe(304)
  expect(res.headers.get('etag')).toBe('"bafyimage"')
  expect(res.headers.get('cache-control')).toBe('private, max-age=60, must-revalidate')
  expect(credentialFetch).not.toHaveBeenCalled()
})

test('a 304 is still an authorized answer', async () => {
  // The cheap path is the one most worth checking: a viewer who has lost
  // access must not keep being told to use what they hold.
  viewerCredential.mockResolvedValue(null)
  const res = await serveSpaceBlob(oauth, VIEWER, request, '"bafyimage"')
  expect(res.status).toBe(404)
})

test('a weak or listed validator still matches', async () => {
  expect((await serveSpaceBlob(oauth, VIEWER, request, 'W/"bafyimage"')).status).toBe(304)
  expect((await serveSpaceBlob(oauth, VIEWER, request, '"other", "bafyimage"')).status).toBe(304)
  expect((await serveSpaceBlob(oauth, VIEWER, request, '*')).status).toBe(304)
})

test('a validator for a different blob is not a match', async () => {
  expect((await serveSpaceBlob(oauth, VIEWER, request, '"bafyother"')).status).toBe(200)
})

// --- The blob cache ---

test('a blob is fetched from its repo once, however many viewers ask', async () => {
  const first = await serveSpaceBlob(oauth, VIEWER, request)
  const second = await serveSpaceBlob(oauth, { did: 'did:plc:other' }, request)
  expect(credentialFetch).toHaveBeenCalledTimes(1)
  expect(await first.text()).toBe('bytes')
  expect(await second.text()).toBe('bytes')
  expect(second.headers.get('content-type')).toBe('image/png')
})

test('viewers asking at the same moment share one fetch', async () => {
  const [a, b] = await Promise.all([
    serveSpaceBlob(oauth, VIEWER, request),
    serveSpaceBlob(oauth, { did: 'did:plc:other' }, request),
  ])
  expect(credentialFetch).toHaveBeenCalledTimes(1)
  expect(await a.text()).toBe('bytes')
  expect(await b.text()).toBe('bytes')
})

test('a cached blob is still not served to a viewer who may not read the space', async () => {
  await serveSpaceBlob(oauth, VIEWER, request)
  viewerCredential.mockResolvedValue(null)
  expect((await serveSpaceBlob(oauth, { did: 'did:plc:stranger' }, request)).status).toBe(404)
})

test('the cache is keyed by space as well as cid', async () => {
  // A cid names bytes, and the check that a blob is referenced from the space
  // being named lives upstream. Hitting across spaces would skip it — so a
  // viewer who may read one space could name any cid they had heard of.
  await serveSpaceBlob(oauth, VIEWER, request)
  const elsewhere = { ...request, space: 'at://did:plc:authority/space/test.hatk.board/other' }
  await serveSpaceBlob(oauth, VIEWER, elsewhere)
  expect(credentialFetch).toHaveBeenCalledTimes(2)
  expect(new URL(credentialFetch.mock.calls[1][0].toString()).searchParams.get('space')).toBe(elsewhere.space)
})

test('a failed read is not remembered as an answer', async () => {
  credentialFetch.mockResolvedValueOnce(new Response('nope', { status: 404 }))
  expect((await serveSpaceBlob(oauth, VIEWER, request)).status).toBe(404)
  expect((await serveSpaceBlob(oauth, VIEWER, request)).status).toBe(200)
})

test('a blob too large to hold is served anyway, and not held', async () => {
  const big = () => new Response(new Uint8Array(5 * 1024 * 1024), { headers: { 'content-type': 'image/jpeg' } })
  credentialFetch.mockImplementation(async () => big())
  const res = await serveSpaceBlob(oauth, VIEWER, request)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/jpeg')
  expect((await res.arrayBuffer()).byteLength).toBe(5 * 1024 * 1024)
  // Read once to find the size, then again to stream it — and still not cached.
  const before = credentialFetch.mock.calls.length
  await serveSpaceBlob(oauth, VIEWER, request)
  expect(credentialFetch.mock.calls.length).toBeGreaterThan(before)
})

test('a length the repo host never sent does not stop the blob being held', async () => {
  // Trusting content-length would mean a host that omits it is never cached.
  credentialFetch.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('bytes'))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
  )
  expect(await (await serveSpaceBlob(oauth, VIEWER, request)).text()).toBe('bytes')
  await serveSpaceBlob(oauth, VIEWER, request)
  expect(credentialFetch).toHaveBeenCalledTimes(1)
})

// --- Presets ---

test('a preset rides along in the url, and none is the original', () => {
  expect(spaceBlobUrl(SPACE, WRITER, 'bafy', 'feed_thumbnail')).toContain('preset=feed_thumbnail')
  expect(spaceBlobUrl(SPACE, WRITER, 'bafy')).not.toContain('preset')
})

test('only a name from the list is a preset', () => {
  // Free-form dimensions would let anyone mint unlimited cache keys and put
  // the cost of an arbitrary resize behind a URL.
  expect(asPreset('avatar_thumbnail')).toBe('avatar_thumbnail')
  expect(asPreset('rs:fill:4000:4000')).toBeUndefined()
  expect(asPreset(null)).toBeUndefined()
})

test('an unrecognised preset is served as the original, not refused', () => {
  // A broken image is a worse answer than a large one.
  const parsed = parseSpaceBlobRequest(new URLSearchParams({ space: SPACE, repo: WRITER, cid: 'bafy', preset: 'huge' }))
  expect(parsed).toEqual({ space: SPACE, repo: WRITER, cid: 'bafy' })
})

test('the preset is part of the etag, because it is part of the answer', async () => {
  const res = await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'feed_thumbnail' })
  expect(res.headers.get('etag')).toBe('"bafyimage-feed_thumbnail"')
})

test('two sizes of one blob are two cache entries', async () => {
  credentialFetch.mockImplementation(async () => new Response(await photo(400, 300), { headers: IMAGE }))
  await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'feed_thumbnail' })
  await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'avatar_thumbnail' })
  await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'avatar_thumbnail' })
  expect(credentialFetch).toHaveBeenCalledTimes(2)
})

test('a photograph comes back at the size it is drawn', async () => {
  const source = await photo(3000, 2000)
  credentialFetch.mockImplementation(async () => new Response(source, { headers: IMAGE }))

  const res = await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'avatar_thumbnail' })
  const out = Buffer.from(await res.arrayBuffer())
  expect(res.headers.get('content-type')).toBe('image/jpeg')
  const meta = await sharp(out).metadata()
  expect(meta.width).toBe(128)
  expect(meta.height).toBe(128)
  expect(out.byteLength).toBeLessThan(source.byteLength / 10)
})

test('a small source is not blown up to fill its preset', async () => {
  credentialFetch.mockImplementation(async () => new Response(await photo(200, 150), { headers: IMAGE }))
  const res = await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'feed_thumbnail' })
  expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(200)
})

test('the format is kept, so a transparent png does not quietly go opaque', async () => {
  const png = await sharp({ create: { width: 600, height: 600, channels: 4, background: '#0000' } })
    .png()
    .toBuffer()
  credentialFetch.mockImplementation(async () => new Response(png, { headers: { 'content-type': 'image/png' } }))
  const res = await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'avatar_thumbnail' })
  expect(res.headers.get('content-type')).toBe('image/png')
  expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).hasAlpha).toBe(true)
})

test('an animation is served whole rather than reduced to its first frame', async () => {
  const gif = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#123' } })
    .gif()
    .toBuffer()
  credentialFetch.mockImplementation(async () => new Response(gif, { headers: { 'content-type': 'image/gif' } }))
  const res = await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'feed_thumbnail' })
  expect(Buffer.from(await res.arrayBuffer()).byteLength).toBe(gif.byteLength)
})

test('something sharp cannot read is served as it came', async () => {
  // Resizing is an improvement on the answer, never a condition of giving one.
  const res = await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'feed_thumbnail' })
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('bytes')
})

test('an original too large to hold is still worth resizing', async () => {
  // The camera-sized photograph is the case resizing pays for most; refusing
  // to read it would refuse the request that needs answering.
  const source = await photo(4000, 3000)
  expect(source.byteLength).toBeGreaterThan(4 * 1024 * 1024)
  credentialFetch.mockImplementation(async () => new Response(source, { headers: IMAGE }))

  const res = await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'feed_thumbnail' })
  expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(1000)
  await serveSpaceBlob(oauth, VIEWER, { ...request, preset: 'feed_thumbnail' })
  expect(credentialFetch).toHaveBeenCalledTimes(1)
})
