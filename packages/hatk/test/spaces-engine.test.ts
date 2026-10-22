import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

const getSpaceCredential = vi.fn()
const forgetSpaceCredential = vi.fn()
const listSessionDids = vi.fn()

vi.mock('../src/spaces/credential.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/spaces/credential.ts')>('../src/spaces/credential.ts')
  return {
    ...actual,
    getSpaceCredential: (...args: unknown[]) => getSpaceCredential(...args),
    forgetSpaceCredential: (...args: unknown[]) => forgetSpaceCredential(...args),
  }
})
const indexer = vi.hoisted(() => ({ trackRepo: vi.fn(), noteReferencedRepos: vi.fn() }))
vi.mock('../src/indexer.ts', () => indexer)

vi.mock('../src/spaces/identity.ts', () => ({
  spaceHostEndpoint: async () => AUTHORITY_HOST,
  repoEndpoint: async (did: string) => `https://${did.replace(/[^a-z0-9]/gi, '')}.test`,
  kemKey: async (did: string) => writers[did]?.kemDid() ?? null,
  configureSpaceIdentity: vi.fn(),
  clearSpaceIdentityCache: vi.fn(),
}))
vi.mock('../src/oauth/db.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/oauth/db.ts')>('../src/oauth/db.ts')
  return { ...actual, listSessionDids: () => listSessionDids() }
})

const {
  collectionsForSpaceType,
  configureSpaceEngine,
  handleWriteNotice,
  reconcileAll,
  reconcileSpace,
  unwatchSpace,
  watchSpace,
} = await import('../src/spaces/engine.ts')
const { insertRecord, querySQL, runSQL } = await import('../src/database/db.ts')
const { storeLexicons } = await import('../src/database/schema.ts')
const { getSpaceRepo, getSpaceWatch, listSpaceRepos, putSpaceRepo, putSpaceWatch } =
  await import('../src/spaces/store.ts')
const { withReadableSpaces } = await import('../src/spaces/visibility.ts')
const {
  PRIVATE_COLLECTION,
  PUBLIC_COLLECTION,
  SPACE_AUTHORITY,
  SPACE_TYPE,
  SPACE_URI,
  fixtureLexicons,
  setupFixtureDatabase,
} = await import('./fixture.ts')
const { setPrivateCollections } = await import('../src/private-collections.ts')
const { FakeWriter } = await import('./space-host.ts')

const AUTHORITY_HOST = 'https://authority.test'
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const oauth = { issuer: 'https://appview.test', scopes: ['atproto'], clients: [] }

type Handler = (params: URLSearchParams, headers: Headers) => unknown
let routes: Record<string, Handler | Handler[]>
let calls: { nsid: string; params: Record<string, string>; headers: Headers }[]
let writers: Record<string, Awaited<ReturnType<typeof FakeWriter.create>>>

/** The writer a request names, as its own host would answer for them. */
const writerOf = (p: URLSearchParams) => writers[p.get('repo')!]

/** What every writer's host answers unless a test says otherwise. */
function hostRoutes(): Record<string, Handler> {
  return {
    getRepo: (p, h) => writerOf(p).getRepo(h),
    listRepoOps: (p, h) => writerOf(p).listRepoOps(h, p),
    getRecord: (p, h) => writerOf(p).getRecord(h, p),
  }
}

/**
 * A credential whose fetch answers from `routes` — one handler per XRPC
 * method, or a queue of handlers when a test needs successive pages.
 */
function fakeCredential(readerDid: string | null = ALICE) {
  return {
    space: SPACE_URI,
    readerDid,
    expiresAt: Date.now() + 3600_000,
    fetch: async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const headers = new Headers(init?.headers)
      // Routed by the method name alone; every one of these is com.atproto.space.*
      const nsid = url.pathname.split('/').pop()!.replace('com.atproto.space.', '')
      calls.push({ nsid, params: Object.fromEntries(url.searchParams), headers })
      const route = routes[nsid]
      const handler = Array.isArray(route) ? route.shift() : route
      if (!handler) return Response.json({ error: 'MethodNotImplemented' }, { status: 501 })
      const out = await handler(url.searchParams, headers)
      if (out instanceof Response) return out
      return Response.json(out as Record<string, unknown>)
    },
  }
}

/** Hold `writer` as read to where they are now, the way a full read leaves them. */
async function readTo(writer: Awaited<ReturnType<typeof FakeWriter.create>>) {
  const { RepoCommit } = await import('@atproto/space')
  const state = RepoCommit.fromRecords([...writer.records.values()] as any).setHash.state()
  await putSpaceRepo({
    space: SPACE_URI,
    did: writer.did,
    pds: null,
    rev: writer.rev,
    setHash: Buffer.from(state).toString('base64'),
  })
}

const spaceRecord = (writer: string, collection: string, rkey: string) => `${SPACE_URI}/${writer}/${collection}/${rkey}`

async function indexedUris(collection = PUBLIC_COLLECTION): Promise<string[]> {
  const rows = (await querySQL(`SELECT uri FROM "${collection}" ORDER BY uri`)) as { uri: string }[]
  return rows.map((r) => r.uri)
}

const watch = {
  space: SPACE_URI,
  authority: SPACE_AUTHORITY,
  spaceType: SPACE_TYPE,
  readerDid: null,
  registeredUntil: null,
  lastError: null,
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
})

beforeEach(async () => {
  setPrivateCollections([])
  configureSpaceEngine({
    oauth: oauth as any,
    types: new Set([SPACE_TYPE]),
    collections: new Set([PUBLIC_COLLECTION, PRIVATE_COLLECTION]),
  })
  await runSQL('DELETE FROM _space_watch')
  await runSQL('DELETE FROM _space_repos')
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  await runSQL(`DELETE FROM "${PRIVATE_COLLECTION}"`)
  calls = []
  writers = {
    [ALICE]: await FakeWriter.create(ALICE, SPACE_URI),
    [BOB]: await FakeWriter.create(BOB, SPACE_URI),
  }
  routes = hostRoutes()
  getSpaceCredential.mockReset()
  getSpaceCredential.mockImplementation(async () => fakeCredential())
  forgetSpaceCredential.mockReset()
  listSessionDids.mockReset()
  listSessionDids.mockResolvedValue([ALICE, BOB])
})

// --- Space types ---

test('a space type contributes only the collections this instance indexes', () => {
  // The lexicon declares a third collection hatk has no table for; a space may
  // name collections that are simply not this appview's business.
  expect(collectionsForSpaceType(SPACE_TYPE)).toEqual([PUBLIC_COLLECTION, PRIVATE_COLLECTION])
})

test('a private collection is not read out of a space either', () => {
  setPrivateCollections([PRIVATE_COLLECTION])
  expect(collectionsForSpaceType(SPACE_TYPE)).toEqual([PUBLIC_COLLECTION])
})

test('an unknown space type declares nothing', () => {
  expect(collectionsForSpaceType('not.a.space')).toEqual([])
})

test('a space of an unconfigured type is refused rather than followed', async () => {
  await expect(watchSpace('at://did:plc:x/space/other.type/self')).rejects.toThrow('Not an indexed space type')
  expect(await getSpaceWatch('at://did:plc:x/space/other.type/self')).toBeNull()
})

test('something that is not a space ref is refused', async () => {
  await expect(watchSpace('at://did:plc:x/app.bsky.feed.post/1')).rejects.toThrow('Not a space ref')
})

// --- First read ---

test('a space with no local state is read whole', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'one', { text: 'hello' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })

  await watchSpace(SPACE_URI)

  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'one')])
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe(writers[ALICE].rev)
  expect(calls.map((c) => c.nsid)).toContain('getRepo')
})

test('every read of a repo asks for a MAC with a key share of its own', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'one', { text: 'hello' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  await watchSpace(SPACE_URI)
  await writers[ALICE].put(PUBLIC_COLLECTION, 'two', { text: 'again' })
  await reconcileSpace({ ...watch })

  const asked = calls.filter((c) => c.nsid !== 'listRepos').map((c) => c.headers.get('atproto-space-want-mac'))
  expect(asked).toHaveLength(2)
  expect(asked[0]).toMatch(/^type="atproto-space-repo", ver=1, key_share="did:key:zDn/)
  expect(asked[0]).not.toBe(asked[1])
})

test('a repo whose archive does not match its MAC is not indexed', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'one', { text: 'hello' })
  const other = await FakeWriter.create(ALICE, SPACE_URI)
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  // Answered with a MAC from a key that is not the one ALICE publishes.
  routes.getRepo = (_p, h) => {
    for (const [k, v] of writers[ALICE].records) other.records.set(k, v)
    other.rev = writers[ALICE].rev
    return other.getRepo(h)
  }

  await expect(watchSpace(SPACE_URI)).rejects.toThrow('commit failed verification')
  expect(await indexedUris()).toEqual([])
})

test('an archive missing a record the commit covers is not indexed', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'one', { text: 'hello' })
  const commit = writers[ALICE].commit()
  await writers[ALICE].del(PUBLIC_COLLECTION, 'one')
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: commit.rev }] })
  routes.getRepo = (_p, h) => writers[ALICE].getRepo(h, commit)

  await expect(watchSpace(SPACE_URI)).rejects.toThrow('records do not match the commit data')
})

test('a record the lexicon refuses is skipped, not indexed', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'good', { text: 'fine' })
  await writers[ALICE].put(PUBLIC_COLLECTION, 'bad', { notText: 1 })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  await watchSpace(SPACE_URI)
  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'good')])
})

test('a writer the authority names but whose host holds no repo is not an error', async () => {
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: '3a' }] })
  routes.getRepo = () => Response.json({ error: 'RepoNotFound' }, { status: 400 })
  await watchSpace(SPACE_URI)
  expect(await indexedUris()).toEqual([])
  expect(await getSpaceRepo(SPACE_URI, ALICE)).toBeNull()
})

test('a full read keeps the set hash the next forward read starts from', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'one', { text: 'a' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  await watchSpace(SPACE_URI)
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.setHash).toMatch(/^[A-Za-z0-9+/]+=*$/)
})

test('records of collections outside the space type are left out', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'one', { text: 'a' })
  await writers[ALICE].put('app.bsky.feed.unindexed', 'x', { text: 'x' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  await watchSpace(SPACE_URI)
  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'one')])
})

test('every writer the space names is handed to the indexer as a repo to track', async () => {
  // A member's public profile is what names them on everything they wrote
  // into the space, and nothing they write there is a signal collection.
  indexer.trackRepo.mockClear()
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await writers[BOB].put(PUBLIC_COLLECTION, 'b', { text: 'b' })
  routes.listRepos = () => ({
    repos: [
      { did: ALICE, repoRev: writers[ALICE].rev },
      { did: BOB, repoRev: writers[BOB].rev },
    ],
  })
  await reconcileSpace(watch)
  expect(indexer.trackRepo.mock.calls.map((c) => c[0]).sort()).toEqual([ALICE, BOB].sort())
})

// --- Incremental ---

test('a writer already read is advanced through the op log, not re-read whole', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await writers[ALICE].put(PUBLIC_COLLECTION, 'old', { text: 'old' })
  await readTo(writers[ALICE])
  await writers[ALICE].put(PUBLIC_COLLECTION, 'new', { text: 'new' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })

  await reconcileSpace(watch)

  expect(calls.map((c) => c.nsid)).not.toContain('getRepo')
  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'new')])
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe(writers[ALICE].rev)
})

test('the op log is asked for everything after the revision we hold', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await readTo(writers[ALICE])
  const held = writers[ALICE].rev
  await writers[ALICE].put(PUBLIC_COLLECTION, 'b', { text: 'b' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  await reconcileSpace(watch)
  expect(calls.find((c) => c.nsid === 'listRepoOps')?.params.since).toBe(held)
})

test('a writer held without a set hash is read whole', async () => {
  // Nothing to fold ops into, so nothing to check them against.
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  await reconcileSpace(watch)
  expect(calls.map((c) => c.nsid)).toContain('getRepo')
  expect(calls.map((c) => c.nsid)).not.toContain('listRepoOps')
})

test('an op with no cid is a delete', async () => {
  // Ops carry no action: a create has no prev, a delete no cid, an update both.
  await writers[ALICE].put(PUBLIC_COLLECTION, 'gone', { text: 'old' })
  await readTo(writers[ALICE])
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(ALICE, PUBLIC_COLLECTION, 'gone'), 'c0', ALICE, { text: 'old' })
  await writers[ALICE].del(PUBLIC_COLLECTION, 'gone')
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([])
})

test('only the last op for a record is applied', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'keep', { text: 'keep' })
  await readTo(writers[ALICE])
  const created = await writers[ALICE].put(PUBLIC_COLLECTION, 'x', { text: 'first' })
  await writers[ALICE].del(PUBLIC_COLLECTION, 'x')
  // Superseded, so served without its value.
  delete created.value
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([])
  expect(calls.map((c) => c.nsid)).not.toContain('getRecord')
})

test('an op whose value was superseded is fetched, MAC and all', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'x', { text: 'old' })
  await readTo(writers[ALICE])
  const op = await writers[ALICE].put(PUBLIC_COLLECTION, 'x', { text: 'current' })
  delete op.value
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })

  await reconcileSpace(watch)

  const fetched = calls.find((c) => c.nsid === 'getRecord')
  expect(fetched?.headers.get('atproto-space-want-mac')).toMatch(/^type="atproto-space-record", ver=1/)
  const rows = (await querySQL(`SELECT text FROM "${PUBLIC_COLLECTION}"`)) as { text: string }[]
  expect(rows[0].text).toBe('current')
})

test('a fetched record whose MAC does not verify is not indexed', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'x', { text: 'old' })
  await readTo(writers[ALICE])
  const op = await writers[ALICE].put(PUBLIC_COLLECTION, 'x', { text: 'current' })
  delete op.value
  const impostor = await FakeWriter.create(ALICE, SPACE_URI)
  await impostor.put(PUBLIC_COLLECTION, 'x', { text: 'current' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  routes.getRecord = (p, h) => impostor.getRecord(h, p)
  // The fallback full read is refused too, so the failure surfaces.
  routes.getRepo = () => Response.json({ error: 'InternalServerError' }, { status: 500 })

  await expect(reconcileSpace(watch)).rejects.toThrow()
  expect(await indexedUris()).toEqual([])
})

test('an op whose record has since vanished becomes a delete', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'x', { text: 'old' })
  await readTo(writers[ALICE])
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(ALICE, PUBLIC_COLLECTION, 'x'), 'c1', ALICE, { text: 'old' })
  const op = await writers[ALICE].put(PUBLIC_COLLECTION, 'x', { text: 'newer' })
  delete op.value
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  routes.getRecord = () => Response.json({ error: 'RecordNotFound' }, { status: 400 })

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([])
})

test('ops for collections outside the space type are ignored', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await readTo(writers[ALICE])
  await writers[ALICE].put('app.bsky.feed.unindexed', 'x', { text: 'x' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  await reconcileSpace(watch)
  expect(await indexedUris()).toEqual([])
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe(writers[ALICE].rev)
})

test('the op log is paged until it reaches the head', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'zero', { text: '0' })
  await readTo(writers[ALICE])
  const one = await writers[ALICE].put(PUBLIC_COLLECTION, 'one', { text: 'a' })
  const two = await writers[ALICE].put(PUBLIC_COLLECTION, 'two', { text: 'b' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  routes.listRepoOps = [
    (p, h) => writers[ALICE].listRepoOps(h, p, { ops: [one], cursor: 'more' }),
    (p, h) => writers[ALICE].listRepoOps(h, p, { ops: [two] }),
  ]

  await reconcileSpace(watch)

  expect(await indexedUris()).toHaveLength(2)
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe(writers[ALICE].rev)
  const shares = calls.filter((c) => c.nsid === 'listRepoOps').map((c) => c.headers.get('atproto-space-want-mac'))
  expect(new Set(shares).size).toBe(2)
})

test('ops that do not add up to the commit are not applied', async () => {
  // A host that leaves an op out serves a repo the commit does not describe.
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await readTo(writers[ALICE])
  await writers[ALICE].put(PUBLIC_COLLECTION, 'b', { text: 'b' })
  await writers[ALICE].put(PUBLIC_COLLECTION, 'c', { text: 'c' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  routes.listRepoOps = (p, h) => writers[ALICE].listRepoOps(h, p, { ops: writers[ALICE].log.slice(-1) })

  await reconcileSpace(watch)

  // Read whole instead, so both arrive.
  expect(calls.map((c) => c.nsid)).toContain('getRepo')
  expect(await indexedUris()).toEqual([
    spaceRecord(ALICE, PUBLIC_COLLECTION, 'a'),
    spaceRecord(ALICE, PUBLIC_COLLECTION, 'b'),
    spaceRecord(ALICE, PUBLIC_COLLECTION, 'c'),
  ])
})

test('an inlined value that is not the record its cid names is refused', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await readTo(writers[ALICE])
  const op = await writers[ALICE].put(PUBLIC_COLLECTION, 'b', { text: 'real' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  routes.listRepoOps = (p, h) =>
    writers[ALICE].listRepoOps(h, p, { ops: [{ ...op, value: { $type: PUBLIC_COLLECTION, text: 'forged' } }] })

  await reconcileSpace(watch)

  const rows = (await querySQL(`SELECT text FROM "${PUBLIC_COLLECTION}" ORDER BY uri`)) as { text: string }[]
  expect(rows.map((r) => r.text)).toEqual(['a', 'real'])
})

test('a commit without a valid MAC is not trusted', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await readTo(writers[ALICE])
  await writers[ALICE].put(PUBLIC_COLLECTION, 'b', { text: 'b' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  routes.listRepoOps = (p, h) => {
    const res = writers[ALICE].listRepoOps(h, p)
    const headers = new Headers(res.headers)
    headers.delete('atproto-space-mac')
    return new Response(res.body, { headers })
  }

  await reconcileSpace(watch)

  // Fell back to the archive, which carries one.
  expect(calls.map((c) => c.nsid)).toContain('getRepo')
})

test('an op log that cannot carry us forward falls back to a full read', async () => {
  // The log is a transport optimization with no history guarantee: a host may
  // compact past our position, and the answer then is a full read, not a gap.
  await writers[ALICE].put(PUBLIC_COLLECTION, 'recovered', { text: 'whole' })
  await readTo(writers[ALICE])
  await writers[ALICE].put(PUBLIC_COLLECTION, 'later', { text: 'later' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  routes.listRepoOps = () => Response.json({ error: 'InvalidRequest', message: 'since too old' }, { status: 400 })

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([
    spaceRecord(ALICE, PUBLIC_COLLECTION, 'later'),
    spaceRecord(ALICE, PUBLIC_COLLECTION, 'recovered'),
  ])
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe(writers[ALICE].rev)
})

test('a full read replaces what the writer held rather than merging into it', async () => {
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(ALICE, PUBLIC_COLLECTION, 'stale'), 'c0', ALICE, { text: 'old' })
  await writers[ALICE].put(PUBLIC_COLLECTION, 'fresh', { text: 'new' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'fresh')])
})

// --- Reconcile ---

test('a writer whose revision has not moved is not read again', async () => {
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: '3a' }] })

  await reconcileSpace(watch)

  expect(calls.map((c) => c.nsid)).toEqual(['listRepos'])
})

test('the writer set is paged', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await writers[BOB].put(PUBLIC_COLLECTION, 'b', { text: 'b' })
  routes.listRepos = [
    () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }], cursor: 'more' }),
    () => ({ repos: [{ did: BOB, repoRev: writers[BOB].rev }] }),
  ]

  await reconcileSpace(watch)

  expect((await listSpaceRepos(SPACE_URI)).map((r) => r.did).sort()).toEqual([ALICE, BOB])
  expect(calls.filter((c) => c.nsid === 'getRepo')).toHaveLength(2)
})

test('a writer the space no longer names has their rows dropped', async () => {
  // Ejection is exactly this: the authority stops naming them, and what they
  // wrote stops being readable through the space.
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(BOB, PUBLIC_COLLECTION, 'bye'), 'c1', BOB, { text: 'bob' })
  await putSpaceRepo({ space: SPACE_URI, did: BOB, pds: null, rev: '3a' })
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: '3a' }] })

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([])
  expect((await listSpaceRepos(SPACE_URI)).map((r) => r.did)).toEqual([ALICE])
})

test('dropping a departed writer leaves their public repo records alone', async () => {
  const publicUri = `at://${BOB}/${PUBLIC_COLLECTION}/mine`
  await insertRecord(PUBLIC_COLLECTION, publicUri, 'c0', BOB, { text: 'public' })
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(BOB, PUBLIC_COLLECTION, 'bye'), 'c1', BOB, { text: 'private' })
  await putSpaceRepo({ space: SPACE_URI, did: BOB, pds: null, rev: '3a' })
  routes.listRepos = () => ({ repos: [] })

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([publicUri])
})

test('the reader that worked is remembered and tried first next time', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  getSpaceCredential.mockImplementation(async () => fakeCredential(BOB))
  routes.listRepos = () => ({ repos: [] })

  await reconcileSpace({ ...watch })
  expect((await getSpaceWatch(SPACE_URI))?.readerDid).toBe(BOB)

  const stored = (await getSpaceWatch(SPACE_URI))!
  await reconcileSpace(stored)
  expect(getSpaceCredential.mock.calls[1][2][0]).toBe(BOB)
})

test('an expired credential is re-minted once and the read repeated', async () => {
  // A credential lives two hours and a sweep can outlive one; treating the
  // expiry as a failure would make a readable space look unreadable.
  let first = true
  getSpaceCredential.mockImplementation(async () => {
    if (first) {
      first = false
      return {
        ...fakeCredential(),
        fetch: async () => Response.json({ error: 'InvalidToken' }, { status: 401 }),
      }
    }
    return fakeCredential()
  })
  routes.listRepos = () => ({ repos: [] })

  await reconcileSpace(watch)

  expect(forgetSpaceCredential).toHaveBeenCalledWith(SPACE_URI)
  expect(getSpaceCredential).toHaveBeenCalledTimes(2)
})

// --- Sweep ---

test('a sweep records a failure against the space instead of throwing', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  getSpaceCredential.mockRejectedValue(new Error('host unreachable'))

  await reconcileAll()

  expect((await getSpaceWatch(SPACE_URI))?.lastError).toBe('host unreachable')
})

test('a successful sweep clears the last failure', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  getSpaceCredential.mockRejectedValueOnce(new Error('boom'))
  await reconcileAll()
  routes.listRepos = () => ({ repos: [] })
  await reconcileAll()
  expect((await getSpaceWatch(SPACE_URI))?.lastError).toBeNull()
})

test('one unreachable space does not stop the others', async () => {
  const other = `at://did:plc:second/space/${SPACE_TYPE}/self`
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await putSpaceWatch({ space: other, authority: 'did:plc:second', spaceType: SPACE_TYPE })
  getSpaceCredential.mockImplementation(async (_o: unknown, space: string) => {
    if (space === SPACE_URI) throw new Error('down')
    return fakeCredential()
  })
  routes.listRepos = () => ({ repos: [] })

  await reconcileAll()

  expect((await getSpaceWatch(SPACE_URI))?.lastError).toBe('down')
  expect((await getSpaceWatch(other))?.lastError).toBeNull()
})

test('a space the authority has deleted is stopped following and its rows dropped', async () => {
  const { SpaceCredentialError } = await import('../src/spaces/credential.ts')
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(ALICE, PUBLIC_COLLECTION, 'x'), 'c1', ALICE, { text: 'x' })
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  getSpaceCredential.mockRejectedValue(new SpaceCredentialError(400, 'SpaceDeleted', 'gone'))

  await reconcileAll()

  expect(await getSpaceWatch(SPACE_URI)).toBeNull()
  expect(await indexedUris()).toEqual([])
})

test('unwatching drops the space rows and keeps the public ones', async () => {
  const publicUri = `at://${ALICE}/${PUBLIC_COLLECTION}/mine`
  await insertRecord(PUBLIC_COLLECTION, publicUri, 'c0', ALICE, { text: 'public' })
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(ALICE, PUBLIC_COLLECTION, 'x'), 'c1', ALICE, { text: 'x' })
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })

  await unwatchSpace(SPACE_URI)

  expect(await indexedUris()).toEqual([publicUri])
  expect(await getSpaceWatch(SPACE_URI)).toBeNull()
})

test('unwatching a space never followed is harmless', async () => {
  await expect(unwatchSpace(SPACE_URI)).resolves.toBeUndefined()
})

// --- What a synced row is ---

test('a synced record is stored under its space and served only in scope', async () => {
  await writers[ALICE].put(PUBLIC_COLLECTION, 'one', { text: 'members only' })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })
  await watchSpace(SPACE_URI)

  const { getRecordByUri } = await import('../src/database/db.ts')
  const uri = spaceRecord(ALICE, PUBLIC_COLLECTION, 'one')
  expect(await getRecordByUri(uri)).toBeNull()
  const row = await withReadableSpaces([SPACE_URI], () => getRecordByUri(uri))
  expect(row?.space).toBe(SPACE_URI)
  expect(row?.did).toBe(ALICE)
})

// --- Write notices ---

const SERVICE_ID = 'did:web:appview.test#atproto_space_syncer'

function withService() {
  configureSpaceEngine({
    oauth: oauth as any,
    types: new Set([SPACE_TYPE]),
    collections: new Set([PUBLIC_COLLECTION, PRIVATE_COLLECTION]),
    serviceId: SERVICE_ID,
  })
}

test('an instance that receives notices subscribes while it has a credential in hand', async () => {
  // registerNotify is authenticated with the space credential, so only somebody
  // the authority already admits can subscribe — which is why it happens inside
  // reconcile rather than on its own.
  withService()
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  routes.registerNotify = () => ({ expiresAt: '2030-01-01T00:00:00.000Z' })
  routes.listRepos = () => ({ repos: [] })

  await reconcileSpace({ ...watch })

  expect(calls.map((c) => c.nsid)).toContain('registerNotify')
  expect((await getSpaceWatch(SPACE_URI))?.registeredUntil).toBe('2030-01-01T00:00:00.000Z')
})

test('a registration still well inside its life is not renewed', async () => {
  withService()
  const far = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString()
  routes.listRepos = () => ({ repos: [] })
  await reconcileSpace({ ...watch, registeredUntil: far })
  expect(calls.map((c) => c.nsid)).not.toContain('registerNotify')
})

test('a registration close to lapsing is renewed before it does', async () => {
  // A lapsed one stops notices silently: the sweep carries on working and
  // nobody notices the latency went back up.
  withService()
  const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  routes.registerNotify = () => ({ expiresAt: '2030-01-01T00:00:00.000Z' })
  routes.listRepos = () => ({ repos: [] })
  await reconcileSpace({ ...watch, registeredUntil: soon })
  expect(calls.map((c) => c.nsid)).toContain('registerNotify')
})

test('failing to subscribe costs latency, not the sweep', async () => {
  withService()
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  routes.registerNotify = () => Response.json({ error: 'ServiceNotResolvable' }, { status: 400 })
  routes.listRepos = () => ({ repos: [{ did: ALICE, repoRev: writers[ALICE].rev }] })

  await reconcileSpace({ ...watch })

  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe(writers[ALICE].rev)
})

test('an instance that receives no notices never subscribes', async () => {
  routes.listRepos = () => ({ repos: [] })
  await reconcileSpace({ ...watch })
  expect(calls.map((c) => c.nsid)).not.toContain('registerNotify')
})

test('a notice reads the one repo it names', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await writers[ALICE].put(PUBLIC_COLLECTION, 'fresh', { text: 'just written' })

  expect(await handleWriteNotice({ space: SPACE_URI, repo: ALICE })).toBe(true)

  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'fresh')])
  // The writer set is not re-listed: a notice names its repo, so there is
  // nothing to enumerate.
  expect(calls.map((c) => c.nsid)).not.toContain('listRepos')
})

test('a notice about a space this instance does not follow is ignored', async () => {
  // Not an instruction to start following it: that decision belongs to config
  // or to the app, never to whoever can reach the endpoint.
  expect(await handleWriteNotice({ space: SPACE_URI, repo: ALICE })).toBe(false)
  expect(calls).toEqual([])
})

test('the revision a notice claims is not trusted as the new position', async () => {
  // It is read from the repo's own host, which is the source of truth.
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await writers[ALICE].put(PUBLIC_COLLECTION, 'a', { text: 'a' })
  await handleWriteNotice({ space: SPACE_URI, repo: ALICE })
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe(writers[ALICE].rev)
})
