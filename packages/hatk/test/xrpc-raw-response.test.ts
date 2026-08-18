import { beforeAll, expect, test } from 'vitest'
import { createHandler } from '../src/server.ts'
import { registerCoreXrpcHandler } from '../src/xrpc.ts'
import { setupFixtureDatabase } from './fixture.ts'

// Not every XRPC method answers with JSON. com.atproto.sync.getBlob is the
// shape in the wild, and a permissioned space's getBlob is why this exists: the
// bytes cannot go through a CDN, so the app has to serve them itself. A handler
// returning a Response is passed through untouched; anything else is still
// serialized as JSON.

const handler = () => createHandler({ collections: [], publicDir: null, oauth: null, admins: [] })

const PIXEL = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

beforeAll(async () => {
  await setupFixtureDatabase()

  registerCoreXrpcHandler('xyz.test.getBytes', async () => {
    return new Response(PIXEL, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' },
    })
  })
  registerCoreXrpcHandler('xyz.test.getJson', async () => ({ hello: 'world' }))
})

test('a handler returning a Response is served as-is', async () => {
  const res = await handler()(new Request('http://localhost/xrpc/xyz.test.getBytes'))

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/png')
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(PIXEL)
})

test('CORS still applies to a passed-through Response', async () => {
  const res = await handler()(new Request('http://localhost/xrpc/xyz.test.getBytes'))

  expect(res.headers.get('access-control-allow-origin')).toBe('*')
})

test('an ordinary handler still answers with JSON', async () => {
  const res = await handler()(new Request('http://localhost/xrpc/xyz.test.getJson'))

  expect(res.headers.get('content-type')).toContain('application/json')
  expect(await res.json()).toEqual({ hello: 'world' })
})
