import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createHandler } from '../src/server.ts'
import { registerLabelModule } from '../src/labels.ts'
import { rebuildAllIndexes } from '../src/database/fts.ts'
import {
  getRepoStatus,
  getSchema,
  insertRecord,
  insertReport,
  queryLabelsForUris,
  runSQL,
  setRepoStatus,
} from '../src/database/db.ts'
import { setupFixtureDatabase, PRIVATE_COLLECTION, PUBLIC_COLLECTION } from './fixture.ts'

// The /admin API is the moderation and operations console. Everything behind
// it must be gated on an admin viewer, and each action has to be visible
// through the read endpoints that the console refreshes afterwards.

const backfill = vi.hoisted(() => ({ triggerAutoBackfill: vi.fn(async () => {}) }))
vi.mock('../src/indexer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/indexer.ts')>()),
  ...backfill,
}))

const ADMIN = 'did:plc:admin'
const USER = 'did:plc:user'
const A1 = `at://${ADMIN}/${PUBLIC_COLLECTION}/a1`
const U1 = `at://${USER}/${PUBLIC_COLLECTION}/u1`
const U2 = `at://${USER}/${PRIVATE_COLLECTION}/u2`

let viewer: { did: string } | null = { did: ADMIN }

function handler(extra: { onResync?: () => void } = {}) {
  return createHandler({
    collections: [PUBLIC_COLLECTION, PRIVATE_COLLECTION],
    publicDir: null,
    oauth: null,
    admins: [ADMIN],
    resolveViewer: () => viewer,
    ...extra,
  })
}

const get = (path: string, headers?: Record<string, string>) =>
  handler()(new Request(`http://localhost${path}`, { headers }))
const post = (path: string, body: unknown, h = handler()) =>
  h(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) }))

beforeAll(async () => {
  await setupFixtureDatabase()
  await rebuildAllIndexes([PUBLIC_COLLECTION, PRIVATE_COLLECTION])
  await setRepoStatus(ADMIN, 'active', undefined, { handle: 'admin.test' })
  await setRepoStatus(USER, 'active', undefined, { handle: 'user.test' })
  // "Recent" means indexed after the repo's backfill; push the backfills into the past.
  await runSQL(`UPDATE _repos SET backfilled_at = '2000-01-01T00:00:00.000Z'`)
  await insertRecord(PUBLIC_COLLECTION, A1, 'ca1', ADMIN, { text: 'hello world' })
  await insertRecord(PUBLIC_COLLECTION, U1, 'cu1', USER, { text: 'goodbye world' })
  await insertRecord(PRIVATE_COLLECTION, U2, 'cu2', USER, { text: 'secret thing' })
  // Inserts in the same millisecond share an indexed_at; make the order explicit.
  const publicTable = getSchema(PUBLIC_COLLECTION)!.tableName
  const privateTable = getSchema(PRIVATE_COLLECTION)!.tableName
  await runSQL(`UPDATE ${publicTable} SET indexed_at = '2024-01-01T00:00:00.000Z' WHERE uri = $1`, [A1])
  await runSQL(`UPDATE ${publicTable} SET indexed_at = '2024-01-02T00:00:00.000Z' WHERE uri = $1`, [U1])
  await runSQL(`UPDATE ${privateTable} SET indexed_at = '2024-01-03T00:00:00.000Z' WHERE uri = $1`, [U2])
})

afterEach(() => {
  viewer = { did: ADMIN }
  delete process.env.DEV_MODE
})

// --- gating ---

test('admin endpoints reject anonymous callers with 401 and non-admins with 403', async () => {
  viewer = null
  expect((await get('/admin/whoami')).status).toBe(401)
  expect((await get('/admin/search?q=x')).status).toBe(401)

  viewer = { did: USER }
  expect((await get('/admin/whoami')).status).toBe(403)
  expect((await post('/admin/takedown', { did: USER })).status).toBe(403)
  expect(await getRepoStatus(USER)).toBe('active')
})

test('an admin is told so by whoami', async () => {
  expect(await (await get('/admin/whoami')).json()).toEqual({ did: ADMIN, admin: true })
})

test('in dev mode any signed-in viewer counts as an admin', async () => {
  process.env.DEV_MODE = '1'
  viewer = { did: USER }
  expect(await (await get('/admin/whoami')).json()).toEqual({ did: USER, admin: true })
  // But still not an anonymous one.
  viewer = null
  expect((await get('/admin/whoami')).status).toBe(401)
})

// --- labels ---

test('labels can be applied, negated and reset from the console', async () => {
  const def = { identifier: 'spam', severity: 'alert', blurs: 'content', defaultSetting: 'warn' } as const
  registerLabelModule('spam', { definition: def })
  expect(await (await get('/admin/labels/definitions')).json()).toEqual({ definitions: [def] })

  expect(await (await post('/admin/labels', { uri: A1 })).json()).toEqual({ error: 'Missing uri or val' })
  expect(await (await post('/admin/labels/negate', { val: 'spam' })).json()).toEqual({ error: 'Missing uri or val' })
  expect(await (await post('/admin/labels/reset', {})).json()).toEqual({ error: 'Missing val' })

  expect(await (await post('/admin/labels', { uri: A1, val: 'spam' })).json()).toEqual({ ok: true })
  expect((await queryLabelsForUris([A1])).get(A1)).toEqual([expect.objectContaining({ src: 'admin', val: 'spam' })])

  expect(await (await post('/admin/labels/negate', { uri: A1, val: 'spam' })).json()).toEqual({ ok: true })
  expect((await queryLabelsForUris([A1])).has(A1)).toBe(false)

  await post('/admin/labels', { uri: A1, val: 'spam' })
  await post('/admin/labels', { uri: U1, val: 'spam' })
  // Reset wipes the label's whole history — the two live rows plus the earlier
  // apply/negate pair on A1 — so the count is rows removed, not records affected.
  expect(await (await post('/admin/labels/reset', { val: 'spam' })).json()).toEqual({ deleted: 4 })
  expect(await queryLabelsForUris([A1, U1])).toEqual(new Map())
})

test('a rescan re-runs the rules over every stored record', async () => {
  registerLabelModule('world', {
    evaluate: async ({ record }) => (record.value.text.includes('world') ? ['world'] : []),
  })
  expect(await (await post('/admin/labels/rescan', {})).json()).toEqual({ scanned: 3, labeled: 2 })
  expect((await queryLabelsForUris([A1, U1, U2])).size).toBe(2)
  await runSQL(`DELETE FROM _labels`)
})

// --- takedowns ---

test('a takedown and its reversal flip the repo status', async () => {
  expect(await (await post('/admin/takedown', {})).json()).toEqual({ error: 'Missing did' })
  expect(await (await post('/admin/reverse-takedown', {})).json()).toEqual({ error: 'Missing did' })

  await post('/admin/takedown', { did: 'did:plc:td' })
  expect(await getRepoStatus('did:plc:td')).toBe('takendown')
  await post('/admin/reverse-takedown', { did: 'did:plc:td' })
  expect(await getRepoStatus('did:plc:td')).toBe('active')
})

// --- search ---

test('account search matches DID or handle substrings', async () => {
  const body = await (await get('/admin/search?type=accounts&q=user')).json()
  expect(body.accounts).toEqual([{ did: USER, handle: 'user.test', status: 'active' }])
})

test('an empty query lists live activity across every collection, newest first, with offset paging', async () => {
  const all = await (await get('/admin/search')).json()
  expect(all.total).toBe(3)
  expect(all.records.map((r: any) => r.uri)).toEqual([U2, U1, A1])
  expect(all.records[0]).toMatchObject({ value: { text: 'secret thing' }, labels: [] })

  const page = await (await get('/admin/search?limit=2')).json()
  expect(page.records).toHaveLength(2)
  const rest = await (await get('/admin/search?limit=2&offset=2')).json()
  expect(rest.records.map((r: any) => r.uri)).toEqual([A1])
})

test('an at:// query looks up that one record with its labels', async () => {
  await post('/admin/labels', { uri: U1, val: 'rude' })
  const found = await (await get(`/admin/search?q=${U1}`)).json()
  expect(found.records).toEqual([
    expect.objectContaining({ uri: U1, labels: [expect.objectContaining({ val: 'rude' })] }),
  ])
  await runSQL(`DELETE FROM _labels`)

  expect(await (await get(`/admin/search?q=at://${USER}/${PUBLIC_COLLECTION}/none`)).json()).toEqual({ records: [] })
})

test('a did: query returns everything that account wrote, across collections', async () => {
  const body = await (await get(`/admin/search?q=${USER}`)).json()
  expect(body.records.map((r: any) => r.uri).sort()).toEqual([U1, U2].sort())
})

test('any other query is a full-text search across collections', async () => {
  const body = await (await get('/admin/search?q=world')).json()
  expect(body.records.map((r: any) => r.uri).sort()).toEqual([A1, U1].sort())
  const none = await (await get('/admin/search?q=zzzznothing')).json()
  expect(none.records).toEqual([])
})

// --- repos ---

test('repos can be enrolled, inspected, listed and removed', async () => {
  expect(await (await post('/admin/repos/add', { dids: 'x' })).json()).toEqual({ error: 'Missing dids array' })
  expect(await (await post('/admin/repos/add', { dids: ['did:plc:r1'] })).json()).toEqual({ added: 1 })
  expect(await getRepoStatus('did:plc:r1')).toBe('pending')
  expect(backfill.triggerAutoBackfill).toHaveBeenCalledWith('did:plc:r1')

  expect((await get('/admin/info/did:plc:none')).status).toBe(404)
  await setRepoStatus('did:plc:r2', 'failed', undefined, { retryCount: 2, retryAfter: 123 })
  expect(await (await get('/admin/info/did:plc:r2')).json()).toEqual({
    did: 'did:plc:r2',
    status: 'failed',
    retry_count: 2,
    retry_after: 123,
  })

  const failed = await (await get('/admin/repos?status=failed')).json()
  expect(failed.repos.map((r: any) => r.did)).toEqual(['did:plc:r2'])
  expect(failed.total).toBe(1)
  const byHandle = await (await get('/admin/repos?q=admin.test')).json()
  expect(byHandle.repos.map((r: any) => r.did)).toEqual([ADMIN])
  const paged = await (await get('/admin/repos?limit=1&offset=1')).json()
  expect(paged.repos).toHaveLength(1)
  expect(paged.total).toBeGreaterThan(1)

  expect(await (await post('/admin/repos/remove', { dids: 'x' })).json()).toEqual({ error: 'Missing dids array' })
  expect(await (await post('/admin/repos/remove', { dids: ['did:plc:r1', 'did:plc:r2'] })).json()).toEqual({
    removed: 2,
  })
  expect(await getRepoStatus('did:plc:r1')).toBeNull()
})

test('a targeted resync backfills just those repos', async () => {
  const onResync = vi.fn()
  backfill.triggerAutoBackfill.mockClear()
  const res = await post('/admin/repos/resync', { dids: ['did:plc:t1'] }, handler({ onResync }))
  expect(await res.json()).toEqual({ resyncing: 1 })
  expect(await getRepoStatus('did:plc:t1')).toBe('pending')
  expect(backfill.triggerAutoBackfill).toHaveBeenCalledWith('did:plc:t1')
  expect(onResync).not.toHaveBeenCalled()
})

test('a blanket resync marks every active repo pending and hands off to onResync when provided', async () => {
  const onResync = vi.fn()
  backfill.triggerAutoBackfill.mockClear()
  await setRepoStatus('did:plc:t1', 'active')
  await setRepoStatus('did:plc:td', 'active')
  const active = ['did:plc:t1', 'did:plc:td', ADMIN, USER]

  const h = handler({ onResync })
  const res = await h(new Request('http://localhost/admin/repos/resync', { method: 'POST' }))
  expect(await res.json()).toEqual({ resyncing: active.length })
  for (const did of active) expect(await getRepoStatus(did)).toBe('pending')
  expect(onResync).toHaveBeenCalledTimes(1)
  expect(backfill.triggerAutoBackfill).not.toHaveBeenCalled()

  // Without onResync each repo is backfilled directly.
  for (const did of active) await setRepoStatus(did, 'active')
  await post('/admin/repos/resync', {})
  for (const did of active) expect(backfill.triggerAutoBackfill).toHaveBeenCalledWith(did)

  for (const did of [ADMIN, USER]) await setRepoStatus(did, 'active')
})

// --- reports ---

test('reports are listed by status and label, and resolving one applies the label', async () => {
  const spam = await insertReport({ subjectUri: A1, subjectDid: ADMIN, label: 'spam', reportedBy: USER })
  const nsfw = await insertReport({ subjectUri: U1, subjectDid: USER, label: 'nsfw', reportedBy: USER })

  const open = await (await get('/admin/reports')).json()
  expect(open.total).toBe(2)
  expect(open.reports.map((r: any) => r.label).sort()).toEqual(['nsfw', 'spam'])
  // The reporter's handle is joined in for display.
  expect(open.reports[0].reported_by_handle).toBe('user.test')
  expect((await (await get('/admin/reports?label=spam')).json()).total).toBe(1)
  expect((await (await get('/admin/info')).json()).openReports).toBe(2)

  expect(await (await post('/admin/reports/resolve', { id: spam.id })).json()).toEqual({
    error: 'Missing id or action',
  })
  expect(await (await post('/admin/reports/resolve', { id: spam.id, action: 'ignore' })).json()).toEqual({
    error: 'Action must be resolve or dismiss',
  })
  expect((await post('/admin/reports/resolve', { id: 9999, action: 'resolve' })).status).toBe(404)

  expect(await (await post('/admin/reports/resolve', { id: nsfw.id, action: 'dismiss' })).json()).toEqual({ ok: true })
  expect((await queryLabelsForUris([U1])).has(U1)).toBe(false)

  expect(await (await post('/admin/reports/resolve', { id: spam.id, action: 'resolve' })).json()).toEqual({ ok: true })
  expect((await queryLabelsForUris([A1])).get(A1)).toEqual([expect.objectContaining({ src: 'admin', val: 'spam' })])

  // Already handled: cannot be resolved twice.
  expect((await post('/admin/reports/resolve', { id: spam.id, action: 'resolve' })).status).toBe(404)

  expect((await (await get('/admin/reports')).json()).total).toBe(0)
  expect((await (await get('/admin/reports?status=resolved')).json()).total).toBe(1)
  expect((await (await get('/admin/reports?status=dismissed')).json()).total).toBe(1)
  // The cached rollup was invalidated by the admin action.
  expect((await (await get('/admin/info')).json()).openReports).toBe(0)
})

test('/admin/info includes process memory figures', async () => {
  const body = await (await get('/admin/info')).json()
  for (const key of ['rss', 'heapUsed', 'heapTotal', 'external']) expect(body.node[key]).toMatch(/ MiB$/)
})

// --- bundled console assets ---

test('the console script is served with an ETag, revalidates with 304 and gzips on request', async () => {
  const plain = await get('/admin/admin-auth.js', { 'accept-encoding': 'identity' })
  expect(plain.status).toBe(200)
  expect(plain.headers.get('content-type')).toBe('application/javascript')
  expect(plain.headers.get('cache-control')).toBe('no-cache')
  expect(plain.headers.get('content-encoding')).toBeNull()
  const etag = plain.headers.get('etag')!
  expect(etag).toMatch(/^".+"$/)

  expect((await get('/admin/admin-auth.js', { 'if-none-match': etag })).status).toBe(304)

  const gz = await get('/admin/admin-auth.js', { 'accept-encoding': 'gzip' })
  expect(gz.headers.get('content-encoding')).toBe('gzip')
  expect(gz.headers.get('vary')).toBe('Accept-Encoding')
})

test('the console page is served at /admin with or without a trailing slash, to anyone', async () => {
  viewer = null
  for (const path of ['/admin', '/admin/']) {
    const res = await get(path, { 'accept-encoding': 'identity' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
  }
})
