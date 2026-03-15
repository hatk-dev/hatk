import { createRunnableDevEnvironment, type Plugin, type ViteDevServer, type HotUpdateOptions } from 'vite'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { isHatkRoute } from './adapter.ts'

/** Boot the local PDS if a docker-compose.yml exists. */
async function ensurePds(): Promise<void> {
  if (!existsSync(resolve('docker-compose.yml'))) return
  try {
    const res = await fetch('http://localhost:2583/xrpc/_health')
    if (res.ok) return
  } catch {}
  console.log('[hatk] Starting PDS...')
  execSync('docker compose up -d', { stdio: 'inherit', cwd: process.cwd() })
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://localhost:2583/xrpc/_health')
      if (res.ok) {
        console.log('[hatk] PDS ready')
        return
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.error('[hatk] PDS failed to start')
}

/** Run seed file if it exists. */
function runSeed(): void {
  const seedFile = resolve('seeds/seed.ts')
  if (!existsSync(seedFile)) return
  try {
    execSync(`npx tsx ${seedFile}`, { stdio: 'inherit', cwd: process.cwd() })
  } catch {}
}

/** Walk all loaded modules in the module graphs to collect CSS URLs for SSR. */
function collectAllCss(server: ViteDevServer): string {
  const cssUrls = new Set<string>()

  for (const envName of ['hatk', 'client']) {
    const env = server.environments[envName]
    if (!env?.moduleGraph) continue
    // TODO: uses internal Vite module graph API — may break across Vite minor versions
    for (const mod of (env.moduleGraph as any).idToModuleMap?.values?.() ?? []) {
      const url = mod.url || ''
      if (/\.(css|scss|less|styl|stylus|pcss|postcss)(\?|$)/.test(url)) {
        cssUrls.add(url)
      }
      if (url.includes('type=style')) {
        cssUrls.add(url)
      }
    }
  }

  if (cssUrls.size === 0) return ''
  return Array.from(cssUrls)
    .map((url) => `<link rel="stylesheet" href="${url}">`)
    .join('\n')
}

export function hatk(opts?: { port?: number }): Plugin {
  const devPort = opts?.port ?? 3000
  let handler: ((request: Request) => Promise<Response>) | null = null
  let ssrRenderPage: ((template: string, request: Request) => Promise<string | null>) | null = null
  let ssrGetRenderer: (() => any) | null = null
  let reloadServer: (() => Promise<void>) | null = null
  let reloadTimer: ReturnType<typeof setTimeout> | null = null

  return {
    name: 'vite-plugin-hatk',

    // Rewrite $hatk imports in source code so SSR module runners can resolve them.
    // vite-plus's fetchModule bypasses resolve.alias for bare imports.
    transform(code: string, id: string) {
      if (!code.includes('$hatk')) return
      const hatk = resolve('hatk.generated.ts')
      const hatkClient = resolve('hatk.generated.client.ts')
      return code
        .replace(/from\s+['"](\$hatk\/client)['"]/g, `from '${hatkClient}'`)
        .replace(/from\s+['"](\$hatk)['"]/g, `from '${hatk}'`)
    },

    config() {
      return {
        resolve: {
          alias: {
            '$hatk/client': resolve('hatk.generated.client.ts'),
            '$hatk': resolve('hatk.generated.ts'),
          },
        },
        environments: {
          hatk: {
            resolve: {
              conditions: ['svelte'],
              noExternal: ['svelte', '@tanstack/svelte-query'],
              external: true,
            },
            dev: {
              createEnvironment(name: string, config: any) {
                return createRunnableDevEnvironment(name, config)
              },
              optimizeDeps: {
                exclude: ['better-sqlite3', '@duckdb/node-api'],
              },
            },
            build: {
              outDir: 'dist/server',
              ssr: true,
              rollupOptions: {
                external: ['better-sqlite3', '@duckdb/node-api'],
              },
            },
          },
        },
        server: {
          host: '127.0.0.1',
          port: devPort,
          fs: {
            allow: ['.'],
          },
          watch: {
            ignored: ['**/db/**', '**/data/**'],
          },
        },
      }
    },

    async configureServer(server: ViteDevServer) {
      // Skip hatk server boot in test mode — tests manage their own context
      if (process.env.VITEST) return

      // Boot PDS and run seeds before starting
      await ensurePds()
      runSeed()

      const env = server.environments.hatk
      if (!env || !('runner' in env)) {
        console.error('[hatk] hatk environment not available — is Vite 8 with Environment API?')
        return
      }

      // Load the hatk boot module through the module runner
      const mainPath = resolve(import.meta.dirname!, 'dev-entry.js')
      const mod = await (env as any).runner.import(mainPath)
      handler = mod.handler
      ssrRenderPage = mod.renderPage
      ssrGetRenderer = mod.getRenderer
      reloadServer = mod.reloadServer

      // Expose the runner's callXrpc on globalThis so externalized modules can call XRPC handlers.
      // The runner has its own module instances with registered handlers; Node's instance is empty.
      ;(globalThis as any).__hatk_callXrpc = mod.callXrpc

      // Capture cookie parser and name for SSR viewer resolution
      const ssrParseSessionCookie: ((request: Request) => Promise<{ did: string } | null>) | null = mod.parseSessionCookie ?? null
      ;(globalThis as any).__hatk_parseSessionCookie = ssrParseSessionCookie
      ;(globalThis as any).__hatk_sessionCookieName = mod.getSessionCookieName?.() ?? '__hatk_session'

      if (ssrGetRenderer?.()) {
        console.log('[hatk] SSR ready')
      }

      // API routes — must run before Vite's static middleware
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = new URL(req.url!, `http://localhost:${devPort}`)

        if (!isHatkRoute(url.pathname) || !handler) {
          next()
          return
        }

        try {
          const { toRequest, sendResponse } = await import('./adapter.js')
          const request = toRequest(req, `http://localhost:${devPort}`)
          const response = await handler(request)
          if (response.status === 404) {
            next()
            return
          }
          await sendResponse(res, response)
        } catch (err: any) {
          console.error('[hatk]', err.message)
          next(err)
        }
      })

      // SSR middleware — returned function runs after htmlFallback but before indexHtmlMiddleware
      return () => {
        server.middlewares.use(async (req: any, res: any, next: any) => {
          if (!ssrGetRenderer?.()) {
            next()
            return
          }

          const accept = req.headers.accept || ''
          const url = req.originalUrl || req.url
          if (!accept.includes('text/html') || !url) {
            next()
            return
          }

          try {
            const { readFileSync } = await import('node:fs')
            const rawHtml = readFileSync(resolve('index.html'), 'utf-8')
            const template = await server.transformIndexHtml(url, rawHtml)

            const fullUrl = new URL(url, `http://localhost:${devPort}`)
            const headers: Record<string, string> = {}
            if (req.headers.cookie) headers.cookie = req.headers.cookie
            const request = new Request(fullUrl.href, { headers })

            // Resolve viewer from session cookie for SSR
            // TODO: globalThis.__hatk_viewer is not safe for concurrent SSR requests.
            // Replace with AsyncLocalStorage when callXrpc supports per-request context.
            let viewer: { did: string } | null = null
            if (ssrParseSessionCookie) {
              try {
                viewer = await ssrParseSessionCookie(request)
              } catch {}
            }
            ;(globalThis as any).__hatk_viewer = viewer

            let renderedHtml: string | null
            try {
              renderedHtml = await ssrRenderPage!(template, request)
            } finally {
              ;(globalThis as any).__hatk_viewer = null
            }

            // Inject viewer into HTML so client has it before OAuth initializes
            if (renderedHtml && viewer) {
              const script = `<script>globalThis.__hatk_viewer=${JSON.stringify(viewer)}</script>`
              renderedHtml = renderedHtml.replace('</head>', `${script}\n</head>`)
            }
            if (!renderedHtml) {
              next()
              return
            }

            // Collect CSS from all loaded modules to prevent FOUC
            const cssLinks = collectAllCss(server)
            let html = renderedHtml
            if (cssLinks) {
              html = html.replace('</head>', `${cssLinks}\n</head>`)
            }

            res.setHeader('Content-Type', 'text/html')
            res.end(html)
          } catch (err: any) {
            console.error('[hatk] SSR error:', err.message)
            next(err)
          }
        })
      }
    },

    // Handle HMR for server/ files in the hatk environment
    hotUpdate(this: { environment: any }, options: HotUpdateOptions) {
      if (options.file.includes('/server/') && reloadServer) {
        // Debounce: hotUpdate fires once per environment, only reload once
        if (!reloadTimer) {
          reloadTimer = setTimeout(() => {
            reloadTimer = null
            reloadServer!().then(() => {
              console.log('[hatk] Server handlers reloaded')
            }).catch((err: any) => {
              console.error('[hatk] Failed to reload server handlers:', err.message)
            })
          }, 50)
        }
      }
    },

    // Two-stage production build
    async buildApp(builder: any) {
      // Stage 1: Build client
      if (builder.environments.client) {
        await builder.build(builder.environments.client)
      }
      // Stage 2: Build hatk server (if environment exists)
      if (builder.environments.hatk) {
        await builder.build(builder.environments.hatk)
      }
    },
  }
}
