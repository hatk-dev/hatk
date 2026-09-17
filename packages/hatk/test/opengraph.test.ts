import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import satori from 'satori'
import { buildOgMeta, defineOG, handleOpengraphRequest, initOpengraph, registerOgHandler } from '../src/opengraph.ts'
import { setupFixtureDatabase } from './fixture.ts'

// Spied, not stubbed: every test below still renders for real. The spy only
// lets the font test read back the bytes opengraph.ts handed over.
vi.mock('satori', { spy: true })

// An OG image route does two jobs: render a PNG for /og/... and, for the
// matching page, tell the SPA fallback which <meta> tags to inject so link
// previews point at that PNG. satori and resvg are real dependencies here,
// so the image really is rendered — the PNG signature is the proof.

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

test('the default font is passed to satori as the exact byte range of the file, not its backing buffer', async () => {
  // `readFileSync` hands back a Buffer that is a *view*: its bytes sit at some
  // byteOffset inside a larger allocation holding unrelated data either side.
  // Under plain Node the font happens to land at offset 0, which is why handing
  // satori `.buffer` went unnoticed; under vitest it lands partway in and satori
  // parses the neighbouring bytes ("Unsupported OpenType signature").
  const font = readFileSync(resolve(import.meta.dirname, '..', 'fonts', 'Inter-Regular.woff'))
  expect([...font.subarray(0, 4)]).toEqual([0x77, 0x4f, 0x46, 0x46]) // "wOFF"
  expect(font.byteLength).toBeLessThan(font.buffer.byteLength) // it really is a view

  registerOgHandler({ path: '/og/font/:id', generate: async () => ({ element: textElement('font') }) })
  const png = await handleOpengraphRequest('/og/font/1')
  expect([...png!.subarray(0, 4)]).toEqual(PNG_MAGIC)

  const handed = vi.mocked(satori).mock.lastCall![1].fonts!.find((f) => f.name === 'Inter')!
  // The file, byte for byte — not the allocation it was read into.
  expect(handed.data.byteLength).toBe(font.byteLength)
  expect([...new Uint8Array(handed.data as ArrayBuffer).subarray(0, 4)]).toEqual([...font.subarray(0, 4)])
})

function textElement(text: string) {
  return {
    type: 'div',
    props: { style: { display: 'flex', width: '100%', height: '100%', fontSize: 48 }, children: text },
  }
}

beforeAll(async () => {
  await setupFixtureDatabase()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('defineOG tags the module and keeps the path and generator', () => {
  const generate = async () => ({ element: textElement('x') })
  expect(defineOG('/og/x', generate)).toEqual({ __type: 'og', path: '/og/x', generate })
})

test('a path with no handler yields nothing for the image or the meta tags', async () => {
  expect(await handleOpengraphRequest('/og/none/1')).toBeNull()
  expect(buildOgMeta('/none/1', 'https://app.test')).toBeNull()
})

test('a registered route renders a PNG from the generator, with decoded path params', async () => {
  const generate = vi.fn(async (ctx: any) => ({
    element: textElement(`Hello ${ctx.params.handle}`),
    meta: { title: `Profile of ${ctx.params.handle}`, description: 'Says "hi" & <bye>' },
  }))
  registerOgHandler({ path: '/og/profile/:handle', generate })

  const png = await handleOpengraphRequest('/og/profile/alice%20b')
  expect(png).toBeInstanceOf(Buffer)
  expect([...png!.subarray(0, 4)]).toEqual(PNG_MAGIC)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(generate.mock.calls[0][0].params).toEqual({ handle: 'alice b' })
  // The generator runs with a limit-1, viewer-less XRPC context.
  expect(generate.mock.calls[0][0].viewer).toBeNull()
  expect(generate.mock.calls[0][0].limit).toBe(1)
})

test('a second request for the same path is served from cache without re-rendering', async () => {
  const generate = vi.fn(async () => ({ element: textElement('cached') }))
  registerOgHandler({ path: '/og/cached/:id', generate })

  const first = await handleOpengraphRequest('/og/cached/1')
  const second = await handleOpengraphRequest('/og/cached/1')
  expect(second).toBe(first)
  expect(generate).toHaveBeenCalledTimes(1)

  // A different id is a different image.
  await handleOpengraphRequest('/og/cached/2')
  expect(generate).toHaveBeenCalledTimes(2)
})

test('page meta before any render uses the path params as the title', () => {
  const tags = buildOgMeta('/profile/bob', 'https://app.test')!
  expect(tags).toContain('<meta property="og:title" content="bob">')
  expect(tags).toContain('<meta property="og:image" content="https://app.test/og/profile/bob">')
  expect(tags).toContain('<meta property="og:url" content="https://app.test/profile/bob">')
  expect(tags).toContain('<meta name="twitter:card" content="summary_large_image">')
  // No description until the generator has supplied one.
  expect(tags).not.toContain('og:description')
})

test('page meta after a render uses the generator meta, HTML-escaped', () => {
  // /og/profile/alice%20b was rendered above; its page is /profile/alice%20b.
  const tags = buildOgMeta('/profile/alice%20b', 'https://app.test')!
  expect(tags).toContain('<meta property="og:title" content="Profile of alice b">')
  expect(tags).toContain('<meta property="og:description" content="Says &quot;hi&quot; &amp; &lt;bye>">')
  expect(tags).toContain('<meta name="twitter:description" content="Says &quot;hi&quot; &amp; &lt;bye>">')
  expect(tags).toContain('<meta property="og:image" content="https://app.test/og/profile/alice%20b">')
})

test('an OG route outside /og has no page counterpart', () => {
  registerOgHandler({ path: '/cards/:id', generate: async () => ({ element: textElement('c') }) })
  expect(buildOgMeta('/cards/1', 'https://app.test')).toBeNull()
})

test('a generator that throws produces no image rather than a crash', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  registerOgHandler({
    path: '/og/broken/:id',
    generate: async () => {
      throw new Error('no such record')
    },
  })
  expect(await handleOpengraphRequest('/og/broken/1')).toBeNull()
  expect(error).toHaveBeenCalledWith(expect.stringContaining('[opengraph] error'), 'no such record', expect.anything())
})

test('the generator context serves blob URLs with the _og preset and can inline remote images', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/ok.jpg'))
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      if (url.endsWith('/untyped')) return new Response(new Uint8Array([4]))
      if (url.endsWith('/missing')) return new Response(null, { status: 404 })
      throw new Error('network down')
    }),
  )
  let seen: any
  registerOgHandler({
    path: '/og/ctx/:id',
    generate: async (ctx) => {
      seen = {
        blob: ctx.blobUrl('did:plc:x', { ref: { $link: 'bafyimg' } }),
        banner: ctx.blobUrl('did:plc:x', { ref: { $link: 'bafyimg' } }, 'banner'),
        ok: await ctx.fetchImage('https://img.test/ok.jpg'),
        untyped: await ctx.fetchImage('https://img.test/untyped'),
        missing: await ctx.fetchImage('https://img.test/missing'),
        down: await ctx.fetchImage('https://img.test/down'),
      }
      return { element: textElement('ctx') }
    },
  })
  await handleOpengraphRequest('/og/ctx/1')
  expect(seen).toEqual({
    // satori cannot decode webp, so the preset asks for the jpeg variant.
    blob: 'https://cdn.bsky.app/img/avatar_og/plain/did:plc:x/bafyimg@jpeg',
    banner: 'https://cdn.bsky.app/img/banner_og/plain/did:plc:x/bafyimg@jpeg',
    ok: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
    untyped: `data:image/jpeg;base64,${Buffer.from([4]).toString('base64')}`,
    missing: null,
    down: null,
  })
})

test('generator options override the default canvas size and add fonts', async () => {
  registerOgHandler({
    path: '/og/small/:id',
    generate: async () => ({
      element: textElement('s'),
      options: { width: 600, height: 300 },
    }),
  })
  const png = (await handleOpengraphRequest('/og/small/1'))!
  expect([...png.subarray(0, 4)]).toEqual(PNG_MAGIC)
  // resvg fits the output to 1200px wide regardless of the SVG's own size, so
  // read the IHDR width to confirm the render was scaled rather than rejected.
  expect(png.readUInt32BE(16)).toBe(1200)
})

// --- Discovery from an og/ directory ---

let dir: string
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('initOpengraph loads modules from disk and warns about one without a path', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  dir = await mkdtemp(join(tmpdir(), 'hatk-og-'))
  await writeFile(
    join(dir, 'post.ts'),
    `export default { path: '/og/post/:rkey', generate: async (ctx) => ({
      element: { type: 'div', props: { style: { display: 'flex', fontSize: 40 }, children: 'post ' + ctx.params.rkey } },
      meta: { title: 'Post ' + ctx.params.rkey },
    }) }\n`,
  )
  await writeFile(join(dir, 'nopath.ts'), `export default { generate: async () => ({}) }\n`)
  await writeFile(join(dir, '_helper.ts'), `throw new Error('helpers must not be imported')\n`)

  await initOpengraph(dir)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("nopath.ts missing 'path'"))

  const png = await handleOpengraphRequest('/og/post/abc')
  expect([...png!.subarray(0, 4)]).toEqual(PNG_MAGIC)
  expect(buildOgMeta('/post/abc', 'https://app.test')).toContain('content="Post abc"')
})

test('a missing og directory is not an error', async () => {
  await expect(initOpengraph(join(tmpdir(), 'hatk-og-does-not-exist'))).resolves.toBeUndefined()
})
