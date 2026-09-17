import { expect, test } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { cors, file, json, jsonError, notFound, withCors } from '../src/response.ts'

// Every hatk route answers through these helpers, so their headers are the
// contract clients and CDNs see: when a body is compressed, when it may be
// cached, and what CORS allows.

const big = { text: 'x'.repeat(4096) }

test('a small JSON body is sent uncompressed even when the client accepts gzip', async () => {
  // Compressing a few hundred bytes costs more than it saves.
  const res = json({ ok: true }, 200, 'gzip, deflate')
  expect(res.headers.get('content-encoding')).toBeNull()
  expect(res.headers.get('content-type')).toBe('application/json')
  expect(await res.json()).toEqual({ ok: true })
})

test('a large JSON body is gzipped only when the client accepts gzip', async () => {
  const compressed = json(big, 200, 'gzip, deflate')
  expect(compressed.headers.get('content-encoding')).toBe('gzip')
  expect(compressed.headers.get('vary')).toBe('Accept-Encoding')
  const raw = gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString()
  expect(JSON.parse(raw)).toEqual(big)

  // `identity` and a missing header both mean "do not compress".
  expect(json(big, 200, 'identity').headers.get('content-encoding')).toBeNull()
  expect(json(big, 200, null).headers.get('content-encoding')).toBeNull()
  expect(await json(big, 200, undefined).json()).toEqual(big)
})

test('successful responses are marked no-store but errors are not', () => {
  // Successful bodies are viewer-specific; an error carries nothing worth caching
  // either way, and omitting the header keeps error responses minimal.
  expect(json({}, 200).headers.get('cache-control')).toBe('no-store')
  expect(json({}, 404).headers.get('cache-control')).toBeNull()
  expect(json(big, 200, 'gzip').headers.get('cache-control')).toBe('no-store')
  expect(json(big, 500, 'gzip').headers.get('cache-control')).toBeNull()
})

test('database values are normalized while serializing', async () => {
  // DuckDB hands back timestamps as `{ micros }` and counts as bigint; neither
  // is valid JSON on its own.
  const res = json({ ts: { micros: 1_700_000_000_000_000 }, count: 5n })
  expect(await res.json()).toEqual({ ts: '2023-11-14T22:13:20.000Z', count: 5 })
})

test('jsonError wraps the message with the requested status', async () => {
  const res = jsonError(403, 'nope')
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'nope' })
})

test('the preflight response allows any origin, header and the supported methods', () => {
  const res = cors()
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(res.headers.get('access-control-allow-headers')).toBe('*')
  expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
})

test('withCors keeps status, body and existing headers while adding CORS', async () => {
  const original = new Response('payload', {
    status: 418,
    statusText: 'teapot',
    headers: { 'content-type': 'text/plain', 'x-custom': '1' },
  })
  const res = withCors(original)
  expect(res.status).toBe(418)
  expect(res.statusText).toBe('teapot')
  expect(res.headers.get('x-custom')).toBe('1')
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(await res.text()).toBe('payload')
})

test('file responses carry the content type and an optional cache policy', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const cached = file(bytes, 'image/png', 'public, max-age=300')
  expect(cached.headers.get('content-type')).toBe('image/png')
  expect(cached.headers.get('cache-control')).toBe('public, max-age=300')
  expect(new Uint8Array(await cached.arrayBuffer())).toEqual(bytes)

  expect(file(Buffer.from('hi'), 'text/plain').headers.get('cache-control')).toBeNull()
})

test('notFound is a plain-text 404', async () => {
  const res = notFound()
  expect(res.status).toBe(404)
  expect(await res.text()).toBe('Not Found')
})
