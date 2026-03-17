import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'

/**
 * Convert a Node.js IncomingMessage to a Web Standard Request.
 */
export function toRequest(req: IncomingMessage, base: string): Request {
  const url = new URL(req.url!, base)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v)
      } else {
        headers.set(key, value)
      }
    }
  }

  const init: RequestInit & { duplex?: string } = {
    method: req.method,
    headers,
  }

  // GET and HEAD requests cannot have a body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // @ts-expect-error — Node.js streams are valid body sources
    init.body = req
    init.duplex = 'half'
  }

  return new Request(url.href, init as RequestInit)
}

/**
 * Pipe a Web Standard Response back to a Node.js ServerResponse.
 */
export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const rawHeaders: string[] = []
  response.headers.forEach((value, name) => {
    rawHeaders.push(name, value)
  })
  res.writeHead(response.status, rawHeaders)

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } finally {
    reader.releaseLock()
    res.end()
  }
}

/** Routes handled by hatk — everything else can fall through to a framework handler. */
export const HATK_ROUTES = [
  '/xrpc/',
  '/oauth/',
  '/oauth-client-metadata.json',
  '/.well-known/',
  '/og/',
  '/admin',
  '/repos',
  '/info/',
  '/_health',
  '/robots.txt',
  '/auth/logout',
  '/__dev/',
]

export function isHatkRoute(pathname: string): boolean {
  return HATK_ROUTES.some((r) => pathname.startsWith(r) || pathname === r)
}

/**
 * Create a Node.js HTTP server from a Web Standard fetch handler.
 * If a fallback Node middleware is provided, non-hatk routes are sent to it
 * (e.g. SvelteKit's handler from build/handler.js).
 */
export function serve(
  handler: (request: Request) => Promise<Response>,
  port: number,
  base?: string,
  fallback?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
) {
  const origin = base || `http://localhost:${port}`
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin)

      // If we have a fallback (e.g. SvelteKit) and this isn't a hatk route, skip hatk
      if (fallback && !isHatkRoute(url.pathname)) {
        fallback(req, res, () => {
          res.writeHead(404)
          res.end('Not found')
        })
        return
      }

      const request = toRequest(req, origin)
      const response = await handler(request)
      await sendResponse(res, response)
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
      }
      res.end(JSON.stringify({ error: err.message }))
    }
  })
  server.listen(port)
  return server
}
