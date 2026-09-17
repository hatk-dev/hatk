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
vi.mock('../src/spaces/identity.ts', () => ({
  spaceHostEndpoint: async () => AUTHORITY_HOST,
  repoEndpoint: async (did: string) => `https://${did.replace(/[^a-z0-9]/gi, '')}.test`,
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

const AUTHORITY_HOST = 'https://authority.test'
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const oauth = { issuer: 'https://appview.test', scopes: ['atproto'], clients: [] }

type Handler = (params: URLSearchParams) => unknown
let routes: Record<string, Handler | Handler[]>
let calls: { nsid: string; params: Record<string, string> }[]

/**
 * A credential whose fetch answers from `routes` — one handler per XRPC
 * method, or a queue of handlers when a test needs successive pages.
 */
function fakeCredential(readerDid = ALICE) {
  return {
    space: SPACE_URI,
    readerDid,
    expiresAt: Date.now() + 3600_000,
    fetch: async (input: string | URL) => {
      const url = new URL(input.toString())
      // Routed by the method name alone; every one of these is com.atproto.space.*
      const nsid = url.pathname.split('/').pop()!.replace('com.atproto.space.', '')
      calls.push({ nsid, params: Object.fromEntries(url.searchParams) })
      const route = routes[nsid]
      const handler = Array.isArray(route) ? route.shift() : route
      if (!handler) return Response.json({ error: 'MethodNotImplemented' }, { status: 501 })
      const out = handler(url.searchParams)
      if (out instanceof Response) return out
      return Response.json(out as Record<string, unknown>)
    },
  }
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
  routes = {}
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
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: (p) =>
      p.get('collection') === PUBLIC_COLLECTION
        ? { records: [{ rkey: 'one', cid: 'cid-one', value: { text: 'hello' } }] }
        : { records: [] },
  }

  await watchSpace(SPACE_URI)

  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'one')])
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe('3a')
})

test('the revision is taken before the read, not after', async () => {
  // A write landing mid-read is then re-read on the next sweep rather than
  // skipped, which is the direction to be wrong in.
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: () => ({ records: [] }),
  }
  await watchSpace(SPACE_URI)
  const order = calls.map((c) => c.nsid)
  expect(order.indexOf('getLatestCommit')).toBeLessThan(order.indexOf('listRecords'))
})

test('a record the lexicon refuses is skipped, not indexed', async () => {
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: (p) =>
      p.get('collection') === PUBLIC_COLLECTION
        ? {
            records: [
              { rkey: 'good', cid: 'c1', value: { text: 'fine' } },
              { rkey: 'bad', cid: 'c2', value: { notText: 1 } },
            ],
          }
        : { records: [] },
  }
  await watchSpace(SPACE_URI)
  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'good')])
})

test('a writer the authority names but whose host holds no repo is not an error', async () => {
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => Response.json({ error: 'RepoNotFound' }, { status: 404 }),
  }
  await watchSpace(SPACE_URI)
  expect(await indexedUris()).toEqual([])
  expect(await getSpaceRepo(SPACE_URI, ALICE)).toBeNull()
})

test('a collection the writer has never written is not a failure', async () => {
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: [
      () => ({ records: [{ rkey: 'one', cid: 'c1', value: { text: 'hi' } }] }),
      () => Response.json({ error: 'RepoNotFound' }, { status: 404 }),
    ],
  }
  await watchSpace(SPACE_URI)
  expect(await indexedUris()).toHaveLength(1)
})

test('a full read pages until the cursor runs out', async () => {
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: (p) => {
      if (p.get('collection') !== PUBLIC_COLLECTION) return { records: [] }
      return p.get('cursor')
        ? { records: [{ rkey: 'two', cid: 'c2', value: { text: 'b' } }] }
        : { records: [{ rkey: 'one', cid: 'c1', value: { text: 'a' } }], cursor: 'next' }
    },
  }
  await watchSpace(SPACE_URI)
  expect(await indexedUris()).toEqual([
    spaceRecord(ALICE, PUBLIC_COLLECTION, 'one'),
    spaceRecord(ALICE, PUBLIC_COLLECTION, 'two'),
  ])
})

// --- Incremental ---

test('a writer already read is advanced through the op log, not re-read whole', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3b' }] }),
    listRepoOps: () => ({
      ops: [{ rev: '3b', collection: PUBLIC_COLLECTION, rkey: 'new', cid: 'c1', prev: null, value: { text: 'new' } }],
      commit: { rev: '3b' },
    }),
  }

  await reconcileSpace(watch)

  expect(calls.map((c) => c.nsid)).not.toContain('listRecords')
  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'new')])
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe('3b')
})

test('the op log is asked for everything after the revision we hold', async () => {
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3b' }] }),
    listRepoOps: () => ({ ops: [], commit: { rev: '3b' } }),
  }
  await reconcileSpace(watch)
  expect(calls.find((c) => c.nsid === 'listRepoOps')?.params.since).toBe('3a')
})

test('an op with no cid is a delete', async () => {
  // Ops carry no action: a create has no prev, a delete no cid, an update both.
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(ALICE, PUBLIC_COLLECTION, 'gone'), 'c0', ALICE, { text: 'old' })
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3b' }] }),
    listRepoOps: () => ({
      ops: [{ rev: '3b', collection: PUBLIC_COLLECTION, rkey: 'gone', cid: null, prev: 'c0' }],
      commit: { rev: '3b' },
    }),
  }

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([])
})

test('only the last op for a record in a page is applied', async () => {
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3c' }] }),
    listRepoOps: () => ({
      ops: [
        { rev: '3b', collection: PUBLIC_COLLECTION, rkey: 'x', cid: 'c1', prev: null, value: { text: 'first' } },
        { rev: '3c', collection: PUBLIC_COLLECTION, rkey: 'x', cid: null, prev: 'c1' },
      ],
      commit: { rev: '3c' },
    }),
  }

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([])
})

test('an op whose value was superseded is fetched rather than guessed', async () => {
  // A value is inlined only while it is still current, so an op overtaken
  // later in the same page arrives without one.
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3b' }] }),
    listRepoOps: () => ({
      ops: [{ rev: '3b', collection: PUBLIC_COLLECTION, rkey: 'x', cid: 'c2', prev: 'c1' }],
      commit: { rev: '3b' },
    }),
    getRecord: () => ({ value: { text: 'current' } }),
  }

  await reconcileSpace(watch)

  expect(calls.map((c) => c.nsid)).toContain('getRecord')
  const rows = (await querySQL(`SELECT text FROM "${PUBLIC_COLLECTION}"`)) as { text: string }[]
  expect(rows[0].text).toBe('current')
})

test('an op whose record has since vanished becomes a delete', async () => {
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(ALICE, PUBLIC_COLLECTION, 'x'), 'c1', ALICE, { text: 'old' })
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3b' }] }),
    listRepoOps: () => ({
      ops: [{ rev: '3b', collection: PUBLIC_COLLECTION, rkey: 'x', cid: 'c2', prev: 'c1' }],
      commit: { rev: '3b' },
    }),
    getRecord: () => Response.json({ error: 'RecordNotFound' }, { status: 404 }),
  }

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([])
})

test('ops for collections outside the space type are ignored', async () => {
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3b' }] }),
    listRepoOps: () => ({
      ops: [
        { rev: '3b', collection: 'app.bsky.feed.unindexed', rkey: 'x', cid: 'c1', prev: null, value: { text: 'x' } },
      ],
      commit: { rev: '3b' },
    }),
  }
  await reconcileSpace(watch)
  expect(await indexedUris()).toEqual([])
})

test('the op log is paged until it reaches the head', async () => {
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3c' }] }),
    listRepoOps: [
      () => ({
        ops: [{ rev: '3b', collection: PUBLIC_COLLECTION, rkey: 'one', cid: 'c1', prev: null, value: { text: 'a' } }],
        cursor: 'more',
      }),
      () => ({
        ops: [{ rev: '3c', collection: PUBLIC_COLLECTION, rkey: 'two', cid: 'c2', prev: null, value: { text: 'b' } }],
        commit: { rev: '3c' },
      }),
    ],
  }

  await reconcileSpace(watch)

  expect(await indexedUris()).toHaveLength(2)
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe('3c')
})

test('an op log that cannot carry us forward falls back to a full read', async () => {
  // The log is a transport optimization with no history guarantee: a host may
  // compact past our position, and the answer then is a full read, not a gap.
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3b' }] }),
    listRepoOps: () => Response.json({ error: 'InvalidRequest', message: 'since too old' }, { status: 400 }),
    getLatestCommit: () => ({ commit: { rev: '3b' } }),
    listRecords: (p) =>
      p.get('collection') === PUBLIC_COLLECTION
        ? { records: [{ rkey: 'recovered', cid: 'c9', value: { text: 'whole' } }] }
        : { records: [] },
  }

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'recovered')])
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe('3b')
})

test('a full read replaces what the writer held rather than merging into it', async () => {
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(ALICE, PUBLIC_COLLECTION, 'stale'), 'c0', ALICE, { text: 'old' })
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: (p) =>
      p.get('collection') === PUBLIC_COLLECTION
        ? { records: [{ rkey: 'fresh', cid: 'c1', value: { text: 'new' } }] }
        : { records: [] },
  }

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([spaceRecord(ALICE, PUBLIC_COLLECTION, 'fresh')])
})

// --- Reconcile ---

test('a writer whose revision has not moved is not read again', async () => {
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = { listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }) }

  await reconcileSpace(watch)

  expect(calls.map((c) => c.nsid)).toEqual(['listRepos'])
})

test('the writer set is paged', async () => {
  routes = {
    listRepos: [
      () => ({ repos: [{ did: ALICE, rev: '3a' }], cursor: 'more' }),
      () => ({ repos: [{ did: BOB, rev: '3a' }] }),
    ],
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: () => ({ records: [] }),
  }

  await reconcileSpace(watch)

  expect((await listSpaceRepos(SPACE_URI)).map((r) => r.did).sort()).toEqual([ALICE, BOB])
  expect(calls.filter((c) => c.nsid === 'getLatestCommit')).toHaveLength(2)
})

test('a writer the space no longer names has their rows dropped', async () => {
  // Ejection is exactly this: the authority stops naming them, and what they
  // wrote stops being readable through the space.
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(BOB, PUBLIC_COLLECTION, 'bye'), 'c1', BOB, { text: 'bob' })
  await putSpaceRepo({ space: SPACE_URI, did: BOB, pds: null, rev: '3a' })
  await putSpaceRepo({ space: SPACE_URI, did: ALICE, pds: null, rev: '3a' })
  routes = { listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }) }

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([])
  expect((await listSpaceRepos(SPACE_URI)).map((r) => r.did)).toEqual([ALICE])
})

test('dropping a departed writer leaves their public repo records alone', async () => {
  const publicUri = `at://${BOB}/${PUBLIC_COLLECTION}/mine`
  await insertRecord(PUBLIC_COLLECTION, publicUri, 'c0', BOB, { text: 'public' })
  await insertRecord(PUBLIC_COLLECTION, spaceRecord(BOB, PUBLIC_COLLECTION, 'bye'), 'c1', BOB, { text: 'private' })
  await putSpaceRepo({ space: SPACE_URI, did: BOB, pds: null, rev: '3a' })
  routes = { listRepos: () => ({ repos: [] }) }

  await reconcileSpace(watch)

  expect(await indexedUris()).toEqual([publicUri])
})

test('the reader that worked is remembered and tried first next time', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  getSpaceCredential.mockImplementation(async () => fakeCredential(BOB))
  routes = { listRepos: () => ({ repos: [] }) }

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
  routes = { listRepos: () => ({ repos: [] }) }

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
  routes = { listRepos: () => ({ repos: [] }) }
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
  routes = { listRepos: () => ({ repos: [] }) }

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
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: (p) =>
      p.get('collection') === PUBLIC_COLLECTION
        ? { records: [{ rkey: 'one', cid: 'c1', value: { text: 'members only' } }] }
        : { records: [] },
  }
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
  routes = {
    registerNotify: () => ({ expiresAt: '2030-01-01T00:00:00.000Z' }),
    listRepos: () => ({ repos: [] }),
  }

  await reconcileSpace({ ...watch })

  expect(calls.map((c) => c.nsid)).toContain('registerNotify')
  expect((await getSpaceWatch(SPACE_URI))?.registeredUntil).toBe('2030-01-01T00:00:00.000Z')
})

test('a registration still well inside its life is not renewed', async () => {
  withService()
  const far = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString()
  routes = { listRepos: () => ({ repos: [] }) }
  await reconcileSpace({ ...watch, registeredUntil: far })
  expect(calls.map((c) => c.nsid)).not.toContain('registerNotify')
})

test('a registration close to lapsing is renewed before it does', async () => {
  // A lapsed one stops notices silently: the sweep carries on working and
  // nobody notices the latency went back up.
  withService()
  const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  routes = {
    registerNotify: () => ({ expiresAt: '2030-01-01T00:00:00.000Z' }),
    listRepos: () => ({ repos: [] }),
  }
  await reconcileSpace({ ...watch, registeredUntil: soon })
  expect(calls.map((c) => c.nsid)).toContain('registerNotify')
})

test('failing to subscribe costs latency, not the sweep', async () => {
  withService()
  routes = {
    registerNotify: () => Response.json({ error: 'ServiceNotResolvable' }, { status: 400 }),
    listRepos: () => ({ repos: [{ did: ALICE, rev: '3a' }] }),
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: () => ({ records: [] }),
  }

  await reconcileSpace({ ...watch })

  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe('3a')
})

test('an instance that receives no notices never subscribes', async () => {
  routes = { listRepos: () => ({ repos: [] }) }
  await reconcileSpace({ ...watch })
  expect(calls.map((c) => c.nsid)).not.toContain('registerNotify')
})

test('a notice reads the one repo it names', async () => {
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  routes = {
    getLatestCommit: () => ({ commit: { rev: '3a' } }),
    listRecords: (p) =>
      p.get('collection') === PUBLIC_COLLECTION
        ? { records: [{ rkey: 'fresh', cid: 'c1', value: { text: 'just written' } }] }
        : { records: [] },
  }

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
  routes = {
    getLatestCommit: () => ({ commit: { rev: '3real' } }),
    listRecords: () => ({ records: [] }),
  }
  await handleWriteNotice({ space: SPACE_URI, repo: ALICE })
  expect((await getSpaceRepo(SPACE_URI, ALICE))?.rev).toBe('3real')
})
