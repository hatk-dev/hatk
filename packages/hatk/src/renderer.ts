import { log } from './logger.ts'

export interface SSRManifest {
  getPreloadTags(url: string): string
}

export interface RenderResult {
  html: string
  head?: string
}

export type RendererHandler = (request: Request, manifest: SSRManifest) => Promise<RenderResult>

let renderer: RendererHandler | null = null
let ssrManifest: SSRManifest | null = null

export function defineRenderer(handler: RendererHandler) {
  return { __type: 'renderer' as const, handler }
}

export function registerRenderer(handler: RendererHandler): void {
  renderer = handler
  log('[renderer] SSR renderer registered')
}

export function setSSRManifest(manifest: SSRManifest): void {
  ssrManifest = manifest
}

export function getRenderer(): RendererHandler | null {
  return renderer
}

export function getSSRManifest(): SSRManifest | null {
  return ssrManifest
}

/**
 * Render an HTML page by calling the user's renderer and assembling the result
 * into the index.html template.
 *
 * @param template - The index.html content (with <!--ssr-outlet--> placeholder)
 * @param request - The incoming Request
 * @param ogMeta - Optional OG meta tags to inject
 * @returns Assembled HTML string, or null if no renderer is registered
 */
export async function renderPage(
  template: string,
  request: Request,
  ogMeta?: string | null,
): Promise<string | null> {
  if (!renderer) return null

  const manifest = ssrManifest || { getPreloadTags: () => '' }
  const result = await renderer(request, manifest)

  let html = template

  // Inject SSR head tags (preloads, styles)
  if (result.head) {
    html = html.replace('</head>', `${result.head}\n</head>`)
  }

  // Inject OG meta tags
  if (ogMeta) {
    html = html.replace('</head>', `${ogMeta}\n</head>`)
  }

  // Inject rendered HTML into the outlet
  html = html.replace('<!--ssr-outlet-->', result.html)

  return html
}
