import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InvalidRequestError,
  NotFoundError,
  blobUrl,
  buildXrpcContext,
  callXrpc,
  configureCdn,
  configureOAuth,
  configureRelay,
  executeXrpc,
  initXrpc,
  isLocalRelay,
  listXrpc,
  registerCoreXrpcHandler,
  registerXrpcHandler,
} from '../src/xrpc.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { insertRecord } from '../src/database/db.ts'
import { setupFixtureDatabase, PUBLIC_COLLECTION } from './fixture.ts'

// The XRPC layer is what an app's handlers are written against. Three things
// are pinned here: how a blob ref turns into an image URL for each deployment
// shape, how lexicon parameters are defaulted/coerced/required before a
// handler runs, and that the write helpers refuse to act without a session.

const pds = vi.hoisted(() => ({
  pdsCreateRecord: vi.fn(async () => ({ uri: 'at://did:plc:me/x/1', cid: 'c1' })),
  pdsPutRecord: vi.fn(async () => ({ uri: 'at://did:plc:me/x/rk', cid: 'c2' })),
  pdsDeleteRecord: vi.fn(async () => {}),
  pdsApplyWrites: vi.fn(async () => ({ results: [] })),
  pdsXrpc: vi.fn(async () => ({ repos: [] })),
}))
vi.mock('../src/pds-proxy.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/pds-proxy.ts')>()),
  ...pds,
}))

const ME = { did: 'did:plc:me', handle: 'me.test' }
const oauth = { issuer: 'https://example.app', scopes: ['atproto'], clients: [] } as any
const ref = { ref: { $link: 'bafyblob' }, mimeType: 'image/jpeg' }

beforeAll(async () => {
  await setupFixtureDatabase()
  await insertRecord(PUBLIC_COLLECTION, `at://${ME.did}/${PUBLIC_COLLECTION}/self`, 'cid1', ME.did, { text: 'me' })
})

// --- errors ---

test('InvalidRequestError is a 400 and NotFoundError a 404 with the NotFound name', () => {
  const bad = new InvalidRequestError('bad', 'CustomName')
  expect(bad.status).toBe(400)
  expect(bad.errorName).toBe('CustomName')
  expect(new InvalidRequestError('bad').errorName).toBeUndefined()

  const missing = new NotFoundError()
  expect(missing).toBeInstanceOf(InvalidRequestError)
  expect(missing.status).toBe(404)
  expect(missing.message).toBe('Not found')
  expect(missing.errorName).toBe('NotFound')
})

// --- relay + blob URLs ---

test('only loopback relays count as local', () => {
  for (const url of [
    'http://localhost:2583',
    'http://127.0.0.1:2583',
    'http://[::1]:2583',
    'http://pds.localhost',
    'ws://localhost',
  ]) {
    configureRelay(url)
    expect(isLocalRelay(), url).toBe(true)
  }
  for (const url of ['wss://bsky.network', 'https://relay.example.com', '', 'not a url']) {
    configureRelay(url)
    expect(isLocalRelay(), url).toBe(false)
  }
})

test('a missing or malformed blob ref gives no URL', () => {
  expect(blobUrl('did:plc:x', null)).toBeUndefined()
  expect(blobUrl('did:plc:x', undefined)).toBeUndefined()
  expect(blobUrl('did:plc:x', {})).toBeUndefined()
  expect(blobUrl('did:plc:x', { ref: {} })).toBeUndefined()
})

test('without a CDN, blobs are served from the Bluesky CDN with the preset in the path', () => {
  configureRelay('wss://bsky.network')
  configureCdn(null)
  expect(blobUrl('did:plc:x', ref)).toBe('https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafyblob@jpeg')
  expect(blobUrl('did:plc:x', ref, 'feed_thumbnail')).toBe(
    'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:x/bafyblob@jpeg',
  )
  // A ref stored as JSON text (straight out of a row) is parsed first.
  expect(blobUrl('did:plc:x', JSON.stringify(ref))).toBe(
    'https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafyblob@jpeg',
  )
})

test('a local relay routes blobs through the dev proxy regardless of CDN config', () => {
  configureRelay('http://localhost:2583')
  configureCdn({ url: 'https://cdn.test', key: 'aa', salt: 'bb' })
  expect(blobUrl('did:plc:x', ref)).toBe('/blob/did:plc:x/bafyblob')
  configureRelay('')
  configureCdn(null)
})

test('a configured CDN gets an imgproxy URL signed with the key and salt', () => {
  configureRelay('wss://bsky.network')
  const key = '0102'
  const salt = '0304'
  configureCdn({ url: 'https://cdn.test/', key, salt })

  const url = blobUrl('did:plc:x', ref, 'banner')!
  const path = '/banner/plain/did:plc:x/bafyblob'
  const hmac = createHmac('sha256', Buffer.from(key, 'hex'))
  hmac.update(Buffer.from(salt, 'hex'))
  hmac.update(path)
  // Trailing slash on the CDN url is dropped so the path is not doubled.
  expect(url).toBe(`https://cdn.test/${hmac.digest('base64url')}${path}`)
  configureCdn(null)
})

// --- context ---

test('the context defaults input to an object and wires the pagination helpers', async () => {
  const ctx = buildXrpcContext({ a: '1' }, 'cur', 5, ME)
  expect(ctx.params).toEqual({ a: '1' })
  expect(ctx.input).toEqual({})
  expect(ctx.cursor).toBe('cur')
  expect(ctx.limit).toBe(5)
  expect(ctx.viewer).toEqual(ME)
  expect(ctx.unpackCursor(ctx.packCursor('p', 'c'))).toEqual({ primary: 'p', cid: 'c' })
  expect(buildXrpcContext({}, undefined, 1, null, { body: true }).input).toEqual({ body: true })
})

test('exists answers whether any row matches every filter', async () => {
  const ctx = buildXrpcContext({}, undefined, 1, null)
  expect(await ctx.exists(PUBLIC_COLLECTION, { did: ME.did })).toBe(true)
  expect(await ctx.exists(PUBLIC_COLLECTION, { did: ME.did, text: 'other' })).toBe(false)
  expect(await ctx.exists('xyz.unknown', { did: ME.did })).toBe(false)
})

test('the write helpers refuse without OAuth configured', async () => {
  configureOAuth(null)
  const ctx = buildXrpcContext({}, undefined, 1, ME)
  await expect(ctx.createRecord('xyz.c', {})).rejects.toThrow(/No OAuth config/)
  await expect(ctx.putRecord('xyz.c', 'rk', {})).rejects.toThrow(/No OAuth config/)
  await expect(ctx.deleteRecord('xyz.c', 'rk')).rejects.toThrow(/No OAuth config/)
  await expect(ctx.applyWrites([])).rejects.toThrow(/No OAuth config/)
  await expect(ctx.pds('com.atproto.space.listRepos')).rejects.toThrow(/No OAuth config/)
})

test('the write helpers refuse without a signed-in viewer', async () => {
  configureOAuth(oauth)
  const ctx = buildXrpcContext({}, undefined, 1, null)
  await expect(ctx.createRecord('xyz.c', {})).rejects.toThrow(/Authentication required/)
  await expect(ctx.putRecord('xyz.c', 'rk', {})).rejects.toThrow(/Authentication required/)
  await expect(ctx.deleteRecord('xyz.c', 'rk')).rejects.toThrow(/Authentication required/)
  await expect(ctx.applyWrites([])).rejects.toThrow(/Authentication required/)
  await expect(ctx.pds('com.atproto.space.listRepos')).rejects.toThrow(/Authentication required/)
  expect(pds.pdsCreateRecord).not.toHaveBeenCalled()
})

test('with a session, the write helpers proxy to the PDS as the viewer', async () => {
  configureOAuth(oauth)
  const ctx = buildXrpcContext({}, undefined, 1, ME)

  await expect(ctx.createRecord('xyz.c', { a: 1 }, { rkey: 'rk' })).resolves.toEqual({
    uri: 'at://did:plc:me/x/1',
    cid: 'c1',
  })
  expect(pds.pdsCreateRecord).toHaveBeenCalledWith(oauth, ME, { collection: 'xyz.c', record: { a: 1 }, rkey: 'rk' })

  await ctx.putRecord('xyz.c', 'rk2', { b: 2 })
  expect(pds.pdsPutRecord).toHaveBeenCalledWith(oauth, ME, { collection: 'xyz.c', rkey: 'rk2', record: { b: 2 } })

  await ctx.deleteRecord('xyz.c', 'rk3')
  expect(pds.pdsDeleteRecord).toHaveBeenCalledWith(oauth, ME, { collection: 'xyz.c', rkey: 'rk3' })

  const writes = [{ $type: 'com.atproto.repo.applyWrites#create', collection: 'xyz.c', value: {} }]
  await ctx.applyWrites(writes)
  expect(pds.pdsApplyWrites).toHaveBeenCalledWith(oauth, ME, { writes })

  await expect(ctx.pds('com.atproto.space.listRepos', { params: { q: '1' } })).resolves.toEqual({ repos: [] })
  expect(pds.pdsXrpc).toHaveBeenCalledWith(oauth, ME, 'com.atproto.space.listRepos', { params: { q: '1' } })
  configureOAuth(null)
})

// --- registration + execution ---

test('executing an unregistered method resolves to null', async () => {
  expect(await executeXrpc('xyz.none', {}, undefined, 10)).toBeNull()
})

test('a handler registered against a lexicon has defaults applied, integers coerced and required params enforced', async () => {
  storeLexicons(
    new Map([
      [
        'xyz.test.getThings',
        {
          lexicon: 1,
          id: 'xyz.test.getThings',
          defs: {
            main: {
              type: 'query',
              parameters: {
                type: 'params',
                required: ['actor'],
                properties: {
                  actor: { type: 'string' },
                  limit: { type: 'integer', default: 10 },
                  page: { type: 'integer' },
                  flag: { type: 'boolean' },
                },
              },
            },
          },
        },
      ],
    ]),
  )
  registerXrpcHandler('xyz.test.getThings', { handler: async (ctx) => ctx.params })

  // Defaulted and coerced: `limit` was absent, `page` was a string.
  expect(await executeXrpc('xyz.test.getThings', { actor: 'a', page: '3', flag: 'true' }, undefined, 10)).toEqual({
    actor: 'a',
    limit: 10,
    page: 3,
    flag: 'true',
  })
  expect(await executeXrpc('xyz.test.getThings', { actor: 'a', limit: '5' }, undefined, 10)).toEqual({
    actor: 'a',
    limit: 5,
  })

  const missing = executeXrpc('xyz.test.getThings', { limit: '5' }, undefined, 10)
  await expect(missing).rejects.toBeInstanceOf(InvalidRequestError)
  await expect(missing).rejects.toMatchObject({
    message: 'Missing required parameter: actor',
    errorName: 'InvalidRequest',
  })
})

test('a handler without a lexicon still runs with its params untouched', async () => {
  registerXrpcHandler('xyz.test.noLexicon', { handler: async (ctx) => ({ params: ctx.params, input: ctx.input }) })
  expect(await executeXrpc('xyz.test.noLexicon', { n: '1' }, undefined, 10, null, { b: 1 })).toEqual({
    params: { n: '1' },
    input: { b: 1 },
  })
})

test('a handler error propagates to the caller', async () => {
  registerCoreXrpcHandler('xyz.test.fails', async () => {
    throw new Error('handler failed')
  })
  await expect(executeXrpc('xyz.test.fails', {}, undefined, 10)).rejects.toThrow('handler failed')
})

test('callXrpc stringifies params, drops nulls, and pulls limit and cursor out', async () => {
  let received: any
  registerCoreXrpcHandler('xyz.test.echo', async (params, cursor, limit, viewer) => {
    received = { params, cursor, limit, viewer }
    return { ok: true }
  })
  ;(globalThis as any).__hatk_viewer = ME
  try {
    await callXrpc('xyz.test.echo', { n: 2, s: 'x', none: null, undef: undefined, limit: 7, cursor: 'c' })
  } finally {
    ;(globalThis as any).__hatk_viewer = null
  }
  expect(received).toEqual({
    params: { n: '2', s: 'x', limit: '7', cursor: 'c' },
    cursor: 'c',
    limit: 7,
    viewer: ME,
  })

  await callXrpc('xyz.test.echo')
  expect(received).toEqual({ params: {}, cursor: undefined, limit: 20, viewer: null })
})

test('callXrpc throws for a method nobody registered', async () => {
  await expect(callXrpc('xyz.test.missing')).rejects.toThrow('No XRPC handler registered for xyz.test.missing')
})

test('listXrpc names every registered method', () => {
  const names = listXrpc()
  expect(names).toContain('xyz.test.getThings')
  expect(names).toContain('xyz.test.echo')
})

// --- discovery from an xrpc/ directory ---

let dir: string
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('initXrpc maps nested files to NSIDs and skips underscore-prefixed modules', async () => {
  dir = await mkdtemp(join(tmpdir(), 'hatk-xrpc-'))
  await mkdir(join(dir, 'xyz', 'disk'), { recursive: true })
  await writeFile(
    join(dir, 'xyz', 'disk', 'getNested.ts'),
    `export default { handler: async (ctx) => ({ nested: ctx.params }) }\n`,
  )
  // A discovered module is validated against its lexicon just like a
  // registered one: the NSID is derived from the path and looked up.
  storeLexicons(
    new Map([
      [
        'xyz.disk.getNested',
        {
          lexicon: 1,
          id: 'xyz.disk.getNested',
          defs: {
            main: {
              type: 'query',
              parameters: {
                type: 'params',
                required: ['q'],
                properties: { q: { type: 'string' }, limit: { type: 'integer', default: 25 } },
              },
            },
          },
        },
      ],
    ]),
  )
  await writeFile(join(dir, 'xyz', 'disk', '_shared.ts'), `throw new Error('helpers must not be imported')\n`)
  await writeFile(join(dir, 'xyz', 'disk', 'README.md'), '# ignore\n')
  await writeFile(join(dir, 'topLevel.js'), `export default { handler: async () => ({ top: true }) }\n`)

  await initXrpc(dir)
  expect(listXrpc()).toContain('xyz.disk.getNested')
  expect(listXrpc()).toContain('topLevel')
  expect(listXrpc().some((n) => n.includes('_shared'))).toBe(false)
  expect(await executeXrpc('xyz.disk.getNested', { q: '1', limit: '3' }, undefined, 10)).toEqual({
    nested: { q: '1', limit: 3 },
  })
  expect(await executeXrpc('xyz.disk.getNested', { q: '1' }, undefined, 10)).toEqual({ nested: { q: '1', limit: 25 } })
  await expect(executeXrpc('xyz.disk.getNested', {}, undefined, 10)).rejects.toThrow('Missing required parameter: q')
  expect(await executeXrpc('topLevel', {}, undefined, 10)).toEqual({ top: true })
})

test('an empty or missing xrpc directory registers nothing', async () => {
  const before = listXrpc().length
  await initXrpc(join(tmpdir(), 'hatk-xrpc-does-not-exist'))
  expect(listXrpc()).toHaveLength(before)
})
