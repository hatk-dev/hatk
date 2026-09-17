/**
 * initServer is the single entry point that turns a project's server/ directory
 * into live handlers. Everything it registers is global module state, so the
 * failure mode of a regression here is "the feed exists on disk but 404s" —
 * these tests assert against the registries themselves, not against the scan.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initServer } from '../src/server-init.ts'
import { listFeeds } from '../src/feeds.ts'
import { listXrpc } from '../src/xrpc.ts'
import { getLabelDefinitions } from '../src/labels.ts'
import { buildOgMeta } from '../src/opengraph.ts'
import { getRenderer } from '../src/renderer.ts'
import { fireOnCommitHooks } from '../src/hooks.ts'
import { setupFixtureDatabase } from './fixture.ts'

// src/logger.ts silences log()/emit() when DEBUG=0, and these tests assert on
// that output. Clear it so a developer's ambient DEBUG=0 can't fail the suite.
const originalDebug = process.env.DEBUG
beforeAll(() => void delete process.env.DEBUG)
afterAll(() => {
  if (originalDebug !== undefined) process.env.DEBUG = originalDebug
})

let root: string

beforeAll(async () => {
  // registerXrpcHandler and the setup context both reach for the database.
  await setupFixtureDatabase()
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hatk-server-')))
  ;(globalThis as any).__serverCalls = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete (globalThis as any).__serverCalls
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as any).__serverCalls
})

/** Write a module into the scratch server/ tree. */
function writeModule(relPath: string, body: string): void {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

const FEED = `export default { __type: 'feed', label: 'Trending', collection: 'app.bsky.actor.profile', async generate(ctx) { return { uris: [] } } }\n`
const QUERY = (nsid: string) => `export default { __type: 'query', nsid: '${nsid}', async handler() { return {} } }\n`
const PROCEDURE = (nsid: string) =>
  `export default { __type: 'procedure', nsid: '${nsid}', async handler() { return {} } }\n`
const SETUP = (tag: string) =>
  `export default { __type: 'setup', handler: async () => { globalThis.__serverCalls.push('${tag}') } }\n`

describe('initServer', () => {
  test('skips a project with no server/ directory', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await initServer(join(root, 'server'))
    expect(log.mock.calls.flat()).toContain('[server] No server/ directory found, skipping')
  })

  test('registers a feed under its file name', async () => {
    writeModule('trending.ts', FEED)
    await initServer(root)

    expect(listFeeds().map((f) => f.name)).toContain('trending')
    expect(listFeeds().find((f) => f.name === 'trending')!.label).toBe('Trending')
  })

  test('registers a nested feed under its basename, not its path', async () => {
    // Feed names become URL segments, so server/feeds/hot.ts must serve as `hot`,
    // not `feeds/hot`.
    writeModule('feeds/hot.ts', FEED)
    await initServer(root)

    const names = listFeeds().map((f) => f.name)
    expect(names).toContain('hot')
    expect(names).not.toContain('feeds/hot')
  })

  test('registers queries and procedures under their declared NSIDs', async () => {
    // The file name is irrelevant here — the NSID inside the module is the route.
    writeModule('getWidgets.ts', QUERY('com.example.getWidgets'))
    writeModule('putWidget.ts', PROCEDURE('com.example.putWidget'))
    await initServer(root)

    expect(listXrpc()).toContain('com.example.getWidgets')
    expect(listXrpc()).toContain('com.example.putWidget')
  })

  test('registers label definitions', async () => {
    writeModule(
      'spam.ts',
      `export default { __type: 'labels', definition: { identifier: 'spam', severity: 'alert' } }\n`,
    )
    await initServer(root)

    expect(getLabelDefinitions().map((d: any) => d.identifier)).toContain('spam')
  })

  test('clears previously registered labels on re-init so hot reload does not duplicate them', async () => {
    writeModule('spam.ts', `export default { __type: 'labels', definition: { identifier: 'spam' } }\n`)
    await initServer(root)
    await initServer(root)

    const spam = getLabelDefinitions().filter((d: any) => d.identifier === 'spam')
    expect(spam).toHaveLength(1)
  })

  test('registers an OpenGraph route and its matching page route', async () => {
    writeModule(
      'og.ts',
      `export default { __type: 'og', path: '/og/widget/:rkey', async generate() { return { element: null } } }\n`,
    )
    await initServer(root)

    // buildOgMeta maps the page URL back to the og image URL.
    const meta = buildOgMeta('/widget/abc', 'https://example.test')
    expect(meta).toContain('https://example.test/og/widget/abc')
  })

  test('registers an SSR renderer', async () => {
    writeModule('render.ts', `export default { __type: 'renderer', handler: async () => ({ html: '<p>hi</p>' }) }\n`)
    await initServer(root)

    expect(getRenderer()).toBeTypeOf('function')
  })

  test('registers an on-commit hook scoped to its collections', async () => {
    writeModule(
      'onCommit.ts',
      `export default { __type: 'hook', event: 'on-commit', collections: ['app.bsky.actor.profile'], handler: async () => { globalThis.__serverCalls.push('commit') } }\n`,
    )
    await initServer(root)

    const item = {
      action: 'create' as const,
      collection: 'app.bsky.actor.profile',
      uri: 'at://did:plc:alice/app.bsky.actor.profile/self',
      authorDid: 'did:plc:alice',
      record: {},
    }
    fireOnCommitHooks([item])
    await new Promise((r) => setTimeout(r, 10))
    expect((globalThis as any).__serverCalls).toContain('commit')

    // A commit in an unrelated collection must not wake the hook.
    ;(globalThis as any).__serverCalls = []
    fireOnCommitHooks([{ ...item, collection: 'social.switchback.activity' }])
    await new Promise((r) => setTimeout(r, 10))
    expect((globalThis as any).__serverCalls).toEqual([])
  })

  test('runs setup scripts in sorted order before anything is registered', async () => {
    // A feed that queries a setup-created table would otherwise race its own table.
    writeModule('02-second.ts', SETUP('second'))
    writeModule('01-first.ts', SETUP('first'))
    await initServer(root)

    expect((globalThis as any).__serverCalls).toEqual(['first', 'second'])
  })

  test('skips setup scripts when asked, but still registers handlers', async () => {
    // The test harness shares one database across files; re-running migrations
    // per suite would be both slow and destructive.
    writeModule('01-first.ts', SETUP('first'))
    writeModule('trending.ts', FEED)
    await initServer(root, { skipSetup: true })

    expect((globalThis as any).__serverCalls).toEqual([])
    expect(listFeeds().map((f) => f.name)).toContain('trending')
  })

  test('ignores modules with no default export or no recognized tag', async () => {
    writeModule('helper.ts', `export const helper = 1\n`)
    writeModule('mystery.ts', `export default { __type: 'wat' }\n`)
    writeModule('trending.ts', FEED)

    await expect(initServer(root)).resolves.toBeUndefined()
    expect(listFeeds().map((f) => f.name)).toContain('trending')
  })

  test('summarizes what it registered', async () => {
    // This block is the boot log an operator reads to confirm a deploy took.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    writeModule('trending.ts', FEED)
    writeModule('getWidgets.ts', QUERY('com.example.getWidgets'))
    await initServer(root)

    const lines = log.mock.calls.map((c) => c.join(' '))
    expect(lines).toContain('[server] Initialized from server/ directory:')
    expect(lines.some((l) => l.startsWith('  Feeds:') && l.includes('trending'))).toBe(true)
    expect(lines.some((l) => l.startsWith('  XRPC:') && l.includes('com.example.getWidgets'))).toBe(true)
    expect(lines.some((l) => l.startsWith('  Labels:') && l.includes('definitions'))).toBe(true)
  })

  test('reports none for an empty server directory', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'hatk-empty-')))
    try {
      // Nothing registered here, but the earlier suites already populated the
      // shared registries, so only the labels count is safely assertable.
      await initServer(empty)
      const lines = log.mock.calls.map((c) => c.join(' '))
      expect(lines).toContain('  Labels: 0 definitions')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
