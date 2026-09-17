import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHook, fireOnCommitHooks, fireOnLoginHook, loadOnLoginHook, registerHook } from '../src/hooks.ts'
import { getRepoStatus, insertRecord } from '../src/database/db.ts'
import { setupFixtureDatabase, PUBLIC_COLLECTION } from './fixture.ts'

// Hooks are app code running inside hatk's own request and indexing paths, so
// the contract is mostly about containment: a hook that throws, hangs or
// asks for something it cannot have must never break the login or the
// firehose that fired it.

const backfill = vi.hoisted(() => ({
  triggerAutoBackfill: vi.fn(async () => {}),
  awaitBackfill: vi.fn(async () => {}),
}))
vi.mock('../src/indexer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/indexer.ts')>()),
  ...backfill,
}))

const pds = vi.hoisted(() => ({
  pdsCreateRecord: vi.fn(async () => ({ uri: 'at://did:plc:me/x/1', cid: 'c1' })),
  pdsPutRecord: vi.fn(async () => ({ uri: 'at://did:plc:me/x/rk', cid: 'c2' })),
  pdsDeleteRecord: vi.fn(async () => {}),
}))
vi.mock('../src/pds-proxy.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/pds-proxy.ts')>()),
  ...pds,
}))

const push = vi.hoisted(() => ({ enabled: false, send: vi.fn(async () => {}) }))
vi.mock('../src/push.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/push.ts')>()),
  isPushEnabled: () => push.enabled,
  buildPushInterface: () => ({ send: push.send }),
}))

const ME = 'did:plc:me'
const oauth = { issuer: 'https://example.app', scopes: ['atproto'], clients: [] } as any

/** Structured events hooks emit on failure go to stdout; capture them. */
function captureEmits() {
  const lines: any[] = []
  // `emit` is silenced under DEBUG=0, which is how the suite is often run.
  const debug = process.env.DEBUG
  process.env.DEBUG = '1'
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    try {
      lines.push(JSON.parse(String(chunk)))
    } catch {}
    return true
  }) as any)
  return {
    lines,
    restore: () => {
      spy.mockRestore()
      if (debug === undefined) delete process.env.DEBUG
      else process.env.DEBUG = debug
    },
  }
}

beforeAll(async () => {
  await setupFixtureDatabase()
  await insertRecord(PUBLIC_COLLECTION, `at://${ME}/${PUBLIC_COLLECTION}/self`, 'cid1', ME, { text: 'me' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('defineHook produces the shapes the module scanner expects', () => {
  const login = async () => {}
  expect(defineHook('on-login', login)).toEqual({ __type: 'hook', event: 'on-login', handler: login })

  const commit = async () => {}
  expect(defineHook('on-commit', { collections: ['a.b'] }, commit)).toEqual({
    __type: 'hook',
    event: 'on-commit',
    collections: ['a.b'],
    handler: commit,
  })

  expect(() => (defineHook as any)('on-nothing', login)).toThrow(/Unknown hook event/)
})

test('firing with no on-login hook registered is a no-op', async () => {
  await expect(fireOnLoginHook(ME, oauth)).resolves.toBeUndefined()
})

test('the on-login hook gets the viewer, a writable db and a working ensureRepo', async () => {
  let ctx: any
  registerHook('on-login', async (c: any) => {
    ctx = c
    await c.ensureRepo('did:plc:friend')
    await c.db.run(`INSERT INTO _preferences (did, key, value, updated_at) VALUES ($1, $2, $3, $4)`, [
      c.did,
      'k',
      '"v"',
      'now',
    ])
  })
  await fireOnLoginHook(ME, oauth)

  expect(ctx.did).toBe(ME)
  expect(ctx.viewer).toEqual({ did: ME })
  // ensureRepo marks the repo, kicks the backfill and waits for it.
  expect(await getRepoStatus('did:plc:friend')).toBe('pending')
  expect(backfill.triggerAutoBackfill).toHaveBeenCalledWith('did:plc:friend')
  expect(backfill.awaitBackfill).toHaveBeenCalledWith('did:plc:friend')
  // The write went through and the read side sees it.
  const rows = await ctx.db.query(`SELECT value FROM _preferences WHERE did = $1`, [ME])
  expect(rows).toEqual([{ value: '"v"' }])
  // The lookup helper from BaseContext is available too.
  const me = await ctx.lookup(PUBLIC_COLLECTION, 'did', [ME])
  expect(me.get(ME)?.value.text).toBe('me')
})

test('record writes from the hook go to the PDS on behalf of the user who logged in', async () => {
  registerHook('on-login', async (c: any) => {
    await c.createRecord('xyz.c', { a: 1 }, { rkey: 'rk' })
    await c.putRecord('xyz.c', 'rk2', { b: 2 })
    await c.deleteRecord('xyz.c', 'rk3')
  })
  await fireOnLoginHook(ME, oauth)
  expect(pds.pdsCreateRecord).toHaveBeenCalledWith(
    oauth,
    { did: ME },
    { collection: 'xyz.c', record: { a: 1 }, rkey: 'rk' },
  )
  expect(pds.pdsPutRecord).toHaveBeenCalledWith(
    oauth,
    { did: ME },
    { collection: 'xyz.c', rkey: 'rk2', record: { b: 2 } },
  )
  expect(pds.pdsDeleteRecord).toHaveBeenCalledWith(oauth, { did: ME }, { collection: 'xyz.c', rkey: 'rk3' })
})

test('without OAuth configured, a write from the hook fails inside the hook and is reported', async () => {
  const { lines, restore } = captureEmits()
  let caught: Error | undefined
  registerHook('on-login', async (c: any) => {
    try {
      await c.createRecord('xyz.c', {})
    } catch (err: any) {
      caught = err
      throw err
    }
  })
  await expect(fireOnLoginHook(ME, null)).resolves.toBeUndefined()
  restore()
  expect(caught?.message).toMatch(/No OAuth config/)
  expect(lines).toContainEqual(expect.objectContaining({ module: 'hooks', op: 'on_login_error', did: ME }))
})

test('a hook that throws is logged and does not fail the login', async () => {
  const { lines, restore } = captureEmits()
  registerHook('on-login', async () => {
    throw new Error('hook exploded')
  })
  await expect(fireOnLoginHook(ME, oauth)).resolves.toBeUndefined()
  restore()
  expect(lines).toContainEqual(expect.objectContaining({ op: 'on_login_error', error: 'hook exploded' }))
})

test('a hook that never settles is abandoned after 30 seconds', async () => {
  vi.useFakeTimers()
  const { lines, restore } = captureEmits()
  registerHook('on-login', () => new Promise<void>(() => {}))
  const done = fireOnLoginHook(ME, oauth)
  await vi.advanceTimersByTimeAsync(30_000)
  await done
  restore()
  expect(lines).toContainEqual(
    expect.objectContaining({ op: 'on_login_error', error: expect.stringMatching(/timed out/) }),
  )
})

// --- on-commit ---

const flush = () => new Promise((r) => setTimeout(r, 0))

test('on-commit hooks only see the collections they subscribed to', async () => {
  const seen: string[] = []
  registerHook('on-commit', async (c: any) => void seen.push(`${c.action}:${c.uri}`), { collections: ['xyz.a'] })
  fireOnCommitHooks([
    { action: 'create', collection: 'xyz.a', uri: 'at://d/xyz.a/1', authorDid: 'd', record: { x: 1 } },
    { action: 'delete', collection: 'xyz.b', uri: 'at://d/xyz.b/1', authorDid: 'd', record: null },
    { action: 'delete', collection: 'xyz.a', uri: 'at://d/xyz.a/2', authorDid: 'd', record: null },
  ])
  await flush()
  expect(seen).toEqual(['create:at://d/xyz.a/1', 'delete:at://d/xyz.a/2'])
})

test('a hook with no collection filter sees everything, with the full context', async () => {
  const seen: any[] = []
  registerHook('on-commit', async (c: any) => void seen.push(c), { collections: [] })
  fireOnCommitHooks([
    { action: 'create', collection: 'xyz.z', uri: 'at://d/xyz.z/1', authorDid: 'd', record: { y: 2 } },
  ])
  await flush()
  const ctx = seen.find((c) => c.collection === 'xyz.z')
  expect(ctx).toMatchObject({ action: 'create', repo: 'd', uri: 'at://d/xyz.z/1', record: { y: 2 } })
  expect(typeof ctx.db.query).toBe('function')
  expect(typeof ctx.db.run).toBe('function')
  expect(typeof ctx.lookup).toBe('function')
  // Push is disabled here, so the interface is an inert stub rather than absent.
  await expect(ctx.push.send()).resolves.toBeUndefined()
  expect(push.send).not.toHaveBeenCalled()
})

test('a failing on-commit hook is logged without affecting the others', async () => {
  const { lines, restore } = captureEmits()
  const after: string[] = []
  registerHook(
    'on-commit',
    async () => {
      throw new Error('commit hook failed')
    },
    { collections: ['xyz.fail'] },
  )
  registerHook('on-commit', async (c: any) => void after.push(c.uri), { collections: ['xyz.fail'] })
  fireOnCommitHooks([
    { action: 'create', collection: 'xyz.fail', uri: 'at://d/xyz.fail/1', authorDid: 'd', record: {} },
  ])
  await flush()
  restore()
  expect(after).toEqual(['at://d/xyz.fail/1'])
  expect(lines).toContainEqual(
    expect.objectContaining({ op: 'on_commit_error', uri: 'at://d/xyz.fail/1', error: 'commit hook failed' }),
  )
})

test('when push is enabled the hook gets the real delivery interface', async () => {
  push.enabled = true
  let ctx: any
  registerHook('on-commit', async (c: any) => void (ctx = c), { collections: ['xyz.push'] })
  fireOnCommitHooks([
    { action: 'create', collection: 'xyz.push', uri: 'at://d/xyz.push/1', authorDid: 'd', record: {} },
  ])
  await flush()
  push.enabled = false
  await ctx.push.send('did:plc:x', { title: 't' })
  expect(push.send).toHaveBeenCalledWith('did:plc:x', { title: 't' })
})

// --- loading on-login from disk ---

let dir: string
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('loadOnLoginHook leaves the current hook alone when the directory has none', async () => {
  const marker = vi.fn(async () => {})
  registerHook('on-login', marker)
  await loadOnLoginHook(join(tmpdir(), 'hatk-hooks-missing'))
  await fireOnLoginHook(ME, oauth)
  expect(marker).toHaveBeenCalledTimes(1)
})

test('loadOnLoginHook prefers on-login.ts over on-login.js', async () => {
  dir = await mkdtemp(join(tmpdir(), 'hatk-hooks-'))
  await writeFile(join(dir, 'on-login.js'), `export default async () => { globalThis.__loginHookRan = 'js' }\n`)
  await loadOnLoginHook(dir)
  await fireOnLoginHook(ME, oauth)
  expect((globalThis as any).__loginHookRan).toBe('js')

  await writeFile(join(dir, 'on-login.ts'), `export default async () => { globalThis.__loginHookRan = 'ts' }\n`)
  await loadOnLoginHook(dir)
  await fireOnLoginHook(ME, oauth)
  expect((globalThis as any).__loginHookRan).toBe('ts')
})

test('a hook file default-exporting defineHook() runs, as the documented contract promises', async () => {
  const hookDir = await mkdtemp(join(tmpdir(), 'hatk-hooks-defined-'))
  try {
    // The shape `defineHook('on-login', ...)` actually returns: an object with
    // the handler on it, not the handler itself.
    await writeFile(
      join(hookDir, 'on-login.js'),
      `export default { __type: 'hook', event: 'on-login', handler: async (ctx) => { globalThis.__loginHookDid = ctx.did } }\n`,
    )
    delete (globalThis as any).__loginHookDid
    const { lines, restore } = captureEmits()
    await loadOnLoginHook(hookDir)
    await fireOnLoginHook(ME, oauth)
    restore()
    expect((globalThis as any).__loginHookDid).toBe(ME)
    // Nothing blew up quietly inside the hook either.
    expect(lines).not.toContainEqual(expect.objectContaining({ op: 'on_login_error' }))
  } finally {
    await rm(hookDir, { recursive: true, force: true })
  }
})

test('a hook file whose default export is neither shape is reported instead of installed', async () => {
  const hookDir = await mkdtemp(join(tmpdir(), 'hatk-hooks-bad-'))
  try {
    await writeFile(join(hookDir, 'on-login.js'), `export default { nothing: true }\n`)
    const marker = vi.fn(async () => {})
    registerHook('on-login', marker)
    const { lines, restore } = captureEmits()
    await loadOnLoginHook(hookDir)
    await fireOnLoginHook(ME, oauth)
    restore()
    expect(lines).toContainEqual(expect.objectContaining({ module: 'hooks', op: 'on_login_load_error' }))
    // The previously registered hook is left in place rather than replaced by
    // something that could never be called.
    expect(marker).toHaveBeenCalledTimes(1)
  } finally {
    await rm(hookDir, { recursive: true, force: true })
  }
})
