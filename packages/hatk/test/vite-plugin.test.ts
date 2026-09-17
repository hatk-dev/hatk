/**
 * A Vite plugin is a plain object of hooks, so every hook here is invoked
 * directly with hand-rolled fakes — no dev server, no PDS, no docker. The
 * hooks that matter are the ones that silently break an app when they
 * regress: `transform` (SSR module runners cannot resolve `$hatk` without
 * it), `config` (native deps must stay out of the client bundle), and the
 * middleware stack `configureServer` installs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hatk } from '../src/vite-plugin.ts'

// configureServer boots a local PDS and runs seeds before handing control to
// Vite; neither may actually shell out here.
const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execSync: execSyncMock }))

let tmp: string
let originalCwd: string

beforeAll(() => {
  originalCwd = process.cwd()
  tmp = mkdtempSync(join(tmpdir(), 'hatk-vite-'))
  // The plugin resolves $hatk aliases and the SSR template against cwd, so the
  // whole suite runs from a scratch project. Deliberately no docker-compose.yml
  // and no seeds/seed.ts: ensurePds and runSeed must be no-ops.
  writeFileSync(join(tmp, 'index.html'), '<html><head></head><body><!--app--></body></html>')
  process.chdir(tmp)
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(tmp, { recursive: true, force: true })
})

// --- fakes ---------------------------------------------------------------

type Middleware = (req: any, res: any, next: (err?: any) => void) => void | Promise<void>

/** The subset of the boot module `configureServer` pulls off the runner import. */
function makeBootModule(overrides: Record<string, unknown> = {}) {
  return {
    handler: vi.fn(async (_request: Request) => new Response('handled', { status: 200 })),
    renderPage: vi.fn(async (_template: string, _request: Request) => '<html><head></head><body>ssr</body></html>'),
    getRenderer: vi.fn(() => ({ name: 'svelte' })),
    reloadServer: vi.fn(async () => {}),
    callXrpc: vi.fn(),
    parseSessionCookie: vi.fn(async (_request: Request) => ({ did: 'did:plc:alice' })),
    getSessionCookieName: vi.fn(() => '__hatk_session'),
    ...overrides,
  }
}

function makeServer(opts: { boot?: any; withHatkEnv?: boolean; cssIds?: string[] } = {}) {
  const middlewares: Middleware[] = []
  const cssModules = new Map((opts.cssIds ?? []).map((url) => [url, { url }]))
  const server: any = {
    middlewares: { use: (fn: Middleware) => middlewares.push(fn) },
    environments: {
      client: { moduleGraph: { idToModuleMap: new Map() } },
    },
    transformIndexHtml: vi.fn(async (_url: string, html: string) => html.replace('<!--app-->', '<!--transformed-->')),
  }
  if (opts.withHatkEnv !== false) {
    server.environments.hatk = {
      runner: { import: vi.fn(async (_path: string) => opts.boot ?? makeBootModule()) },
      moduleGraph: { idToModuleMap: cssModules },
    }
  }
  return { server, middlewares }
}

/** Minimal duck-typed IncomingMessage. */
function makeReq(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return { url, originalUrl: url, method, headers }
}

/** Minimal duck-typed ServerResponse that records what was written. */
function makeRes() {
  const chunks: string[] = []
  return {
    statusCode: 0,
    rawHeaders: [] as string[],
    headers: {} as Record<string, string>,
    ended: false,
    body: () => chunks.join(''),
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
    writeHead(status: number, raw: string[] = []) {
      this.statusCode = status
      this.rawHeaders = raw
    },
    write(chunk: any) {
      chunks.push(Buffer.from(chunk).toString())
    },
    end(chunk?: any) {
      if (chunk) chunks.push(Buffer.from(chunk).toString())
      this.ended = true
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  execSyncMock.mockReset()
  rmSync(join(tmp, 'docker-compose.yml'), { force: true })
  rmSync(join(tmp, 'seeds'), { recursive: true, force: true })
  delete (globalThis as any).__hatk_callXrpc
  delete (globalThis as any).__hatk_parseSessionCookie
  delete (globalThis as any).__hatk_sessionCookieName
  delete (globalThis as any).__hatk_viewer
})

// --- transform -----------------------------------------------------------

describe('transform', () => {
  const transform = (code: string) => (hatk() as any).transform(code, '/app/src/routes/page.svelte')

  test('leaves code without a $hatk import untouched', () => {
    // Returning undefined lets Vite skip the sourcemap/re-parse cost entirely.
    expect(transform(`import { foo } from './foo.ts'`)).toBeUndefined()
  })

  test('rewrites a bare $hatk import to the generated file path', () => {
    const out = transform(`import { callXrpc } from '$hatk'`)
    expect(out).toBe(`import { callXrpc } from '${resolve('hatk.generated.ts')}'`)
  })

  test('rewrites $hatk/client to the client-safe generated file, not <path>/client', () => {
    // $hatk is a prefix of $hatk/client, so the order of the two replacements is
    // load-bearing: a naive $hatk-first pass produces '<abs>/hatk.generated.ts/client'.
    const out = transform(`import { login } from '$hatk/client'`)
    expect(out).toBe(`import { login } from '${resolve('hatk.generated.client.ts')}'`)
    expect(out).not.toContain('hatk.generated.ts/client')
  })

  test('rewrites both specifiers in one file and tolerates double quotes', () => {
    const out = transform(`import a from "$hatk"\nimport b from "$hatk/client"\n`)
    expect(out).toContain(`import a from '${resolve('hatk.generated.ts')}'`)
    expect(out).toContain(`import b from '${resolve('hatk.generated.client.ts')}'`)
  })
})

// --- config --------------------------------------------------------------

describe('config', () => {
  test('defaults the dev server to port 3000 on loopback', () => {
    const cfg: any = (hatk() as any).config()
    expect(cfg.server.port).toBe(3000)
    // Binding 127.0.0.1 rather than 0.0.0.0 keeps a dev PDS off the LAN.
    expect(cfg.server.host).toBe('127.0.0.1')
  })

  test('honours an explicit port', () => {
    expect(((hatk({ port: 5174 }) as any).config() as any).server.port).toBe(5174)
  })

  test('aliases $hatk and $hatk/client to the generated files', () => {
    const alias = ((hatk() as any).config() as any).resolve.alias
    expect(alias.$hatk).toBe(resolve('hatk.generated.ts'))
    expect(alias['$hatk/client']).toBe(resolve('hatk.generated.client.ts'))
  })

  test('keeps native database drivers out of both dev optimization and the server bundle', () => {
    // better-sqlite3 and duckdb are native addons: prebundling or rolling them
    // up produces a build that only fails at runtime on the server.
    const env = ((hatk() as any).config() as any).environments.hatk
    expect(env.dev.optimizeDeps.exclude).toEqual(['better-sqlite3', '@duckdb/node-api'])
    expect(env.build.rollupOptions.external).toEqual(['better-sqlite3', '@duckdb/node-api'])
    expect(env.build.ssr).toBe(true)
  })

  test('marks the hatk environment external but inlines svelte for SSR', () => {
    const env = ((hatk() as any).config() as any).environments.hatk
    expect(env.resolve.external).toBe(true)
    expect(env.resolve.noExternal).toContain('svelte')
    expect(env.resolve.conditions).toContain('svelte')
  })

  test('ignores db/ and data/ so database writes do not trigger HMR', () => {
    const cfg: any = (hatk() as any).config()
    expect(cfg.server.watch.ignored).toEqual(['**/db/**', '**/data/**'])
  })
})

// --- configureServer -----------------------------------------------------

describe('configureServer', () => {
  test('is a no-op under VITEST so tests own their hatk context', async () => {
    vi.stubEnv('VITEST', 'true')
    const { server, middlewares } = makeServer()
    await expect((hatk() as any).configureServer(server)).resolves.toBeUndefined()
    expect(middlewares).toHaveLength(0)
  })

  test('reports a missing hatk environment instead of throwing', async () => {
    vi.stubEnv('VITEST', undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { server, middlewares } = makeServer({ withHatkEnv: false })

    await (hatk() as any).configureServer(server)

    expect(error.mock.calls[0][0]).toContain('hatk environment not available')
    expect(middlewares).toHaveLength(0)
  })

  test('publishes the XRPC and session bridges on globalThis', async () => {
    vi.stubEnv('VITEST', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const boot = makeBootModule()
    const { server } = makeServer({ boot })

    await (hatk() as any).configureServer(server)

    // Externalized SSR modules have their own module instances with no
    // registered handlers, so the runner's callXrpc has to be reachable globally.
    expect((globalThis as any).__hatk_callXrpc).toBe(boot.callXrpc)
    expect((globalThis as any).__hatk_parseSessionCookie).toBe(boot.parseSessionCookie)
    expect((globalThis as any).__hatk_sessionCookieName).toBe('__hatk_session')
  })

  test('falls back to a default cookie name when the boot module exposes none', async () => {
    vi.stubEnv('VITEST', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const boot = makeBootModule({ getSessionCookieName: undefined, parseSessionCookie: undefined })
    const { server } = makeServer({ boot })

    await (hatk() as any).configureServer(server)

    expect((globalThis as any).__hatk_sessionCookieName).toBe('__hatk_session')
    expect((globalThis as any).__hatk_parseSessionCookie).toBeNull()
  })
})

// --- PDS / seed bootstrap ------------------------------------------------

describe('dev bootstrap', () => {
  async function boot() {
    vi.stubEnv('VITEST', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { server } = makeServer()
    await (hatk() as any).configureServer(server)
  }

  test('does not touch docker when the project has no compose file', async () => {
    await boot()
    expect(execSyncMock).not.toHaveBeenCalledWith('docker compose up -d', expect.anything())
  })

  test('leaves an already-healthy PDS alone', async () => {
    writeFileSync(join(tmp, 'docker-compose.yml'), 'services: {}')
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await boot()

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:2583/xrpc/_health')
    expect(execSyncMock).not.toHaveBeenCalledWith('docker compose up -d', expect.anything())
  })

  test('starts the PDS and waits for it to answer', async () => {
    writeFileSync(join(tmp, 'docker-compose.yml'), 'services: {}')
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        if (call === 1) throw new Error('ECONNREFUSED')
        return new Response('ok', { status: 200 })
      }),
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await boot()

    expect(execSyncMock).toHaveBeenCalledWith('docker compose up -d', expect.objectContaining({ stdio: 'inherit' }))
    expect(log.mock.calls.flat()).toContain('[hatk] PDS ready')
  })

  test('runs seeds/seed.ts through tsx when the project has one', async () => {
    mkdirSync(join(tmp, 'seeds'), { recursive: true })
    writeFileSync(join(tmp, 'seeds/seed.ts'), '// seed')
    await boot()

    expect(execSyncMock.mock.calls[0][0]).toMatch(/^npx tsx .*seeds\/seed\.ts$/)
  })

  test('survives a seed script that fails', async () => {
    // A broken seed should not stop the dev server from coming up.
    mkdirSync(join(tmp, 'seeds'), { recursive: true })
    writeFileSync(join(tmp, 'seeds/seed.ts'), '// seed')
    execSyncMock.mockImplementation(() => {
      throw new Error('seed exploded')
    })

    await expect(boot()).resolves.toBeUndefined()
  })
})

// --- API middleware ------------------------------------------------------

describe('the API middleware', () => {
  let apiMiddleware: Middleware
  let boot: ReturnType<typeof makeBootModule>

  beforeEach(async () => {
    vi.stubEnv('VITEST', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    boot = makeBootModule()
    const { server, middlewares } = makeServer({ boot })
    await (hatk() as any).configureServer(server)
    apiMiddleware = middlewares[0]
  })

  test('passes non-hatk routes straight through to Vite', async () => {
    const next = vi.fn()
    await apiMiddleware(makeReq('/about'), makeRes(), next)
    expect(next).toHaveBeenCalledWith()
    expect(boot.handler).not.toHaveBeenCalled()
  })

  test('serves a hatk route from the boot handler', async () => {
    const res = makeRes()
    const next = vi.fn()
    await apiMiddleware(makeReq('/xrpc/app.bsky.feed.getTimeline?limit=2'), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body()).toBe('handled')
    const request = boot.handler.mock.calls[0][0] as Request
    expect(new URL(request.url).pathname).toBe('/xrpc/app.bsky.feed.getTimeline')
    expect(new URL(request.url).searchParams.get('limit')).toBe('2')
  })

  test('falls through to Vite when the hatk handler 404s', async () => {
    // A 404 from hatk means "not my route" — static assets and the SPA
    // fallback still need their turn.
    boot.handler.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    const res = makeRes()
    const next = vi.fn()
    await apiMiddleware(makeReq('/xrpc/unknown.method'), res, next)

    expect(next).toHaveBeenCalledWith()
    expect(res.ended).toBe(false)
  })

  test('forwards a handler crash to Vite as an error rather than hanging the request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    boot.handler.mockRejectedValueOnce(new Error('boom'))
    const next = vi.fn()
    await apiMiddleware(makeReq('/xrpc/app.bsky.feed.getTimeline'), makeRes(), next)

    expect(error).toHaveBeenCalledWith('[hatk]', 'boom')
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })
})

// --- SSR middleware ------------------------------------------------------

describe('the SSR middleware', () => {
  async function setupSsr(opts: { boot?: any; cssIds?: string[] } = {}) {
    vi.stubEnv('VITEST', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const boot = opts.boot ?? makeBootModule()
    const { server, middlewares } = makeServer({ boot, cssIds: opts.cssIds })
    const post = await (hatk() as any).configureServer(server)
    // configureServer returns a thunk Vite calls after its own html middlewares.
    post()
    return { boot, server, ssr: middlewares[1] }
  }

  test('is registered only after the API middleware', async () => {
    const { ssr } = await setupSsr()
    expect(typeof ssr).toBe('function')
  })

  test('skips requests that do not accept HTML', async () => {
    const { ssr, boot } = await setupSsr()
    const next = vi.fn()
    await ssr(makeReq('/favicon.ico', { accept: 'image/*' }), makeRes(), next)
    expect(next).toHaveBeenCalledWith()
    expect(boot.renderPage).not.toHaveBeenCalled()
  })

  test('skips entirely when the app registered no renderer', async () => {
    // An API-only hatk app has no SSR renderer; every HTML request must fall
    // through to Vite's index.html rather than 500.
    const boot = makeBootModule({ getRenderer: vi.fn(() => null) })
    const { ssr } = await setupSsr({ boot })
    const next = vi.fn()
    await ssr(makeReq('/', { accept: 'text/html' }), makeRes(), next)
    expect(next).toHaveBeenCalledWith()
    expect(boot.renderPage).not.toHaveBeenCalled()
  })

  test('renders the transformed index.html and sends it as HTML', async () => {
    const { ssr, boot, server } = await setupSsr()
    const res = makeRes()
    const next = vi.fn()
    await ssr(makeReq('/feed', { accept: 'text/html' }), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(server.transformIndexHtml).toHaveBeenCalled()
    // renderPage gets Vite's transformed template, not the raw file.
    expect(boot.renderPage.mock.calls[0][0]).toContain('<!--transformed-->')
    expect(res.headers['Content-Type']).toBe('text/html')
    expect(res.body()).toContain('ssr')
  })

  test('forwards the request cookie so SSR can resolve the viewer', async () => {
    const { ssr, boot } = await setupSsr()
    await ssr(makeReq('/', { accept: 'text/html', cookie: '__hatk_session=abc' }), makeRes(), vi.fn())

    const request = boot.parseSessionCookie.mock.calls[0][0] as Request
    expect(request.headers.get('cookie')).toBe('__hatk_session=abc')
  })

  test('inlines the resolved viewer so the client has it before OAuth boots', async () => {
    const { ssr } = await setupSsr()
    const res = makeRes()
    await ssr(makeReq('/', { accept: 'text/html' }), res, vi.fn())

    expect(res.body()).toContain(`globalThis.__hatk_viewer={"did":"did:plc:alice"}`)
    // The global must not leak past the request that set it.
    expect((globalThis as any).__hatk_viewer).toBeNull()
  })

  test('still renders when the session cookie cannot be parsed', async () => {
    // A stale or tampered cookie must degrade to logged-out, not to a 500.
    const boot = makeBootModule({
      parseSessionCookie: vi.fn(async () => {
        throw new Error('bad cookie')
      }),
    })
    const { ssr } = await setupSsr({ boot })
    const res = makeRes()
    await ssr(makeReq('/', { accept: 'text/html' }), res, vi.fn())

    expect(res.body()).toContain('ssr')
    expect(res.body()).not.toContain('__hatk_viewer=')
  })

  test('clears the viewer global even when rendering throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boot = makeBootModule({
      renderPage: vi.fn(async () => {
        throw new Error('render failed')
      }),
    })
    const { ssr } = await setupSsr({ boot })
    const next = vi.fn()
    await ssr(makeReq('/', { accept: 'text/html' }), makeRes(), next)

    expect((globalThis as any).__hatk_viewer).toBeNull()
    expect(error.mock.calls[0][0]).toBe('[hatk] SSR error:')
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  test('falls through when the renderer declines to render the route', async () => {
    const boot = makeBootModule({ renderPage: vi.fn(async () => null) })
    const { ssr } = await setupSsr({ boot })
    const res = makeRes()
    const next = vi.fn()
    await ssr(makeReq('/not-a-page', { accept: 'text/html' }), res, next)

    expect(next).toHaveBeenCalledWith()
    expect(res.ended).toBe(false)
  })

  test('injects stylesheets from every loaded module to prevent FOUC', async () => {
    // Without this the first SSR paint is unstyled until the client bundle
    // loads, which is the whole reason the plugin walks the module graph.
    const { ssr } = await setupSsr({
      cssIds: ['/src/app.css', '/src/theme.scss', '/src/Page.svelte?vue&type=style', '/src/main.ts'],
    })
    const res = makeRes()
    await ssr(makeReq('/', { accept: 'text/html' }), res, vi.fn())

    const html = res.body()
    expect(html).toContain('<link rel="stylesheet" href="/src/app.css">')
    expect(html).toContain('<link rel="stylesheet" href="/src/theme.scss">')
    expect(html).toContain('<link rel="stylesheet" href="/src/Page.svelte?vue&type=style">')
    // A plain module is not a stylesheet.
    expect(html).not.toContain('href="/src/main.ts"')
  })

  test('emits no stylesheet links when nothing CSS-ish is loaded', async () => {
    const { ssr } = await setupSsr({ cssIds: ['/src/main.ts'] })
    const res = makeRes()
    await ssr(makeReq('/', { accept: 'text/html' }), res, vi.fn())
    expect(res.body()).not.toContain('<link rel="stylesheet"')
  })
})

// --- hotUpdate -----------------------------------------------------------

describe('hotUpdate', () => {
  async function configured() {
    vi.stubEnv('VITEST', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const boot = makeBootModule()
    const { server } = makeServer({ boot })
    const plugin: any = hatk()
    await plugin.configureServer(server)
    return { plugin, boot }
  }

  test('ignores edits outside server/', async () => {
    const { plugin, boot } = await configured()
    plugin.hotUpdate({ file: '/app/src/routes/+page.svelte' })
    await new Promise((r) => setTimeout(r, 80))
    expect(boot.reloadServer).not.toHaveBeenCalled()
  })

  test('reloads server handlers once per burst of edits', async () => {
    // hotUpdate fires once per Vite environment, so an unguarded reload would
    // restart the hatk server twice for a single file save.
    const { plugin, boot } = await configured()
    plugin.hotUpdate({ file: '/app/server/feed.ts' })
    plugin.hotUpdate({ file: '/app/server/feed.ts' })
    await new Promise((r) => setTimeout(r, 120))
    expect(boot.reloadServer).toHaveBeenCalledTimes(1)
  })

  test('reports a failed reload instead of leaving an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boot = makeBootModule({
      reloadServer: vi.fn(async () => {
        throw new Error('reload blew up')
      }),
    })
    vi.stubEnv('VITEST', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { server } = makeServer({ boot })
    const plugin: any = hatk()
    await plugin.configureServer(server)

    plugin.hotUpdate({ file: '/app/server/xrpc/getThing.ts' })
    await new Promise((r) => setTimeout(r, 120))

    expect(error).toHaveBeenCalledWith('[hatk] Failed to reload server handlers:', 'reload blew up')
  })

  test('does nothing before configureServer has wired up a reload function', async () => {
    const plugin: any = hatk()
    expect(() => plugin.hotUpdate({ file: '/app/server/feed.ts' })).not.toThrow()
  })
})

// --- buildApp ------------------------------------------------------------

describe('buildApp', () => {
  test('builds the client before the hatk server', async () => {
    // Stage order matters: the server build reads the client manifest.
    const order: string[] = []
    const builder = {
      environments: { client: { name: 'client' }, hatk: { name: 'hatk' } },
      build: vi.fn(async (env: any) => {
        order.push(env.name)
      }),
    }
    await (hatk() as any).buildApp(builder)
    expect(order).toEqual(['client', 'hatk'])
  })

  test('skips the hatk stage for a client-only app', async () => {
    const builder = { environments: { client: { name: 'client' } }, build: vi.fn(async () => {}) }
    await (hatk() as any).buildApp(builder)
    expect(builder.build).toHaveBeenCalledTimes(1)
  })
})

test('the plugin announces itself under a stable name', () => {
  // Users reference this name in vite.config.ts plugin ordering.
  expect((hatk() as any).name).toBe('vite-plugin-hatk')
})
