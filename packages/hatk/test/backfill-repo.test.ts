import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { backfillRepo, configurePlc, pdsFor, purgeableCollections, runBackfill } from '../src/backfill.ts'
import { unfilteredQuerySQL } from '../src/spaces/guard.ts'
import { getRepoRetryInfo, getRepoStatus, insertRecord, querySQL, runSQL, setRepoStatus } from '../src/database/db.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { cidToString } from '../src/cid.ts'
import { PRIVATE_COLLECTION, PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { CidLink, buildCar, cborEncode, cidFor } from './firehose-frame.ts'

// A backfill is a whole repo pulled as a CAR and walked into rows. What these
// tests hold is the contract with the database: which rows a full import
// replaces, which a diff import leaves alone, which are never touched, and
// how a repo that could not be imported is left for the next attempt.

const PLC = 'http://plc.test'
const PDS = 'https://pds.example.com'
const RELAY = 'https://relay.test'
const DID = 'did:plc:alice'
const OTHER = 'did:plc:bob'
const enc = new TextEncoder()
const now = () => Math.floor(Date.now() / 1000)

interface RepoRecord {
  collection: string
  rkey: string
  record?: Record<string, unknown>
  /** Raw block bytes in place of an encoded record, for corrupt-block cases. */
  raw?: Uint8Array
}

/**
 * A minimal but real repo CAR: a signed-commit stand-in whose `data` points
 * at a one-node MST listing every record. `omitRoot` produces the shape of a
 * diff CAR compacted past the requested rev — blocks but no commit.
 */
function buildRepoCar(did: string, rev: string, records: RepoRecord[], opts: { omitRoot?: boolean } = {}): Uint8Array {
  const blocks: Array<{ cid: CidLink; bytes: Uint8Array }> = []
  const entries = records.map((r) => {
    const bytes = r.raw ?? cborEncode(r.record)
    const cid = cidFor(bytes)
    blocks.push({ cid, bytes })
    return { p: 0, k: enc.encode(`${r.collection}/${r.rkey}`), v: cid, t: null }
  })
  const mstBytes = cborEncode({ l: null, e: entries })
  const mstCid = cidFor(mstBytes)
  blocks.push({ cid: mstCid, bytes: mstBytes })
  const commitBytes = cborEncode({ did, version: 3, data: mstCid, rev, prev: null })
  const commitCid = cidFor(commitBytes)
  if (!opts.omitRoot) blocks.push({ cid: commitCid, bytes: commitBytes })
  return buildCar(commitCid, blocks)
}

/** The CID string hatk stores for a record, as the CAR parser spells it. */
const cidOf = (record: Record<string, unknown>) => cidToString(cidFor(cborEncode(record)).bytes)

const profile = (text: string) => ({ $type: PUBLIC_COLLECTION, text })

interface Call {
  url: string
  init?: RequestInit
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const carResponse = (car: Uint8Array) =>
  new Response(car.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: { 'content-type': 'application/vnd.ipld.car' },
  })

/**
 * A network where every DID in `repos` resolves to PDS with the handle
 * `<name>.test`, and getRepo serves its CAR. `override` sees each URL first.
 */
function stubNetwork(
  repos: Record<string, Uint8Array>,
  override: (url: URL, init: RequestInit | undefined, n: number) => Response | Promise<Response> | undefined = () =>
    undefined,
) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = String(input)
      calls.push({ url: raw, init })
      const n = (counts.get(raw) ?? 0) + 1
      counts.set(raw, n)
      const url = new URL(raw)
      const custom = override(url, init, n)
      if (custom) return custom

      if (raw.startsWith(`${PLC}/`)) {
        const did = raw.slice(PLC.length + 1)
        if (!(did in repos)) return json({ message: 'not found' }, 404)
        return json({
          alsoKnownAs: [`at://${did.split(':').pop()}.test`],
          service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
        })
      }
      if (url.pathname === '/xrpc/com.atproto.sync.getRepo') {
        const car = repos[url.searchParams.get('did')!]
        return car ? carResponse(car) : json({ error: 'RepoNotFound' }, 404)
      }
      return json({ error: 'unstubbed' }, 404)
    }),
  )
  return calls
}

const getRepoCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('com.atproto.sync.getRepo'))

const publicRows = async (did = DID) =>
  (await querySQL(`SELECT uri, cid, did, text FROM "${PUBLIC_COLLECTION}" WHERE did = $1 ORDER BY uri`, [did])) as any[]

const COLLECTIONS = new Set([PUBLIC_COLLECTION])

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  configurePlc(PLC)
})

beforeEach(async () => {
  setPrivateCollections([])
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  await runSQL(`DELETE FROM "${PRIVATE_COLLECTION}"`)
  await runSQL('DELETE FROM _repos')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('private collections are never purged by a full import', () => {
  setPrivateCollections([PRIVATE_COLLECTION])
  expect(purgeableCollections([PUBLIC_COLLECTION, PRIVATE_COLLECTION])).toEqual([PUBLIC_COLLECTION])
})

describe('backfillRepo', () => {
  test('imports the records of the configured collections and marks the repo active', async () => {
    const hello = profile('hello')
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [{ collection: PUBLIC_COLLECTION, rkey: 'self', record: hello }]),
    })

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1)

    expect(await publicRows()).toEqual([
      { uri: `at://${DID}/${PUBLIC_COLLECTION}/self`, cid: cidOf(hello), did: DID, text: 'hello' },
    ])
    // Rev and handle come from the repo and DID document, so the next import
    // can be a diff and the account has a name.
    const [repo] = (await querySQL('SELECT status, rev, handle, retry_count FROM _repos WHERE did = $1', [
      DID,
    ])) as any[]
    expect(repo).toMatchObject({ status: 'active', rev: 'rev-1', handle: 'alice.test', retry_count: 0 })
  })

  test('records in other collections are not imported or counted', async () => {
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [
        { collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('kept') },
        { collection: 'app.bsky.feed.post', rkey: 'p1', record: { $type: 'app.bsky.feed.post', text: 'ignored' } },
      ]),
    })

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1)
    expect((await publicRows()).map((r) => r.text)).toEqual(['kept'])
  })

  test('records that fail lexicon validation are skipped, the rest still land', async () => {
    // `text` is required by the fixture lexicon. A bad record must not sink
    // the repo, and must not be indexed as if it were fine.
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [
        { collection: PUBLIC_COLLECTION, rkey: 'bad', record: { $type: PUBLIC_COLLECTION } },
        { collection: PUBLIC_COLLECTION, rkey: 'good', record: profile('fine') },
        { collection: PUBLIC_COLLECTION, rkey: 'untyped', record: { text: 'no type' } },
      ]),
    })

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1)
    expect((await publicRows()).map((r) => r.text)).toEqual(['fine'])
    expect(await getRepoStatus(DID)).toBe('active')
  })

  test('a corrupt block is skipped without failing the repo', async () => {
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [
        { collection: PUBLIC_COLLECTION, rkey: 'broken', raw: new Uint8Array([0xff, 0xff, 0xff]) },
        { collection: PUBLIC_COLLECTION, rkey: 'good', record: profile('fine') },
      ]),
    })

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1)
    expect(await getRepoStatus(DID)).toBe('active')
  })

  test('a full import replaces what was indexed before, so deletions are reflected', async () => {
    await insertRecord(PUBLIC_COLLECTION, `at://${DID}/${PUBLIC_COLLECTION}/stale`, 'cid-stale', DID, profile('stale'))
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [{ collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('current') }]),
    })

    await backfillRepo(DID, COLLECTIONS, 30)

    expect((await publicRows()).map((r) => r.text)).toEqual(['current'])
  })

  test('a full import leaves other repos alone', async () => {
    await insertRecord(PUBLIC_COLLECTION, `at://${OTHER}/${PUBLIC_COLLECTION}/self`, 'cid-bob', OTHER, profile('bob'))
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [{ collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('alice') }]),
    })

    await backfillRepo(DID, COLLECTIONS, 30)

    expect((await publicRows(OTHER)).map((r) => r.text)).toEqual(['bob'])
  })

  test('private collections are neither purged nor imported from the repo', async () => {
    // AppView-authoritative rows are not in any repo; a full import that purged
    // them would destroy data nothing can restore. And a record that happens to
    // share the NSID in a user's repo must not overwrite them either.
    setPrivateCollections([PRIVATE_COLLECTION])
    const existing = { $type: PRIVATE_COLLECTION, text: 'server-side activity' }
    await insertRecord(PRIVATE_COLLECTION, `at://${DID}/${PRIVATE_COLLECTION}/a1`, 'cid-a1', DID, existing)
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [
        { collection: PRIVATE_COLLECTION, rkey: 'forged', record: { $type: PRIVATE_COLLECTION, text: 'from repo' } },
        { collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('alice') },
      ]),
    })

    expect(await backfillRepo(DID, new Set([PUBLIC_COLLECTION, PRIVATE_COLLECTION]), 30)).toBe(1)

    const rows = (await querySQL(`SELECT text FROM "${PRIVATE_COLLECTION}" WHERE did = $1`, [DID])) as any[]
    expect(rows.map((r) => r.text)).toEqual(['server-side activity'])
  })

  test('a full import leaves the rows this account wrote into a space alone', async () => {
    // Those rows are not in the repo — they live with the space and come in
    // through the space sync, whose revision does not move when the repo is
    // re-read. Purging them here left them gone until the space was re-synced
    // by hand.
    const inSpace = `at://did:plc:club/space/xyz.test.space/self/${DID}/${PUBLIC_COLLECTION}/s1`
    await insertRecord(PUBLIC_COLLECTION, inSpace, 'cid-s1', DID, profile('in the space'))
    await insertRecord(PUBLIC_COLLECTION, `at://${DID}/${PUBLIC_COLLECTION}/stale`, 'cid-stale', DID, profile('stale'))
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [{ collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('alice') }]),
    })

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1)

    const rows = (await unfilteredQuerySQL(`SELECT uri, space FROM "${PUBLIC_COLLECTION}" WHERE did = $1 ORDER BY uri`, [
      DID,
    ])) as { uri: string; space: string | null }[]
    expect(rows.map((r) => r.uri)).toEqual([`at://${DID}/${PUBLIC_COLLECTION}/self`, inSpace])
    expect(rows[1].space).toBe('at://did:plc:club/space/xyz.test.space/self')
  })

  test('a repo with a known rev is fetched as a diff and merged, not replaced', async () => {
    await setRepoStatus(DID, 'active', 'rev-1')
    await insertRecord(PUBLIC_COLLECTION, `at://${DID}/${PUBLIC_COLLECTION}/older`, 'cid-older', DID, profile('older'))
    const calls = stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-2', [{ collection: PUBLIC_COLLECTION, rkey: 'newer', record: profile('newer') }]),
    })

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1)

    expect(new URL(getRepoCalls(calls)[0].url).searchParams.get('since')).toBe('rev-1')
    expect((await publicRows()).map((r) => r.text)).toEqual(['newer', 'older'])
    const [repo] = (await querySQL('SELECT rev FROM _repos WHERE did = $1', [DID])) as any[]
    expect(repo.rev).toBe('rev-2')
  })

  test('a PDS that rejects the since rev gets asked for the whole repo', async () => {
    // Compacted history: the diff is impossible, so it becomes a full import,
    // purge included.
    await setRepoStatus(DID, 'active', 'rev-1')
    await insertRecord(PUBLIC_COLLECTION, `at://${DID}/${PUBLIC_COLLECTION}/older`, 'cid-older', DID, profile('older'))
    const calls = stubNetwork(
      { [DID]: buildRepoCar(DID, 'rev-2', [{ collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('full') }]) },
      (url) => (url.searchParams.has('since') ? json({ error: 'InvalidRequest' }, 400) : undefined),
    )

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1)

    const fetches = getRepoCalls(calls).map((c) => new URL(c.url).searchParams.has('since'))
    expect(fetches).toEqual([true, false])
    expect((await publicRows()).map((r) => r.text)).toEqual(['full'])
  })

  test('a diff CAR missing its commit block triggers a full import', async () => {
    await setRepoStatus(DID, 'active', 'rev-1')
    await insertRecord(PUBLIC_COLLECTION, `at://${DID}/${PUBLIC_COLLECTION}/older`, 'cid-older', DID, profile('older'))
    const record = { collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('full') }
    const calls = stubNetwork({ [DID]: buildRepoCar(DID, 'rev-2', [record]) }, (url) =>
      url.searchParams.has('since') ? carResponse(buildRepoCar(DID, 'rev-2', [record], { omitRoot: true })) : undefined,
    )

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1)

    expect(getRepoCalls(calls)).toHaveLength(2)
    expect((await publicRows()).map((r) => r.text)).toEqual(['full'])
  })

  test('a full CAR with no commit block is an error, not an empty success', async () => {
    stubNetwork({
      [DID]: buildRepoCar(DID, 'rev-1', [{ collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('x') }], {
        omitRoot: true,
      }),
    })

    await expect(backfillRepo(DID, COLLECTIONS, 30)).rejects.toThrow(/No root block/)
    expect(await getRepoStatus(DID)).toBe('failed')
  })

  test('a 4xx from getRepo is permanent: failed, never retried, handle kept', async () => {
    // The repo is gone or deactivated; retrying would only burn requests.
    // The DID still resolves; only the PDS refuses.
    stubNetwork({ [DID]: new Uint8Array() }, (url) =>
      url.pathname === '/xrpc/com.atproto.sync.getRepo' ? json({ error: 'RepoDeactivated' }, 404) : undefined,
    )

    await expect(backfillRepo(DID, COLLECTIONS, 30)).rejects.toThrow(/getRepo failed for did:plc:alice: 404/)

    const [repo] = (await querySQL('SELECT status, retry_count, retry_after, handle FROM _repos WHERE did = $1', [
      DID,
    ])) as any[]
    expect(repo).toMatchObject({ status: 'failed', retry_count: 999, retry_after: 0, handle: 'alice.test' })
  })

  test('a 5xx from getRepo is retried later with growing backoff', async () => {
    stubNetwork({ [DID]: new Uint8Array() }, (url) =>
      url.pathname === '/xrpc/com.atproto.sync.getRepo' ? json({ error: 'InternalError' }, 502) : undefined,
    )

    const before = now()
    await expect(backfillRepo(DID, COLLECTIONS, 30)).rejects.toThrow(/502/)
    let info = await getRepoRetryInfo(DID)
    expect(info!.retryCount).toBe(1)
    expect(info!.retryAfter).toBeGreaterThanOrEqual(before + 60)
    expect(info!.retryAfter).toBeLessThanOrEqual(now() + 60)

    // The second failure waits twice as long.
    await expect(backfillRepo(DID, COLLECTIONS, 30)).rejects.toThrow(/502/)
    info = await getRepoRetryInfo(DID)
    expect(info!.retryCount).toBe(2)
    expect(info!.retryAfter).toBeGreaterThanOrEqual(before + 120)
    expect(await getRepoStatus(DID)).toBe('failed')
  })

  test('a DID that cannot be resolved is a retryable failure with no handle', async () => {
    stubNetwork({})

    await expect(backfillRepo(DID, COLLECTIONS, 30)).rejects.toThrow(/PLC resolution failed for did:plc:alice: 404/)

    const [repo] = (await querySQL('SELECT status, retry_count, handle FROM _repos WHERE did = $1', [DID])) as any[]
    expect(repo).toMatchObject({ status: 'failed', retry_count: 1, handle: null })
  })

  test('a DID document without a PDS cannot be imported', async () => {
    stubNetwork({}, (url) => (url.href === `${PLC}/${DID}` ? json({ service: [] }) : undefined))

    await expect(backfillRepo(DID, COLLECTIONS, 30)).rejects.toThrow(/No PDS endpoint in DID document/)
  })

  test('a did:web repo is resolved from its own domain', async () => {
    const webDid = 'did:web:alice.example'
    const car = buildRepoCar(webDid, 'rev-1', [{ collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('web') }])
    const calls = stubNetwork({ [webDid]: car }, (url) =>
      url.href === 'https://alice.example/.well-known/did.json'
        ? json({
            alsoKnownAs: ['at://alice.example'],
            service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
          })
        : undefined,
    )

    expect(await backfillRepo(webDid, COLLECTIONS, 30)).toBe(1)

    expect(calls[0].url).toBe('https://alice.example/.well-known/did.json')
    expect(calls.some((c) => c.url.startsWith(PLC))).toBe(false)
    const [repo] = (await querySQL('SELECT handle FROM _repos WHERE did = $1', [webDid])) as any[]
    expect(repo.handle).toBe('alice.example')
  })

  test('a download that outlasts the timeout is abandoned and left for retry', async () => {
    stubNetwork({ [DID]: new Uint8Array() }, (url, init) => {
      if (url.pathname !== '/xrpc/com.atproto.sync.getRepo') return undefined
      // A PDS that never answers: only the abort signal ends the wait.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })

    await expect(backfillRepo(DID, COLLECTIONS, 0)).rejects.toThrow('aborted')

    expect(await getRepoStatus(DID)).toBe('failed')
    expect((await getRepoRetryInfo(DID))!.retryCount).toBe(1)
  })

  test('a takendown repo is refused before anything is fetched', async () => {
    await setRepoStatus(DID, 'takendown')
    const calls = stubNetwork({})

    expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(0)
    expect(calls).toHaveLength(0)
    expect(await getRepoStatus(DID)).toBe('takendown')
  })
})

describe('pdsFor', () => {
  test('resolves once and answers from cache after', async () => {
    const calls = stubNetwork({ [OTHER]: new Uint8Array() })

    expect(await pdsFor(OTHER)).toBe(PDS)
    expect(await pdsFor(OTHER)).toBe(PDS)
    expect(calls).toHaveLength(1)
  })
})

describe('runBackfill', () => {
  // Serial by default so these tests describe the enumeration and retry logic
  // rather than worker interleaving; concurrency has its own case below.
  const baseConfig = { fullNetwork: false, parallelism: 1, fetchTimeout: 30, maxRetries: 3 }

  const repoOf = (did: string, text: string) =>
    buildRepoCar(did, 'rev-1', [{ collection: PUBLIC_COLLECTION, rkey: 'self', record: profile(text) }])

  /** listRepos / listReposByCollection pages for a relay, keyed by endpoint then cursor. */
  function relayPages(pages: Record<string, Record<string, unknown>>) {
    return (url: URL) => {
      if (!url.href.startsWith(RELAY)) return undefined
      const endpoint = url.pathname.split('.').pop()!
      const page = pages[endpoint]?.[url.searchParams.get('cursor') ?? '']
      return page ? json(page) : json({ error: 'MethodNotImplemented' }, 501)
    }
  }

  test('two workers importing the same collection at once do not trip over a shared staging table', async () => {
    // bulkInsertRecords stages rows in a scratch table before merging them.
    // Named per collection, that table is dropped and recreated underneath a
    // sibling worker: one import fails with "table already exists" or loses
    // its staged rows to the other's DROP.
    stubNetwork({ [DID]: repoOf(DID, 'alice'), [OTHER]: repoOf(OTHER, 'bob') })

    const total = await runBackfill({
      pdsUrl: RELAY,
      plcUrl: PLC,
      collections: COLLECTIONS,
      config: { ...baseConfig, parallelism: 2, repos: [DID, OTHER] },
    })

    expect(total).toBe(2)
    expect(await getRepoStatus(DID)).toBe('active')
    expect(await getRepoStatus(OTHER)).toBe('active')
    expect((await publicRows(DID)).map((r) => r.text)).toEqual(['alice'])
    expect((await publicRows(OTHER)).map((r) => r.text)).toEqual(['bob'])
    // Nothing left behind for the next import to collide with.
    expect(await querySQL(`SELECT name FROM sqlite_master WHERE name LIKE '\\_staging\\_%' ESCAPE '\\'`)).toEqual([])
  })

  test('pinned repos are imported without enumerating the relay', async () => {
    const calls = stubNetwork({ [DID]: repoOf(DID, 'alice') })

    const total = await runBackfill({
      pdsUrl: RELAY,
      plcUrl: PLC,
      collections: COLLECTIONS,
      config: { ...baseConfig, repos: [DID] },
    })

    expect(total).toBe(1)
    expect(calls.some((c) => c.url.startsWith(RELAY))).toBe(false)
    expect(await getRepoStatus(DID)).toBe('active')
  })

  test('collection-signal mode asks each relay for each signal collection and pages through', async () => {
    const calls = stubNetwork(
      { [DID]: repoOf(DID, 'alice'), [OTHER]: repoOf(OTHER, 'bob') },
      relayPages({
        listReposByCollection: {
          '': { repos: [{ did: DID, rev: 'r' }], cursor: 'page2' },
          page2: { repos: [{ did: OTHER }] },
        },
      }),
    )

    const total = await runBackfill({
      pdsUrl: RELAY,
      plcUrl: PLC,
      collections: COLLECTIONS,
      config: { ...baseConfig, signalCollections: ['app.bsky.feed.like'] },
    })

    expect(total).toBe(2)
    const relayCalls = calls.filter((c) => c.url.startsWith(RELAY)).map((c) => new URL(c.url))
    expect(relayCalls.map((u) => u.pathname)).toEqual([
      '/xrpc/com.atproto.sync.listReposByCollection',
      '/xrpc/com.atproto.sync.listReposByCollection',
    ])
    expect(relayCalls[0].searchParams.get('collection')).toBe('app.bsky.feed.like')
    expect(relayCalls[0].searchParams.get('cursor')).toBeNull()
    expect(relayCalls[1].searchParams.get('cursor')).toBe('page2')
    expect(await getRepoStatus(OTHER)).toBe('active')
  })

  test('a relay without collection enumeration is walked with listRepos, skipping deactivated repos', async () => {
    const calls = stubNetwork(
      { [DID]: repoOf(DID, 'alice'), [OTHER]: repoOf(OTHER, 'bob') },
      relayPages({
        listRepos: {
          '': {
            repos: [
              { did: DID, rev: 'r' },
              { did: 'did:plc:gone', rev: 'r', active: false },
            ],
            cursor: 'p2',
          },
          p2: { repos: [{ did: OTHER, rev: 'r' }] },
        },
      }),
    )

    const total = await runBackfill({ pdsUrl: RELAY, plcUrl: PLC, collections: COLLECTIONS, config: baseConfig })

    expect(total).toBe(2)
    expect(calls.filter((c) => c.url.includes('listReposByCollection'))).toHaveLength(1)
    expect(calls.filter((c) => c.url.includes('listRepos?'))).toHaveLength(2)
    // The deactivated repo was never resolved, let alone fetched.
    expect(calls.some((c) => c.url.includes('did:plc:gone'))).toBe(false)
    expect(await getRepoStatus('did:plc:gone')).toBeNull()
  })

  test('a relay error other than "unsupported" is not swallowed', async () => {
    stubNetwork({}, (url) => (url.href.startsWith(RELAY) ? json({ error: 'boom' }, 500) : undefined))

    await expect(
      runBackfill({ pdsUrl: RELAY, plcUrl: PLC, collections: COLLECTIONS, config: baseConfig }),
    ).rejects.toThrow(/listReposByCollection failed: 500/)
  })

  test('full-network mode enumerates every relay it is given', async () => {
    const SECOND = 'https://relay2.test'
    const calls = stubNetwork({ [DID]: repoOf(DID, 'alice'), [OTHER]: repoOf(OTHER, 'bob') }, (url) => {
      if (url.pathname !== '/xrpc/com.atproto.sync.listRepos') return undefined
      if (url.origin === RELAY) return json({ repos: [{ did: DID, rev: 'r' }] })
      if (url.origin === SECOND) return json({ repos: [{ did: OTHER, rev: 'r' }] })
      return undefined
    })

    const total = await runBackfill({
      pdsUrl: RELAY,
      extraPdsUrls: [SECOND],
      plcUrl: PLC,
      collections: COLLECTIONS,
      config: { ...baseConfig, fullNetwork: true },
    })

    expect(total).toBe(2)
    expect(calls.some((c) => c.url.includes('listReposByCollection'))).toBe(false)
    expect(calls.filter((c) => c.url.includes('listRepos?'))).toHaveLength(2)
  })

  test('repos already active are not imported again', async () => {
    await setRepoStatus(DID, 'active', 'rev-1')
    const calls = stubNetwork({ [DID]: repoOf(DID, 'alice') })

    const total = await runBackfill({
      pdsUrl: RELAY,
      plcUrl: PLC,
      collections: COLLECTIONS,
      config: { ...baseConfig, repos: [DID] },
    })

    expect(total).toBe(0)
    expect(getRepoCalls(calls)).toHaveLength(0)
  })

  test('a takendown repo stays down through a run that enumerates it', async () => {
    await setRepoStatus(DID, 'takendown')
    stubNetwork({ [DID]: repoOf(DID, 'alice') })

    await runBackfill({ pdsUrl: RELAY, plcUrl: PLC, collections: COLLECTIONS, config: { ...baseConfig, repos: [DID] } })

    expect(await getRepoStatus(DID)).toBe('takendown')
  })

  test('repos left pending by an earlier run are picked up even when not enumerated', async () => {
    await setRepoStatus(OTHER, 'pending')
    stubNetwork({ [DID]: repoOf(DID, 'alice'), [OTHER]: repoOf(OTHER, 'bob') })

    const total = await runBackfill({
      pdsUrl: RELAY,
      plcUrl: PLC,
      collections: COLLECTIONS,
      config: { ...baseConfig, repos: [DID] },
    })

    expect(total).toBe(2)
    expect(await getRepoStatus(OTHER)).toBe('active')
  })

  test('one repo failing does not stop the others, and is left with retry info', async () => {
    stubNetwork({ [DID]: repoOf(DID, 'alice'), [OTHER]: new Uint8Array() }, (url) =>
      url.pathname === '/xrpc/com.atproto.sync.getRepo' && url.searchParams.get('did') === OTHER
        ? json({ error: 'InternalError' }, 500)
        : undefined,
    )

    const total = await runBackfill({
      pdsUrl: RELAY,
      plcUrl: PLC,
      collections: COLLECTIONS,
      config: { ...baseConfig, repos: [DID, OTHER] },
    })

    expect(total).toBe(1)
    expect(await getRepoStatus(DID)).toBe('active')
    expect(await getRepoStatus(OTHER)).toBe('failed')
    // Its retry is in the future, so this run did not spin on it.
    expect((await getRepoRetryInfo(OTHER))!.retryAfter).toBeGreaterThan(now())
  })

  test('a failed repo whose backoff has elapsed is retried in the same run', async () => {
    await setRepoStatus(OTHER, 'failed', undefined, { retryCount: 1, retryAfter: 0 })
    const calls = stubNetwork({ [DID]: repoOf(DID, 'alice'), [OTHER]: repoOf(OTHER, 'bob') })

    const total = await runBackfill({
      pdsUrl: RELAY,
      plcUrl: PLC,
      collections: COLLECTIONS,
      config: { ...baseConfig, repos: [DID] },
    })

    expect(total).toBe(2)
    expect(await getRepoStatus(OTHER)).toBe('active')
    expect(getRepoCalls(calls).map((c) => new URL(c.url).searchParams.get('did'))).toEqual([DID, OTHER])
  })

  test('a failed repo past its retry budget is left alone', async () => {
    await setRepoStatus(OTHER, 'failed', undefined, { retryCount: 3, retryAfter: 0 })
    const calls = stubNetwork({ [DID]: repoOf(DID, 'alice'), [OTHER]: repoOf(OTHER, 'bob') })

    await runBackfill({ pdsUrl: RELAY, plcUrl: PLC, collections: COLLECTIONS, config: { ...baseConfig, repos: [DID] } })

    expect(await getRepoStatus(OTHER)).toBe('failed')
    expect(getRepoCalls(calls)).toHaveLength(1)
  })

  test('nothing to do is a quiet zero', async () => {
    const calls = stubNetwork({}, (url) => (url.href.startsWith(RELAY) ? json({ repos: [] }) : undefined))

    expect(await runBackfill({ pdsUrl: RELAY, plcUrl: PLC, collections: COLLECTIONS, config: baseConfig })).toBe(0)
    expect(calls.some((c) => c.url.startsWith(PLC))).toBe(false)
  })
})

test('a repo larger than one insert chunk lands in full', async () => {
  // Records are flushed in chunks of 1000 to bound memory; the boundary must
  // not drop the remainder or double-count the flushed part.
  const records = Array.from({ length: 1001 }, (_, i) => ({
    collection: PUBLIC_COLLECTION,
    rkey: `r${String(i).padStart(4, '0')}`,
    record: profile(`record ${i}`),
  }))
  stubNetwork({ [DID]: buildRepoCar(DID, 'rev-big', records) })

  expect(await backfillRepo(DID, COLLECTIONS, 30)).toBe(1001)

  const [{ n }] = (await querySQL(`SELECT COUNT(*) AS n FROM "${PUBLIC_COLLECTION}" WHERE did = $1`, [DID])) as any[]
  expect(Number(n)).toBe(1001)
})
