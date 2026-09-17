import { expect, test } from 'vitest'
import {
  defineRenderer,
  getRenderer,
  getSSRManifest,
  registerRenderer,
  renderPage,
  setSSRManifest,
} from '../src/renderer.ts'

// The renderer is the seam between hatk's static index.html and an app's SSR
// output. What matters is where each piece lands in the template: head tags
// and OG meta must end up inside <head>, and the rendered markup must replace
// the outlet — nothing else in the template may be disturbed.

const template = '<!doctype html><html><head><title>t</title></head><body><!--ssr-outlet--></body></html>'

test('renderPage returns null when no renderer is registered', async () => {
  // The server uses null to fall back to the SPA template.
  expect(getRenderer()).toBeNull()
  expect(await renderPage(template, new Request('http://localhost/'))).toBeNull()
})

test('defineRenderer tags the handler so the module scanner can recognize it', () => {
  const handler = async () => ({ html: '' })
  expect(defineRenderer(handler)).toEqual({ __type: 'renderer', handler })
})

test('a renderer with no manifest gets one whose preload tags are empty', async () => {
  let received: any
  registerRenderer(async (_request, manifest) => {
    received = manifest
    return { html: '<p>hi</p>' }
  })
  expect(getRenderer()).not.toBeNull()
  expect(getSSRManifest()).toBeNull()

  const html = await renderPage(template, new Request('http://localhost/'))
  expect(received.getPreloadTags('/')).toBe('')
  expect(html).toBe('<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>')
})

test('the renderer receives the request and the configured manifest', async () => {
  const manifest = { getPreloadTags: (url: string) => `<link rel="modulepreload" href="${url}">` }
  setSSRManifest(manifest)
  expect(getSSRManifest()).toBe(manifest)

  let seen: { url: string; preload: string } | undefined
  registerRenderer(async (request, m) => {
    seen = { url: request.url, preload: m.getPreloadTags('/app.js') }
    return { html: '' }
  })
  await renderPage(template, new Request('http://localhost/profile/alice'))
  expect(seen).toEqual({ url: 'http://localhost/profile/alice', preload: '<link rel="modulepreload" href="/app.js">' })
})

test('head tags, OG meta and the rendered body are all placed in the template', async () => {
  registerRenderer(async () => ({ html: '<main>rendered</main>', head: '<style>.a{}</style>' }))
  const html = (await renderPage(template, new Request('http://localhost/'), '<meta property="og:title" content="x">'))!

  const headEnd = html.indexOf('</head>')
  expect(html.indexOf('<style>.a{}</style>')).toBeLessThan(headEnd)
  expect(html.indexOf('<meta property="og:title"')).toBeLessThan(headEnd)
  expect(html).toContain('<body><main>rendered</main></body>')
  expect(html).not.toContain('<!--ssr-outlet-->')
  // The original head content survives.
  expect(html).toContain('<title>t</title>')
})

test('a template without a head still gets its outlet filled', async () => {
  registerRenderer(async () => ({ html: 'X', head: '<meta>' }))
  const html = await renderPage('<div><!--ssr-outlet--></div>', new Request('http://localhost/'), '<og>')
  // No </head> to anchor on, so head/OG injection is a no-op rather than an error.
  expect(html).toBe('<div>X</div>')
})
