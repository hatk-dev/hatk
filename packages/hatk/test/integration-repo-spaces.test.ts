/**
 * The seam between a repo and a permissioned space.
 *
 * Every other suite here mocks across this line: the space tests mock the
 * indexer, the indexer tests mock backfill, and the backfill tests never see
 * a space. Each subsystem is well covered alone, and every bug that reached
 * production lived in the gap between them — a repo re-import deleting rows
 * the space sync had put there, a reference that fired on one path and not
 * the others, a strongRef stored by one and read by the other in a shape it
 * did not expect.
 *
 * So nothing here is mocked but the network: the PDS a repo is fetched from,
 * and the space host a credential reads through. Everything between those two
 * edges is the real thing, sharing one database.
 */
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

// The two network boundaries, and only those.
const getSpaceCredential = vi.fn()
vi.mock('../src/spaces/credential.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/spaces/credential.ts')>('../src/spaces/credential.ts')
  return { ...actual, getSpaceCredential: (...args: unknown[]) => getSpaceCredential(...args) }
})
vi.mock('../src/spaces/identity.ts', () => ({
  spaceHostEndpoint: async () => AUTHORITY_HOST,
  repoEndpoint: async (did: string) => `https://${did.replace(/[^a-z0-9]/gi, '')}.test`,
  configureSpaceIdentity: vi.fn(),
  clearSpaceIdentityCache: vi.fn(),
}))

import { backfillRepo, configurePlc } from '../src/backfill.ts'
import { getRecordByUri, insertRecord, reshapeRow, runSQL, setRepoStatus } from '../src/database/db.ts'
import { storeLexicons } from '../src/database/schema.ts'
import {
  _flushForTests,
  _resetRepoTrackingForTests,
  applyCommit,
  awaitBackfill,
  configureIndexer,
  sweepReferences,
} from '../src/indexer.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { configureSpaceEngine, reconcileSpace } from '../src/spaces/engine.ts'
import { unfilteredQuerySQL } from '../src/spaces/guard.ts'
import { putSpaceRepo, putSpaceWatch } from '../src/spaces/store.ts'
import { spaceRecordUri } from '../src/spaces/uri.ts'
import { withReadableSpaces } from '../src/spaces/visibility.ts'
import { PUBLIC_COLLECTION, SPACE_AUTHORITY, SPACE_TYPE, SPACE_URI, fixtureLexicons } from './fixture.ts'
import { setupFixtureDatabase } from './fixture.ts'
import { buildRepoCar, carResponse } from './repo-car.ts'

const PLC = 'http://plc.test'
const PDS = 'https://pds.example.com'
const AUTHORITY_HOST = 'https://authority.test'
const CLUB = SPACE_AUTHORITY
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

/**
 * A roster record: the community naming a member. Its field holds the DID, so
 * a `references` entry on this collection is what brings that member's own
 * repo into the index — they write nothing into a signal collection.
 */
const ROSTER = 'test.hatk.roster'
/** A record that points at another by strong reference, the reply/vote shape. */
const REPLY = 'test.hatk.reply'

function lexicons(): Map<string, any> {
  const map = fixtureLexicons()
  // A reply's `subject` is a ref to this; without it the validator cannot
  // resolve the ref and every such record is skipped as invalid.
  map.set('com.atproto.repo.strongRef', {
    "lexicon": 1,
    "id": "com.atproto.repo.strongRef",
    "description": "A URI with a content-hash fingerprint.",
    "defs": {
      "main": {
        "type": "object",
        "required": [
          "uri",
          "cid"
        ],
        "properties": {
          "uri": {
            "type": "string",
            "format": "at-uri"
          },
          "cid": {
            "type": "string",
            "format": "cid"
          }
        }
      }
    }
  })
  map.set(ROSTER, {
    lexicon: 1,
    id: ROSTER,
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: { type: 'object', required: ['member'], properties: { member: { type: 'string', format: 'did' } } },
      },
    },
  })
  map.set(REPLY, {
    lexicon: 1,
    id: REPLY,
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: {
          type: 'object',
          required: ['subject'],
          properties: {
            subject: { type: 'ref', ref: 'com.atproto.repo.strongRef' },
            text: { type: 'string' },
          },
        },
      },
    },
  })
  // The space holds all three, so a record of any of them can arrive either way.
  map.get(SPACE_TYPE).defs.main.collections = [PUBLIC_COLLECTION, ROSTER, REPLY]
  return map
}

const COLLECTIONS = new Set([PUBLIC_COLLECTION, ROSTER, REPLY])
const profile = (text: string) => ({ $type: PUBLIC_COLLECTION, text })
const REF_CID = 'bafyreih2dtcuctxfti4a4wzejehecpxyyde5y4vuiupxvacelowhmmrpbu'

/** What the space host answers, per XRPC method. */
let routes: Record<string, (params: URLSearchParams) => unknown>
/** What each DID's PDS serves for `getRepo`. */
let repos: Record<string, Uint8Array>

function fakeCredential() {
  return {
    space: SPACE_URI,
    readerDid: ALICE,
    expiresAt: Date.now() + 3600_000,
    fetch: async (input: string | URL) => {
      const url = new URL(input.toString())
      const nsid = url.pathname.split('/').pop()!.replace('com.atproto.space.', '')
      const handler = routes[nsid]
      if (!handler) return Response.json({ error: 'MethodNotImplemented' }, { status: 501 })
      return Response.json(handler(url.searchParams) as Record<string, unknown>)
    },
  }
}

/** The PLC directory and every PDS, as far as backfill is concerned. */
function stubNetwork() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const raw = String(input)
      if (raw.startsWith(`${PLC}/`)) {
        const did = raw.slice(PLC.length + 1)
        return Response.json({
          alsoKnownAs: [`at://${did.split(':').pop()}.test`],
          service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
        })
      }
      const url = new URL(raw)
      if (url.pathname === '/xrpc/com.atproto.sync.getRepo') {
        const car = repos[url.searchParams.get('did')!]
        if (!car) return Response.json({ message: 'not found' }, { status: 404 })
        return carResponse(car)
      }
      return Response.json({ message: `not stubbed: ${raw}` }, { status: 599 })
    }),
  )
}

const watch = {
  space: SPACE_URI,
  authority: SPACE_AUTHORITY,
  spaceType: SPACE_TYPE,
  readerDid: null,
  registeredUntil: null,
  lastError: null,
}

/** Every row of a collection, gate and all, as it sits in the table. */
async function rows(collection: string): Promise<{ uri: string; space: string | null }[]> {
  return (await unfilteredQuerySQL(`SELECT uri, space FROM "${collection}" ORDER BY uri`)) as {
    uri: string
    space: string | null
  }[]
}

async function configure(
  references: { collection: string; field: string }[] = [],
  signalCollections = new Set<string>(),
): Promise<void> {
  await configureIndexer({
    plcUrl: PLC,
    collections: COLLECTIONS,
    signalCollections,
    references,
    fetchTimeout: 1,
    maxRetries: 0,
    ftsRebuildInterval: 1_000_000,
  })
}

beforeAll(async () => {
  const lex = lexicons()
  await setupFixtureDatabase(lex)
  storeLexicons(lex)
  configurePlc(PLC)
})

beforeEach(async () => {
  setPrivateCollections([])
  // The status cache outlives a truncated table; without this a repo tracked
  // by one case is still "known" in the next.
  _resetRepoTrackingForTests()
  for (const c of COLLECTIONS) await runSQL(`DELETE FROM "${c}"`)
  await runSQL('DELETE FROM _repos')
  await runSQL('DELETE FROM _space_watch')
  await runSQL('DELETE FROM _space_repos')
  configureSpaceEngine({ oauth: { issuer: 'https://appview.test' } as any, types: new Set([SPACE_TYPE]), collections: COLLECTIONS })
  getSpaceCredential.mockReset()
  getSpaceCredential.mockImplementation(async () => fakeCredential())
  routes = {}
  repos = {}
  await configure()
  stubNetwork()
})

// --- A repo and a space, in one table ---------------------------------------

test('re-reading a repo whole leaves the rows its account wrote into a space', async () => {
  // Two homes for one account's records, and only one of them is the repo.
  // A full import deleting by DID took the space rows with it, and the space
  // sync — whose revision had not moved — never put them back. The community's
  // roster vanished and every member was shown the door.
  await putSpaceWatch(watch)
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: 'space-1' }] }),
    getLatestCommit: () => ({ commit: { rev: 'space-1' } }),
    listRecords: (p) =>
      p.get('collection') === PUBLIC_COLLECTION
        ? { records: [{ rkey: 'in-space', cid: 'cid-space', value: profile('written into the space') }] }
        : { records: [] },
  }
  await reconcileSpace(watch)

  repos[ALICE] = buildRepoCar(ALICE, 'repo-1', [
    { collection: PUBLIC_COLLECTION, rkey: 'in-repo', record: profile('written into the repo') },
  ])
  await backfillRepo(ALICE, COLLECTIONS, 30)

  expect(await rows(PUBLIC_COLLECTION)).toEqual([
    { uri: `at://${ALICE}/${PUBLIC_COLLECTION}/in-repo`, space: null },
    { uri: spaceRecordUri(SPACE_URI, ALICE, PUBLIC_COLLECTION, 'in-space'), space: SPACE_URI },
  ])
})

test('a repo re-import leaves the space rows gated, not merely present', async () => {
  // Surviving the purge is not enough: a space row that lost its `space` would
  // be served to everyone, which is worse than losing it.
  await insertRecord(
    PUBLIC_COLLECTION,
    spaceRecordUri(SPACE_URI, ALICE, PUBLIC_COLLECTION, 'private'),
    'cid-p',
    ALICE,
    profile('members only'),
  )
  repos[ALICE] = buildRepoCar(ALICE, 'repo-1', [
    { collection: PUBLIC_COLLECTION, rkey: 'public', record: profile('anyone') },
  ])
  await backfillRepo(ALICE, COLLECTIONS, 30)

  const visitor = (await unfilteredQuerySQL(
    `SELECT uri FROM "${PUBLIC_COLLECTION}" WHERE space IS NULL ORDER BY uri`,
  )) as { uri: string }[]
  expect(visitor.map((r) => r.uri)).toEqual([`at://${ALICE}/${PUBLIC_COLLECTION}/public`])

  const member = await withReadableSpaces([SPACE_URI], async () =>
    (await unfilteredQuerySQL(
      `SELECT uri FROM "${PUBLIC_COLLECTION}" WHERE space IS NULL OR space = $1 ORDER BY uri`,
      [SPACE_URI],
    )) as { uri: string }[],
  )
  expect(member).toHaveLength(2)
})

// --- References, from every path a record arrives by -------------------------

test('a roster record on the live stream brings the named repo in', async () => {
  // As in production: the roster is a signal collection, so the community's
  // own repo is tracked by writing one, and the members it names come in
  // behind it.
  await configure([{ collection: ROSTER, field: 'member' }], new Set([ROSTER]))
  repos[CLUB] = buildRepoCar(CLUB, 'repo-1', [
    { collection: ROSTER, rkey: 'm1', record: { $type: ROSTER, member: BOB } },
  ])
  repos[BOB] = buildRepoCar(BOB, 'repo-1', [
    { collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('bob') },
  ])

  applyCommit(CLUB, [
    { action: 'create', collection: ROSTER, rkey: 'm1', cid: 'cid-m1', record: { $type: ROSTER, member: BOB } },
  ])
  await awaitBackfill(BOB)
  await _flushForTests()

  expect((await rows(PUBLIC_COLLECTION)).map((r) => r.uri)).toContain(`at://${BOB}/${PUBLIC_COLLECTION}/self`)
})

test('a roster record read out of a repo brings the named repo in', async () => {
  await configure([{ collection: ROSTER, field: 'member' }])
  repos[CLUB] = buildRepoCar(CLUB, 'repo-1', [
    { collection: ROSTER, rkey: 'm1', record: { $type: ROSTER, member: BOB } },
  ])
  repos[BOB] = buildRepoCar(BOB, 'repo-1', [
    { collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('bob') },
  ])

  await backfillRepo(CLUB, COLLECTIONS, 30)
  await awaitBackfill(BOB)

  expect((await rows(PUBLIC_COLLECTION)).map((r) => r.uri)).toContain(`at://${BOB}/${PUBLIC_COLLECTION}/self`)
})

test('a roster record read out of a space brings the named repo in', async () => {
  // The membership that decides who may read lives in the space, not the repo.
  await configure([{ collection: ROSTER, field: 'member' }])
  await putSpaceWatch(watch)
  repos[BOB] = buildRepoCar(BOB, 'repo-1', [
    { collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('bob') },
  ])
  routes = {
    listRepos: () => ({ repos: [{ did: CLUB, rev: 'space-1' }] }),
    getLatestCommit: () => ({ commit: { rev: 'space-1' } }),
    listRecords: (p) =>
      p.get('collection') === ROSTER
        ? { records: [{ rkey: 'm1', cid: 'cid-m1', value: { $type: ROSTER, member: BOB } }] }
        : { records: [] },
  }

  await reconcileSpace(watch)
  await awaitBackfill(BOB)

  expect((await rows(PUBLIC_COLLECTION)).map((r) => r.uri)).toContain(`at://${BOB}/${PUBLIC_COLLECTION}/self`)
})

test('the boot sweep brings in repos named by rows indexed before the reference existed', async () => {
  // The roster was indexed yesterday; the reference was configured today.
  await insertRecord(ROSTER, `at://${CLUB}/${ROSTER}/m1`, 'cid-m1', CLUB, { $type: ROSTER, member: BOB })
  repos[BOB] = buildRepoCar(BOB, 'repo-1', [
    { collection: PUBLIC_COLLECTION, rkey: 'self', record: profile('bob') },
  ])

  await configure([{ collection: ROSTER, field: 'member' }])
  expect(await sweepReferences()).toBe(1)
  await awaitBackfill(BOB)

  expect((await rows(PUBLIC_COLLECTION)).map((r) => r.uri)).toContain(`at://${BOB}/${PUBLIC_COLLECTION}/self`)
})

test('a repo the index already holds is not re-read for being named again', async () => {
  // Configured after the repo exists, because that is when the status cache
  // warms from the table — as it does at boot.
  await setRepoStatus(BOB, 'active', 'repo-1')
  await configure([{ collection: ROSTER, field: 'member' }])
  await insertRecord(ROSTER, `at://${CLUB}/${ROSTER}/m1`, 'cid-m1', CLUB, { $type: ROSTER, member: BOB })

  await sweepReferences()
  await awaitBackfill(BOB)

  // No CAR was stubbed for BOB: a re-read would have failed the repo, and the
  // status would no longer be active.
  const [repo] = (await unfilteredQuerySQL('SELECT status FROM _repos WHERE did = $1', [BOB])) as { status: string }[]
  expect(repo.status).toBe('active')
})

// --- A strong reference, written by either path ------------------------------

test('a strongRef written through a repo reads back as the object its lexicon declares', async () => {
  // Stored as two columns so the uri can be joined on. A handler reads
  // `value.subject.uri`, which is what the generated type promises.
  const subject = `at://${CLUB}/${PUBLIC_COLLECTION}/thread`
  repos[ALICE] = buildRepoCar(ALICE, 'repo-1', [
    { collection: REPLY, rkey: 'r1', record: { $type: REPLY, subject: { uri: subject, cid: REF_CID }, text: 'hi' } },
  ])

  await backfillRepo(ALICE, COLLECTIONS, 30)

  const row = reshapeRow(await getRecordByUri(`at://${ALICE}/${REPLY}/r1`)) as any
  expect(row.value.subject).toEqual({ uri: subject, cid: REF_CID })
})

test('a strongRef written through a space keeps the space URI it points at', async () => {
  // A reply inside a space names its thread the way the space addresses it:
  // seven segments, `space` where a collection would be. Both the storing and
  // the reading have to survive that shape.
  const thread = spaceRecordUri(SPACE_URI, CLUB, PUBLIC_COLLECTION, 'thread')
  await putSpaceWatch(watch)
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: 'space-1' }] }),
    getLatestCommit: () => ({ commit: { rev: 'space-1' } }),
    listRecords: (p) =>
      p.get('collection') === REPLY
        ? { records: [{ rkey: 'r1', cid: 'cid-r1', value: { subject: { uri: thread, cid: REF_CID }, text: 'hi' } }] }
        : { records: [] },
  }

  await reconcileSpace(watch)

  // Read as a member: the gate hides a space row from everyone else, so an
  // ungated read here would find nothing and prove only that the gate works.
  const uri = spaceRecordUri(SPACE_URI, ALICE, REPLY, 'r1')
  const row = await withReadableSpaces([SPACE_URI], async () => reshapeRow(await getRecordByUri(uri)) as any)
  expect(row.value.subject).toEqual({ uri: thread, cid: REF_CID })
  expect(row.space).toBe(SPACE_URI)

  // And a visitor does not see it at all.
  expect(await getRecordByUri(uri)).toBeFalsy()
})

test('a space sync of one writer leaves another writer and the repo rows alone', async () => {
  // Re-reading one writer purges that writer's rows in the space before
  // re-inserting; the neighbours are not its business.
  await putSpaceWatch(watch)
  await putSpaceRepo({ space: SPACE_URI, did: BOB, pds: null, rev: 'space-1' })
  await insertRecord(
    PUBLIC_COLLECTION,
    spaceRecordUri(SPACE_URI, BOB, PUBLIC_COLLECTION, 'bobs'),
    'cid-b',
    BOB,
    profile('bob in the space'),
  )
  await insertRecord(PUBLIC_COLLECTION, `at://${ALICE}/${PUBLIC_COLLECTION}/own`, 'cid-o', ALICE, profile('alice repo'))
  routes = {
    listRepos: () => ({ repos: [{ did: ALICE, rev: 'space-2' }, { did: BOB, rev: 'space-1' }] }),
    getLatestCommit: () => ({ commit: { rev: 'space-2' } }),
    listRecords: (p) =>
      p.get('collection') === PUBLIC_COLLECTION && p.get('repo') === ALICE
        ? { records: [{ rkey: 'alices', cid: 'cid-a', value: profile('alice in the space') }] }
        : { records: [] },
  }

  await reconcileSpace(watch)

  expect((await rows(PUBLIC_COLLECTION)).map((r) => r.uri)).toEqual([
    `at://${ALICE}/${PUBLIC_COLLECTION}/own`,
    spaceRecordUri(SPACE_URI, ALICE, PUBLIC_COLLECTION, 'alices'),
    spaceRecordUri(SPACE_URI, BOB, PUBLIC_COLLECTION, 'bobs'),
  ])
})
