import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanServerDir } from '../src/scanner.ts'

// src/logger.ts silences log()/emit() when DEBUG=0, and these tests assert on
// that output. Clear it so a developer's ambient DEBUG=0 can't fail the suite.
const originalDebug = process.env.DEBUG
beforeAll(() => void delete process.env.DEBUG)
afterAll(() => {
  if (originalDebug !== undefined) process.env.DEBUG = originalDebug
})

// The scanner is how a project's server/ directory becomes routes: each file's
// default export is sorted into a bucket by its `__type` tag. What it skips is
// as important as what it finds — underscore and dot files are the convention
// for helpers and editor droppings, and a file without a tagged default export
// must not be mistaken for a route.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hatk-scanner-'))
const serverDir = path.join(tmp, 'server')

function write(rel: string, source: string) {
  const full = path.join(serverDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, source)
}

function tagged(type: string, extra = '') {
  return `export default { __type: '${type}', ${extra} }`
}

beforeAll(() => {
  write('feeds/home.ts', tagged('feed', "name: 'home'"))
  write('feeds/nested/deep.ts', tagged('feed', "name: 'deep'"))
  write('queries/getThing.ts', tagged('query'))
  write('procedures/doThing.js', tagged('procedure'))
  write('hooks.ts', tagged('hook'))
  write('setup.ts', tagged('setup'))
  write('labels.ts', tagged('labels'))
  write('og.ts', tagged('og'))
  write('renderer.ts', tagged('renderer'))
  // Skipped for various reasons:
  write('_helpers.ts', tagged('feed', "name: 'helper'"))
  write('_private/secret.ts', tagged('feed', "name: 'secret'"))
  write('.hidden.ts', tagged('feed', "name: 'hidden'"))
  write('notes.md', '# not code')
  write('types.ts', 'export const notDefault = 1')
  write('untagged.ts', 'export default { name: "plain object" }')
  write('stringy.ts', "export default { __type: 'widget' }")
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('sorts tagged default exports into their buckets and names them by path', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const result = await scanServerDir(serverDir)

  expect(result.feeds.map((m) => m.name).sort()).toEqual(['feeds/home', 'feeds/nested/deep'])
  expect(result.queries.map((m) => m.name)).toEqual(['queries/getThing'])
  expect(result.procedures.map((m) => m.name)).toEqual(['procedures/doThing'])
  expect(result.hooks.map((m) => m.name)).toEqual(['hooks'])
  expect(result.setup.map((m) => m.name)).toEqual(['setup'])
  expect(result.labels.map((m) => m.name)).toEqual(['labels'])
  expect(result.og.map((m) => m.name)).toEqual(['og'])
  expect(result.renderer?.name).toBe('renderer')

  // The module itself is handed back so the caller can read its config
  const home = result.feeds.find((m) => m.name === 'feeds/home')!
  expect(home.mod).toEqual({ __type: 'feed', name: 'home' })
  expect(home.path).toBe(path.join(serverDir, 'feeds', 'home.ts'))
})

test('underscore-prefixed and dot files (and directories) are never loaded', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const result = await scanServerDir(serverDir)
  const names = result.feeds.map((m) => m.mod.name)
  expect(names).not.toContain('helper')
  expect(names).not.toContain('secret')
  expect(names).not.toContain('hidden')
})

test('files without a tagged default export are reported and skipped', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const result = await scanServerDir(serverDir)

  const all = [...result.feeds, ...result.queries, ...result.procedures, ...result.hooks, ...result.setup]
  expect(all.map((m) => m.name)).not.toContain('types')
  expect(all.map((m) => m.name)).not.toContain('untagged')
  expect(all.map((m) => m.name)).not.toContain('stringy')

  const messages = log.mock.calls.map((c) => String(c[0]))
  expect(messages).toContain('[scanner] types: no default export, skipping')
  expect(messages).toContain('[scanner] untagged: no recognized __type tag, skipping')
  expect(messages).toContain('[scanner] stringy: no recognized __type tag, skipping')
})

test('a missing server directory yields empty buckets rather than an error', async () => {
  const result = await scanServerDir(path.join(tmp, 'nope'))
  expect(result).toEqual({
    feeds: [],
    queries: [],
    procedures: [],
    hooks: [],
    setup: [],
    labels: [],
    og: [],
    renderer: null,
  })
})

// Dev mode rescans on save, and the `?t=<now>` cache-buster on the import is
// what makes a re-scan see the new module body: plain Node honours the query
// (a fresh module instance per distinct URL), but vitest's module runner
// caches by file path and ignores it, so this cannot be shown in-process here.
test.todo('re-scanning picks up a file that changed since the last scan')
