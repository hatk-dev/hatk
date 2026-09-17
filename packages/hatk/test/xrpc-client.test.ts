import { afterEach, expect, test, vi } from 'vitest'
import { createClient } from '../src/xrpc-client.ts'

// The client is what apps built on hatk ship to browsers, so the exact URL
// and request shape matter: a query must be a GET with params in the query
// string, a procedure a POST with a JSON body, and an XRPC error body's
// `error` field must surface as the thrown message rather than a bare status.

type Schema = {
  'app.test.getThing': { params: { id: string; limit?: number }; output: { id: string } }
  'app.test.doThing': { input: { name: string }; output: { ok: boolean } }
  'app.test.noParams': { output: { n: number } }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('query issues a GET to /xrpc/<nsid> with params as a query string', async () => {
  const fetchFn = vi.fn(async () => jsonResponse({ id: 'x' }))
  const client = createClient<Schema>('https://api.test', { fetch: fetchFn as any })

  const out = await client.query('app.test.getThing', { id: 'x', limit: 5 })

  expect(out).toEqual({ id: 'x' })
  expect(fetchFn).toHaveBeenCalledTimes(1)
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit | undefined]
  expect(url).toBe('https://api.test/xrpc/app.test.getThing?id=x&limit=5')
  expect(init).toBeUndefined()
})

test('query omits undefined params and the ? when nothing is left', async () => {
  const fetchFn = vi.fn(async () => jsonResponse({ n: 1 }))
  const client = createClient<Schema>('https://api.test', { fetch: fetchFn as any })

  await client.query('app.test.getThing', { id: 'x', limit: undefined })
  await client.query('app.test.noParams')
  await client.query('app.test.noParams', { only: undefined } as any)

  const urls = fetchFn.mock.calls.map((c: any[]) => c[0])
  expect(urls).toEqual([
    'https://api.test/xrpc/app.test.getThing?id=x',
    'https://api.test/xrpc/app.test.noParams',
    'https://api.test/xrpc/app.test.noParams',
  ])
})

test('query URL-encodes param values', async () => {
  const fetchFn = vi.fn(async () => jsonResponse({}))
  const client = createClient<Schema>('https://api.test', { fetch: fetchFn as any })
  await client.query('app.test.getThing', { id: 'at://did:plc:a/b c&d' })
  expect((fetchFn.mock.calls as unknown[][])[0][0]).toBe(
    'https://api.test/xrpc/app.test.getThing?id=at%3A%2F%2Fdid%3Aplc%3Aa%2Fb+c%26d',
  )
})

test('call POSTs a JSON body with the content type set', async () => {
  const fetchFn = vi.fn(async () => jsonResponse({ ok: true }))
  const client = createClient<Schema>('https://api.test', { fetch: fetchFn as any })

  const out = await client.call('app.test.doThing', { name: 'n' })

  expect(out).toEqual({ ok: true })
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.test/xrpc/app.test.doThing')
  expect(init.method).toBe('POST')
  expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
  expect(init.body).toBe(JSON.stringify({ name: 'n' }))
})

test('call without input sends no body and no content type', async () => {
  const fetchFn = vi.fn(async () => jsonResponse({ ok: true }))
  const client = createClient<Schema>('https://api.test', { fetch: fetchFn as any })

  await client.call('app.test.doThing', undefined as any, { id: 'q' } as any)

  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.test/xrpc/app.test.doThing?id=q')
  expect(init.headers).toEqual({})
  expect(init.body).toBeUndefined()
})

test('upload POSTs raw bytes with the caller-supplied content type', async () => {
  const fetchFn = vi.fn(async () => jsonResponse({ blob: 'ref' }))
  const client = createClient<Schema>('https://api.test', { fetch: fetchFn as any })
  const data = new Uint8Array([1, 2, 3]).buffer

  const out = await client.upload('app.test.doThing', data, 'image/png')

  expect(out).toEqual({ blob: 'ref' })
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.test/xrpc/app.test.doThing')
  expect(init.method).toBe('POST')
  expect(init.headers).toEqual({ 'Content-Type': 'image/png' })
  expect(init.body).toBe(data)
})

test('an XRPC error body surfaces its error field as the thrown message', async () => {
  const fetchFn = vi.fn(async () => jsonResponse({ error: 'InvalidRequest', message: 'bad' }, 400))
  const client = createClient<Schema>('https://api.test', { fetch: fetchFn as any })

  await expect(client.query('app.test.getThing', { id: 'x' })).rejects.toThrow('InvalidRequest')
  await expect(client.call('app.test.doThing', { name: 'n' })).rejects.toThrow('InvalidRequest')
  await expect(client.upload('app.test.doThing', new Blob(['x']), 'text/plain')).rejects.toThrow('InvalidRequest')
})

test('a non-JSON error response falls back to the nsid and status code', async () => {
  // A proxy 502 page is HTML; the client must not throw a JSON parse error instead
  const fetchFn = vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 }))
  const client = createClient<Schema>('https://api.test', { fetch: fetchFn as any })

  await expect(client.query('app.test.getThing', { id: 'x' })).rejects.toThrow('XRPC app.test.getThing: 502')
  await expect(client.call('app.test.doThing', { name: 'n' })).rejects.toThrow('XRPC app.test.doThing: 502')
  await expect(client.upload('app.test.doThing', new Blob(['x']), 'text/plain')).rejects.toThrow(
    'XRPC app.test.doThing: 502',
  )
})

test('falls back to the global fetch when none is supplied', async () => {
  const globalFetch = vi.fn(async () => jsonResponse({ n: 2 }))
  vi.stubGlobal('fetch', globalFetch)

  const client = createClient<Schema>('https://api.test')
  expect(await client.query('app.test.noParams')).toEqual({ n: 2 })
  expect(globalFetch).toHaveBeenCalledWith('https://api.test/xrpc/app.test.noParams')
})
