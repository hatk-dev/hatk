import { resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { log } from './logger.ts'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import {
  querySQL,
  runSQL,
  packCursor,
  unpackCursor,
  isTakendownDid,
  filterTakendownDids,
  searchRecords,
  findUriByFields,
  lookupByFieldBatch,
  countByFieldBatch,
  queryLabelsForUris,
} from './db.ts'
import { resolveRecords } from './hydrate.ts'
import { blobUrl } from './xrpc.ts'
import type { XrpcContext } from './xrpc.ts'

/** Virtual DOM node for satori rendering */
export interface SatoriNode {
  type: string
  props: {
    style?: Record<string, any>
    children?: (SatoriNode | string)[] | string
    src?: string
    width?: number
    height?: number
    [key: string]: any
  }
}

/** Context passed to opengraph generate() functions */
export interface OpengraphContext extends XrpcContext {
  fetchImage: (url: string) => Promise<string | null>
}

/** Return type for opengraph generate() functions */
export interface OpengraphResult {
  element: SatoriNode
  options?: { width?: number; height?: number; fonts?: any[] }
  meta?: { title?: string; description?: string }
}

interface OgHandler {
  name: string
  path: string
  pattern: RegExp
  paramNames: string[]
  execute: (params: Record<string, string>) => Promise<{ svg: string; meta?: { title?: string; description?: string } }>
}

interface PageRoute {
  ogPath: string
  pattern: RegExp
  paramNames: string[]
  name: string
}

const handlers: OgHandler[] = []
const pageRoutes: PageRoute[] = []
let defaultFont: { name: string; data: ArrayBuffer; weight: number; style: string } | null = null

const cache = new Map<string, { png: Buffer; meta?: { title?: string; description?: string }; expires: number }>()
const CACHE_TTL = 5 * 60 * 1000
const CACHE_MAX = 200

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const re = path.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  return { pattern: new RegExp(`^${re}$`), paramNames }
}

export async function initOpengraph(ogDir: string): Promise<void> {
  // Load default font
  try {
    const fontPath = resolve(import.meta.dirname, '..', 'fonts', 'Inter-Regular.woff')
    const fontData = readFileSync(fontPath)
    defaultFont = { name: 'Inter', data: fontData.buffer as ArrayBuffer, weight: 400, style: 'normal' }
    log('[opengraph] loaded default font: Inter')
  } catch {
    console.warn('[opengraph] no default font found at fonts/Inter-Regular.woff — scripts must provide fonts')
  }

  let files: string[]
  try {
    files = readdirSync(ogDir)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('_'))
      .sort()
  } catch {
    return
  }

  for (const file of files) {
    const name = file.replace(/\.(ts|js)$/, '')
    const scriptPath = resolve(ogDir, file)
    const mod = await import(scriptPath)
    const handler = mod.default

    if (!handler.path) {
      console.warn(`[opengraph] ${file} missing 'path' export, skipping`)
      continue
    }

    const { pattern, paramNames } = compilePath(handler.path)

    handlers.push({
      name,
      path: handler.path,
      pattern,
      paramNames,
      execute: async (params) => {
        const ctx: XrpcContext = {
          db: { query: querySQL, run: runSQL },
          params,
          input: {},
          limit: 1,
          viewer: null,
          packCursor,
          unpackCursor,
          isTakendown: isTakendownDid,
          filterTakendownDids,
          search: searchRecords,
          resolve: resolveRecords as any,
          lookup: async (collection, field, values) => {
            if (values.length === 0) return new Map()
            const unique = [...new Set(values.filter(Boolean))]
            return lookupByFieldBatch(collection, field, unique) as any
          },
          count: async (collection, field, values) => {
            if (values.length === 0) return new Map()
            const unique = [...new Set(values.filter(Boolean))]
            return countByFieldBatch(collection, field, unique)
          },
          exists: async (collection, filters) => {
            const conditions = Object.entries(filters).map(([field, value]) => ({ field, value }))
            const uri = await findUriByFields(collection, conditions)
            return uri !== null
          },
          labels: queryLabelsForUris,
          blobUrl,
        }
        ;(ctx as any).fetchImage = async (url: string): Promise<string | null> => {
          try {
            const resp = await fetch(url, { redirect: 'follow' })
            if (!resp.ok) return null
            const buf = Buffer.from(await resp.arrayBuffer())
            const contentType = resp.headers.get('content-type') || 'image/jpeg'
            return `data:${contentType};base64,${buf.toString('base64')}`
          } catch {
            return null
          }
        }
        const result = await handler.generate(ctx)
        const element = result.element
        const options = {
          width: 1200,
          height: 630,
          ...result.options,
          fonts: [...(defaultFont ? [defaultFont] : []), ...(result.options?.fonts || [])],
        }
        const svg = await satori(element, options)
        return { svg, meta: result.meta }
      },
    })
    log(`[opengraph] discovered: ${name} → ${handler.path}`)

    const pagePath = handler.path.replace(/^\/og/, '')
    if (pagePath !== handler.path) {
      const compiled = compilePath(pagePath)
      pageRoutes.push({ ogPath: handler.path, pattern: compiled.pattern, paramNames: compiled.paramNames, name })
    }
  }
}

export async function handleOpengraphRequest(pathname: string): Promise<Buffer | null> {
  const cached = cache.get(pathname)
  if (cached && cached.expires > Date.now()) return cached.png

  for (const handler of handlers) {
    const match = pathname.match(handler.pattern)
    if (!match) continue

    const params: Record<string, string> = {}
    handler.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1])
    })

    try {
      const { svg, meta } = await handler.execute(params)
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng()

      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest) cache.delete(oldest)
      }
      cache.set(pathname, { png, meta, expires: Date.now() + CACHE_TTL })

      return png
    } catch (err: any) {
      console.error(`[opengraph] error in ${handler.name}:`, err.message)
      return null
    }
  }
  return null
}

export function buildOgMeta(pathname: string, origin: string): string | null {
  for (const route of pageRoutes) {
    const match = pathname.match(route.pattern)
    if (!match) continue

    let ogImagePath = route.ogPath
    for (let i = 0; i < route.paramNames.length; i++) {
      ogImagePath = ogImagePath.replace(`:${route.paramNames[i]}`, match[i + 1])
    }

    const params: Record<string, string> = {}
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1])
    })

    const cached = cache.get(ogImagePath)
    const cachedMeta = cached && cached.expires > Date.now() ? cached.meta : undefined

    const title = cachedMeta?.title || Object.values(params).join(' \u00b7 ')
    const description = cachedMeta?.description || ''

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    const imageUrl = `${origin}${ogImagePath}`
    const pageUrl = `${origin}${pathname}`

    const tags = [
      `<meta property="og:title" content="${esc(title)}">`,
      ...(description ? [`<meta property="og:description" content="${esc(description)}">`] : []),
      `<meta property="og:image" content="${esc(imageUrl)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:url" content="${esc(pageUrl)}">`,
      `<meta property="og:type" content="website">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${esc(title)}">`,
      ...(description ? [`<meta name="twitter:description" content="${esc(description)}">`] : []),
      `<meta name="twitter:image" content="${esc(imageUrl)}">`,
    ]
    return tags.join('\n    ')
  }
  return null
}
