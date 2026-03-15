import { gzipSync } from 'node:zlib'
import { normalizeValue } from './database/db.ts'

/**
 * Create a JSON Response with optional gzip compression.
 * Mirrors the old jsonResponse/sendJson behavior.
 */
export function json(data: unknown, status = 200, acceptEncoding?: string | null): Response {
  const body = Buffer.from(JSON.stringify(data, (_, v) => normalizeValue(v)))

  if (body.length > 1024 && acceptEncoding && /\bgzip\b/.test(acceptEncoding)) {
    const compressed = gzipSync(body)
    return new Response(compressed, {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
        ...(status === 200 ? { 'Cache-Control': 'no-store' } : {}),
      },
    })
  }

  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(status === 200 ? { 'Cache-Control': 'no-store' } : {}),
    },
  })
}

/** Create a JSON error Response. */
export function jsonError(status: number, message: string, acceptEncoding?: string | null): Response {
  return json({ error: message }, status, acceptEncoding)
}

/** CORS preflight Response. */
export function cors(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  })
}

/** Add CORS headers to an existing Response. */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Headers', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Create a static file Response with correct MIME type. */
export function file(content: Buffer | Uint8Array, contentType: string, cacheControl?: string): Response {
  return new Response(Buffer.from(content), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
    },
  })
}

/** 404 Not Found. */
export function notFound(): Response {
  return new Response('Not Found', { status: 404 })
}
