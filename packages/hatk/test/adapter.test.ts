import { afterAll, expect, test, vi } from 'vitest'
import { Readable } from 'node:stream'
import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { HATK_ROUTES, isHatkRoute, sendResponse, serve, toRequest } from '../src/adapter.ts'

// The adapter is the only place hatk touches Node's http module: everything
// above it speaks Web Standard Request/Response. These tests pin the
// translation in both directions and the route split that lets a framework
// (SvelteKit) own every path hatk does not.

/** A minimal IncomingMessage: a readable stream with the request fields attached. */
function incoming(opts: {
  method: string
  url: string
  headers?: Record<string, string | string[]>
  body?: string
}): IncomingMessage {
  const stream = Readable.from(opts.body ? [Buffer.from(opts.body)] : []) as unknown as IncomingMessage
  Object.assign(stream, { method: opts.method, url: opts.url, headers: opts.headers ?? {} })
  return stream
}

/** A ServerResponse stand-in that records what was written. */
function outgoing() {
  const chunks: Buffer[] = []
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: Uint8Array) => chunks.push(Buffer.from(chunk))),
    end: vi.fn(),
    headersSent: false,
  }
  return { res: res as unknown as ServerResponse, spies: res, body: () => Buffer.concat(chunks).toString() }
}

test('a GET is converted to a Request with its URL resolved against the base', () => {
  const req = toRequest(
    incoming({ method: 'GET', url: '/xrpc/x?a=1', headers: { host: 'h' } }),
    'http://localhost:3000',
  )
  expect(req.method).toBe('GET')
  expect(req.url).toBe('http://localhost:3000/xrpc/x?a=1')
  expect(req.headers.get('host')).toBe('h')
  expect(req.body).toBeNull()
})

test('a POST body is streamed through to the Request', async () => {
  const req = toRequest(
    incoming({ method: 'POST', url: '/x', headers: { 'content-type': 'application/json' }, body: '{"k":1}' }),
    'http://localhost',
  )
  expect(await req.json()).toEqual({ k: 1 })
})

test('repeated headers keep every value', () => {
  // Node represents multiple Set-Cookie (and similar) headers as an array;
  // collapsing them would drop cookies.
  const req = toRequest(
    incoming({ method: 'GET', url: '/', headers: { 'set-cookie': ['a=1', 'b=2'], 'x-empty': '' } }),
    'http://localhost',
  )
  expect(req.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  // Empty header values are dropped rather than sent as blanks.
  expect(req.headers.has('x-empty')).toBe(false)
})

test('a Response is written back with its status, headers and body chunks', async () => {
  const { res, spies, body } = outgoing()
  await sendResponse(res, new Response('hello', { status: 201, headers: { 'x-a': '1', 'x-b': '2' } }))

  expect(spies.writeHead).toHaveBeenCalledTimes(1)
  const [status, rawHeaders] = spies.writeHead.mock.calls[0]
  expect(status).toBe(201)
  // Raw header list, so duplicates could be preserved.
  expect(rawHeaders).toEqual(expect.arrayContaining(['x-a', '1', 'x-b', '2']))
  expect(body()).toBe('hello')
  expect(spies.end).toHaveBeenCalledTimes(1)
})

test('a body-less Response ends the socket without writing', async () => {
  const { res, spies } = outgoing()
  await sendResponse(res, new Response(null, { status: 304 }))
  expect(spies.writeHead).toHaveBeenCalledWith(304, [])
  expect(spies.write).not.toHaveBeenCalled()
  expect(spies.end).toHaveBeenCalledTimes(1)
})

test('hatk claims its own route prefixes and nothing else', () => {
  for (const route of HATK_ROUTES) expect(isHatkRoute(route)).toBe(true)
  expect(isHatkRoute('/xrpc/app.bsky.feed.getTimeline')).toBe(true)
  expect(isHatkRoute('/admin/info')).toBe(true)
  expect(isHatkRoute('/oauth-client-metadata.json')).toBe(true)
  expect(isHatkRoute('/_health')).toBe(true)
  // App pages stay with the framework.
  expect(isHatkRoute('/')).toBe(false)
  expect(isHatkRoute('/profile/alice')).toBe(false)
  expect(isHatkRoute('/about')).toBe(false)
})

// serve() has no seam below the socket, so these last tests bind to an
// ephemeral loopback port. Nothing leaves the machine.
const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
})

function loopback(server: Server, path: string, method = 'GET') {
  const { port } = server.address() as { port: number }
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
      })
      req.on('error', reject)
      req.end()
    },
  )
}

test('serve hands every request to the handler when there is no fallback', async () => {
  const seen: string[] = []
  const server = serve(async (req) => {
    seen.push(new URL(req.url).pathname)
    return new Response('ok', { status: 200, headers: { 'x-from': 'handler' } })
  }, 0)
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))

  const res = await loopback(server, '/anything')
  expect(res.status).toBe(200)
  expect(res.body).toBe('ok')
  expect(res.headers['x-from']).toBe('handler')
  expect(seen).toEqual(['/anything'])
})

test('with a fallback, non-hatk routes bypass the handler entirely', async () => {
  const handler = vi.fn(async () => new Response('hatk'))
  const fallback = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('framework')
  })
  const server = serve(handler, 0, undefined, fallback)
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))

  expect((await loopback(server, '/profile/alice')).body).toBe('framework')
  expect(handler).not.toHaveBeenCalled()

  expect((await loopback(server, '/_health')).body).toBe('hatk')
  expect(fallback).toHaveBeenCalledTimes(1)
})

test('the fallback can decline, which turns into a 404', async () => {
  const server = serve(
    async () => new Response('hatk'),
    0,
    undefined,
    (_req, _res, next) => next(),
  )
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))

  const res = await loopback(server, '/nope')
  expect(res.status).toBe(404)
  expect(res.body).toBe('Not found')
})

test('a handler that throws becomes a JSON 500 instead of a hung socket', async () => {
  const server = serve(async () => {
    throw new Error('boom')
  }, 0)
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))

  const res = await loopback(server, '/x')
  expect(res.status).toBe(500)
  expect(JSON.parse(res.body)).toEqual({ error: 'boom' })
})
