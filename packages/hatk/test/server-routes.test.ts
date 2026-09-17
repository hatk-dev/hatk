import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler, registerCoreHandlers, startServer } from '../src/server.ts'
import { InvalidRequestError, NotFoundError, callXrpc, configureRelay, registerCoreXrpcHandler } from '../src/xrpc.ts'
import { ScopeMissingProxyError } from '../src/pds-proxy.ts'
import { defineFeed, registerFeed } from '../src/feeds.ts'
import { registerLabelModule } from '../src/labels.ts'
import { registerOgHandler } from '../src/opengraph.ts'
import { registerRenderer } from '../src/renderer.ts'
import { configurePlc } from '../src/backfill.ts'
import { getRepoStatus, getSchema, insertLabels, insertRecord, runSQL, setRepoStatus } from '../src/database/db.ts'
import { setupFixtureDatabase, PUBLIC_COLLECTION } from './fixture.ts'

// The public surface of the server, without OAuth: the dev.hatk.* read
// endpoints and their parameter handling, custom XRPC dispatch and error
// mapping, the repo endpoints clients use to enrol themselves, and the static
// file / SPA / SSR fallback chain.

const backfill = vi.hoisted(() => ({ triggerAutoBackfill: vi.fn(async () => {}) }))
vi.mock('../src/indexer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/indexer.ts')>()),
  ...backfill,
}))

const ALICE = 'did:plc:alice'
const uri = (n: number) => `at://${ALICE}/${PUBLIC_COLLECTION}/${n}`
const TEXTS = ['alpha', 'beta', 'gamma']

let viewer: { did: string; handle?: string } | null = null
let publicDir: string | null = null

function handler() {
  return createHandler({
    collections: [PUBLIC_COLLECTION],
    publicDir,
    oauth: null,
    admins: [],
    resolveViewer: () => viewer,
  })
}

const get = (path: string, headers?: Record<string, string>) =>
  handler()(new Request(`http://localhost${path}`, { headers }))
const post = (path: string, body: string, headers?: Record<string, string>) =>
  handler()(new Request(`http://localhost${path}`, { method: 'POST', body, headers }))

beforeAll(async () => {
  await setupFixtureDatabase()
  const table = getSchema(PUBLIC_COLLECTION)!.tableName
  await setRepoStatus(ALICE, 'active')
  for (const [i, text] of TEXTS.entries()) {
    await insertRecord(PUBLIC_COLLECTION, uri(i + 1), `cid-${i + 1}`, ALICE, { text })
    await runSQL(`UPDATE ${table} SET indexed_at = $1 WHERE uri = $2`, [`2024-01-0${i + 1}T00:00:00.000Z`, uri(i + 1)])
  }
})

afterEach(() => {
  viewer = null
  vi.unstubAllGlobals()
})

// --- plumbing ---

test('a CORS preflight is answered for any path without touching a route', async () => {
  const res = await handler()(new Request('http://localhost/xrpc/dev.hatk.getRecords', { method: 'OPTIONS' }))
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(res.headers.get('access-control-allow-methods')).toContain('POST')
})

test('the health check answers ok', async () => {
  const res = await get('/_health')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'ok' })
})

test('an unknown path is a plain 404 when there is no public directory', async () => {
  const res = await get('/nothing/here')
  expect(res.status).toBe(404)
  expect(await res.text()).toBe('Not Found')
})

// --- dev.hatk.getRecords ---

test('getRecords requires a collection', async () => {
  const res = await get('/xrpc/dev.hatk.getRecords')
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'Missing collection parameter' })
})

test('getRecords pages newest-first with a cursor and stops when the page is short', async () => {
  const first = await (await get(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}&limit=2`)).json()
  expect(first.items.map((i: any) => i.value.text)).toEqual(['gamma', 'beta'])
  expect(first.cursor).toBeTruthy()

  const second = await (
    await get(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}&limit=2&cursor=${first.cursor}`)
  ).json()
  expect(second.items.map((i: any) => i.value.text)).toEqual(['alpha'])
  expect(second.cursor).toBeUndefined()
})

test('getRecords sorts by a record field in either direction', async () => {
  const asc = await (await get(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}&sort=text&order=asc`)).json()
  expect(asc.items.map((i: any) => i.value.text)).toEqual(['alpha', 'beta', 'gamma'])
  const desc = await (
    await get(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}&sort=text&order=desc`)
  ).json()
  expect(desc.items.map((i: any) => i.value.text)).toEqual(['gamma', 'beta', 'alpha'])
})

test('getRecords rejects query parameters it cannot use instead of failing as a server error', async () => {
  const q = (params: string) => get(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}&${params}`)

  // A sort field the collection does not have.
  const badSort = await q('sort=nope')
  expect(badSort.status).toBe(400)
  expect(await badSort.json()).toEqual({ error: 'Invalid sort field: nope' })

  // `order` is spliced into ORDER BY, so anything but asc/desc is refused —
  // otherwise it reaches the database as a syntax error at best.
  const badOrder = await q('sort=text&order=sideways')
  expect(badOrder.status).toBe(400)
  expect(await badOrder.json()).toEqual({ error: 'Invalid order: sideways' })
  expect((await q('order=desc)%20--')).status).toBe(400)
  // Case is not the client's problem, though.
  expect((await q('sort=text&order=ASC')).status).toBe(200)

  // A non-numeric limit used to reach the driver as NaN, and a negative one
  // became "no limit at all" on SQLite.
  for (const bad of ['limit=abc', 'limit=-5', 'limit=1.5', 'limit=0', 'limit=1e9']) {
    const res = await q(bad)
    expect(res.status, bad).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid limit parameter' })
  }
  // An absent or empty limit still falls back to the default.
  expect((await (await q('limit=')).json()).items).toHaveLength(3)

  // A cursor that does not decode is ignored rather than rejected — it is
  // opaque to the client, and pagination degrades to the first page.
  expect((await (await q('cursor=@@@')).json()).items).toHaveLength(3)
})

test('the same parameter checks apply when getRecords is called through callXrpc', async () => {
  registerCoreHandlers([PUBLIC_COLLECTION], null)
  await expect(callXrpc('dev.hatk.getRecords', { collection: PUBLIC_COLLECTION, sort: 'nope' })).rejects.toThrow(
    /Invalid sort field: nope/,
  )
  await expect(callXrpc('dev.hatk.getRecords', { collection: PUBLIC_COLLECTION, order: 'sideways' })).rejects.toThrow(
    /Invalid order: sideways/,
  )
})

test('getRecords treats any other query parameter as an equality filter', async () => {
  const filtered = await (await get(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}&text=beta`)).json()
  expect(filtered.items.map((i: any) => i.uri)).toEqual([uri(2)])

  const byDid = await (await get(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}&did=did:plc:nobody`)).json()
  expect(byDid.items).toEqual([])

  // A filter on a column the schema does not have is ignored, not an error.
  const bogus = await (await get(`/xrpc/dev.hatk.getRecords?collection=${PUBLIC_COLLECTION}&bogus=1`)).json()
  expect(bogus.items).toHaveLength(3)
})

// --- dev.hatk.getRecord ---

test('getRecord requires a uri and attaches active labels to the record', async () => {
  expect((await get('/xrpc/dev.hatk.getRecord')).status).toBe(400)

  await insertLabels([{ src: 'self', uri: uri(1), val: 'spam' }])
  const body = await (await get(`/xrpc/dev.hatk.getRecord?uri=${uri(1)}`)).json()
  expect(body.record.value).toEqual({ text: 'alpha' })
  expect(body.record.labels).toEqual([expect.objectContaining({ val: 'spam', src: 'self' })])

  const unlabeled = await (await get(`/xrpc/dev.hatk.getRecord?uri=${uri(2)}`)).json()
  expect(unlabeled.record.labels).toEqual([])
})

// --- dev.hatk.getFeed ---

test('getFeed requires a feed name and 404s an unknown one', async () => {
  expect(await (await get('/xrpc/dev.hatk.getFeed')).json()).toEqual({ error: 'Missing feed parameter' })
  const res = await get('/xrpc/dev.hatk.getFeed?feed=nope')
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'Unknown feed: nope' })
})

test('getFeed forwards every query parameter, the viewer and the paging arguments to the generator', async () => {
  let seen: any
  registerFeed(
    'echo',
    defineFeed({
      collection: PUBLIC_COLLECTION,
      label: 'Echo',
      generate: async (ctx) => {
        seen = { params: ctx.params, viewer: ctx.viewer, limit: ctx.limit, cursor: ctx.cursor }
        return ctx.ok({ uris: [uri(1)], cursor: 'next' })
      },
    }),
  )
  viewer = { did: ALICE }
  const res = await get('/xrpc/dev.hatk.getFeed?feed=echo&extra=1&cursor=abc')
  expect(await res.json()).toEqual({ uris: [uri(1)], cursor: 'next' })
  expect(seen).toEqual({
    params: { feed: 'echo', extra: '1', cursor: 'abc' },
    viewer: { did: ALICE },
    limit: 30,
    cursor: 'abc',
  })

  await get('/xrpc/dev.hatk.getFeed?feed=echo&limit=5')
  expect(seen.limit).toBe(5)
})

// --- dev.hatk.searchRecords / describe* ---

test('searchRecords requires both a collection and a query', async () => {
  expect(await (await get('/xrpc/dev.hatk.searchRecords?q=x')).json()).toEqual({
    error: 'Missing collection parameter',
  })
  expect(await (await get(`/xrpc/dev.hatk.searchRecords?collection=${PUBLIC_COLLECTION}`)).json()).toEqual({
    error: 'Missing q parameter',
  })
})

test('describeFeeds, describeCollections and describeLabels expose what is registered', async () => {
  const feeds = await (await get('/xrpc/dev.hatk.describeFeeds')).json()
  expect(feeds.feeds).toContainEqual({ name: 'echo', label: 'Echo' })

  const collections = await (await get('/xrpc/dev.hatk.describeCollections')).json()
  expect(collections.collections).toEqual([
    {
      collection: PUBLIC_COLLECTION,
      columns: expect.arrayContaining([{ name: 'text', originalName: 'text', type: 'TEXT', required: true }]),
    },
  ])

  const def = { identifier: 'spam', severity: 'alert', blurs: 'content', defaultSetting: 'warn' } as const
  registerLabelModule('spam', { definition: def })
  const labels = await (await get('/xrpc/dev.hatk.describeLabels')).json()
  expect(labels.definitions).toEqual([def])
})

// --- preferences ---

test('preferences require a viewer and round-trip JSON values', async () => {
  expect((await get('/xrpc/dev.hatk.getPreferences')).status).toBe(401)
  expect((await post('/xrpc/dev.hatk.putPreference', '{}')).status).toBe(401)

  viewer = { did: ALICE }
  expect(await (await get('/xrpc/dev.hatk.getPreferences')).json()).toEqual({ preferences: {} })

  expect(await (await post('/xrpc/dev.hatk.putPreference', JSON.stringify({ value: 1 }))).json()).toEqual({
    error: 'Missing or invalid key',
  })
  expect(await (await post('/xrpc/dev.hatk.putPreference', JSON.stringify({ key: 'theme' }))).json()).toEqual({
    error: 'Missing value',
  })

  const ok = await post('/xrpc/dev.hatk.putPreference', JSON.stringify({ key: 'theme', value: { dark: true } }))
  expect(await ok.json()).toEqual({ success: true })
  expect(await (await get('/xrpc/dev.hatk.getPreferences')).json()).toEqual({ preferences: { theme: { dark: true } } })
})

test('putPreference is POST-only; a GET falls through to the generic dispatcher and 404s', async () => {
  viewer = { did: ALICE }
  expect((await get('/xrpc/dev.hatk.putPreference')).status).toBe(404)
})

// --- custom XRPC dispatch ---

test('a custom method receives query params, paging arguments, the viewer and a parsed POST body', async () => {
  registerCoreXrpcHandler('xyz.test.echo', async (params, cursor, limit, viewer, input) => ({
    params,
    cursor,
    limit,
    viewer,
    input: input ?? null,
  }))
  viewer = { did: ALICE }

  const viaGet = await (await get('/xrpc/xyz.test.echo?a=1&limit=5&cursor=c')).json()
  expect(viaGet).toEqual({
    params: { a: '1', limit: '5', cursor: 'c' },
    cursor: 'c',
    limit: 5,
    viewer: { did: ALICE },
    input: null,
  })

  const viaPost = await (await post('/xrpc/xyz.test.echo', JSON.stringify({ body: true }))).json()
  expect(viaPost).toMatchObject({ limit: 20, input: { body: true } })
  expect('cursor' in viaPost).toBe(false)

  // An unparseable body is an empty input, not a 500.
  const badJson = await (await post('/xrpc/xyz.test.echo', '{not json')).json()
  expect(badJson.input).toEqual({})
})

test('handler errors map to HTTP: InvalidRequestError 400, NotFoundError 404, anything else 500', async () => {
  registerCoreXrpcHandler('xyz.test.invalid', async () => {
    throw new InvalidRequestError('bad param')
  })
  registerCoreXrpcHandler('xyz.test.named', async () => {
    throw new InvalidRequestError('bad param', 'AuthRequired')
  })
  registerCoreXrpcHandler('xyz.test.missing', async () => {
    throw new NotFoundError('no such thing')
  })
  registerCoreXrpcHandler('xyz.test.boom', async () => {
    throw new Error('unexpected')
  })

  const invalid = await get('/xrpc/xyz.test.invalid')
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toEqual({ error: 'bad param' })

  // A named error is reported by its lexicon error name, as atproto clients expect.
  expect(await (await get('/xrpc/xyz.test.named')).json()).toEqual({ error: 'AuthRequired' })

  const missing = await get('/xrpc/xyz.test.missing')
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: 'NotFound' })

  const boom = await get('/xrpc/xyz.test.boom')
  expect(boom.status).toBe(500)
  expect(await boom.json()).toEqual({ error: 'unexpected' })
  expect(boom.headers.get('access-control-allow-origin')).toBe('*')
})

test('an unregistered method, or a handler that answers nothing, is a 404', async () => {
  expect((await get('/xrpc/xyz.test.unregistered')).status).toBe(404)
  registerCoreXrpcHandler('xyz.test.empty', async () => undefined)
  expect((await get('/xrpc/xyz.test.empty')).status).toBe(404)
})

test('a scope refusal from the PDS signs the browser out so it can re-authorize', async () => {
  registerCoreXrpcHandler('xyz.test.scope', async () => {
    throw new ScopeMissingProxyError()
  })
  viewer = { did: ALICE, handle: 'alice.test' }
  const res = await get('/xrpc/xyz.test.scope')
  expect(res.status).toBe(401)
  expect(await res.json()).toEqual({ error: 'ScopeMissingError', handle: 'alice.test' })
  expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
})

// --- public repo enrolment ---

test('/repos/add validates the body, marks each repo pending and starts a backfill', async () => {
  expect(await (await post('/repos/add', JSON.stringify({ dids: 'x' }))).json()).toEqual({
    error: 'Missing dids array',
  })

  const res = await post('/repos/add', JSON.stringify({ dids: ['did:plc:new1', 'did:plc:new2'] }))
  expect(await res.json()).toEqual({ added: 2 })
  expect(await getRepoStatus('did:plc:new1')).toBe('pending')
  expect(backfill.triggerAutoBackfill).toHaveBeenCalledWith('did:plc:new1')
  expect(backfill.triggerAutoBackfill).toHaveBeenCalledWith('did:plc:new2')
})

test('/info/:did reports a repo status with its retry state, and 404s an unknown repo', async () => {
  expect((await get('/info/did:plc:unknown')).status).toBe(404)
  expect(await (await get('/info/did:plc:new1')).json()).toEqual({
    did: 'did:plc:new1',
    status: 'pending',
    retry_count: 0,
    retry_after: 0,
  })
})

// --- dev blob proxy ---

test('/blob is only served on a local relay', async () => {
  configureRelay('wss://bsky.network')
  expect((await get('/blob/did:plc:x/bafy')).status).toBe(404)
})

test("/blob fetches the bytes from the repo's own PDS and re-serves them cacheable", async () => {
  configureRelay('http://localhost:2583')
  configurePlc('http://plc.test')
  const fetchMock = vi.fn(async (input: string) => {
    if (input === 'http://plc.test/did:plc:blobber') {
      return Response.json({ service: [{ id: '#atproto_pds', serviceEndpoint: 'http://localhost:2584' }] })
    }
    if (input.includes('cid=bafyok'))
      return new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'image/jpeg' } })
    if (input.includes('cid=bafyuntyped')) return new Response(new Uint8Array([1]))
    if (input.includes('cid=bafymissing')) return new Response(null, { status: 404 })
    throw new Error('connection refused')
  })
  vi.stubGlobal('fetch', fetchMock)

  expect(await (await get('/blob/did:plc:blobber')).json()).toEqual({ error: 'Expected /blob/:did/:cid' })

  const ok = await get('/blob/did:plc:blobber/bafyok')
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toBe('image/jpeg')
  expect(ok.headers.get('cache-control')).toBe('public, max-age=3600')
  expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([9, 9]))
  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:2584/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Ablobber&cid=bafyok',
  )

  expect((await get('/blob/did:plc:blobber/bafyuntyped')).headers.get('content-type')).toBe('application/octet-stream')

  const missing = await get('/blob/did:plc:blobber/bafymissing')
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: 'Blob not found' })

  const down = await get('/blob/did:plc:blobber/bafydown')
  expect(down.status).toBe(502)
  expect(await down.json()).toEqual({ error: 'Blob fetch failed: connection refused' })
  configureRelay('')
})

// --- static files, SPA fallback, SSR ---

let dir: string
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const TEMPLATE = '<!doctype html><html><head><title>app</title></head><body><!--ssr-outlet--></body></html>'

test('robots.txt comes from the package by default and from the public directory when it has one', async () => {
  const fallback = await get('/robots.txt')
  expect(fallback.status).toBe(200)
  expect(fallback.headers.get('content-type')).toBe('text/plain')
  expect(await fallback.text()).toBe(await readFile(join(import.meta.dirname, '../public/robots.txt'), 'utf8'))

  dir = await mkdtemp(join(tmpdir(), 'hatk-public-'))
  await writeFile(join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /secret\n')
  await writeFile(join(dir, 'index.html'), TEMPLATE)
  await writeFile(join(dir, 'app.js'), 'console.log(1)')
  await writeFile(join(dir, 'styles.css'), 'body{}')
  await writeFile(join(dir, 'data.json'), '{"a":1}')
  await writeFile(join(dir, 'notes.txt'), 'plain')
  publicDir = dir

  expect(await (await get('/robots.txt')).text()).toContain('Disallow: /secret')
})

test('static files are served with a MIME type by extension, unknown extensions as text', async () => {
  publicDir = dir
  expect((await get('/app.js')).headers.get('content-type')).toBe('application/javascript')
  expect((await get('/styles.css')).headers.get('content-type')).toBe('text/css')
  expect((await get('/data.json')).headers.get('content-type')).toBe('application/json')
  expect((await get('/notes.txt')).headers.get('content-type')).toBe('text/plain')
  expect(await (await get('/app.js')).text()).toBe('console.log(1)')
})

test('the root and any unknown path serve index.html so the SPA can route client-side', async () => {
  publicDir = dir
  const root = await get('/')
  expect(root.headers.get('content-type')).toBe('text/html')
  expect(await root.text()).toBe(TEMPLATE)

  const deep = await get('/profile/alice')
  expect(deep.status).toBe(200)
  expect(await deep.text()).toBe(TEMPLATE)
})

test('a page with an OG image route gets its meta tags injected, using the forwarded origin', async () => {
  publicDir = dir
  registerOgHandler({ path: '/og/item/:id', generate: async () => ({ element: { type: 'div', props: {} } }) })

  const html = await (await get('/item/42', { 'x-forwarded-proto': 'https', host: 'app.test' })).text()
  expect(html).toContain('<meta property="og:image" content="https://app.test/og/item/42">')
  expect(html).toContain('<meta property="og:url" content="https://app.test/item/42">')
  expect(html.indexOf('og:image')).toBeLessThan(html.indexOf('</head>'))
  // The SPA outlet is untouched without a renderer.
  expect(html).toContain('<!--ssr-outlet-->')
})

test('with a renderer registered, pages are server-rendered with the viewer exposed during the render only', async () => {
  publicDir = dir
  viewer = { did: ALICE }
  let viewerDuringRender: unknown = 'unset'
  registerRenderer(async (request) => {
    viewerDuringRender = (globalThis as any).__hatk_viewer
    return { html: `<main>${new URL(request.url).pathname}</main>`, head: '<meta name="ssr">' }
  })

  const res = await get('/item/42')
  const html = await res.text()
  expect(html).toContain('<body><main>/item/42</main></body>')
  expect(html).toContain('<meta name="ssr">')
  expect(html).toContain('og:image')
  expect(viewerDuringRender).toEqual({ did: ALICE })
  expect((globalThis as any).__hatk_viewer).toBeNull()
})

test('an OG path with no matching handler falls through to the normal chain', async () => {
  publicDir = null
  expect((await get('/og/unknown/1')).status).toBe(404)
})

test('startServer wraps the handler in a listening Node server', async () => {
  // Port 0 asks the OS for a free loopback port; nothing leaves the machine.
  const server = startServer(0, [PUBLIC_COLLECTION], null, null)
  await new Promise<void>((r) => server.once('listening', r))
  try {
    const { port } = server.address() as { port: number }
    expect(port).toBeGreaterThan(0)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
