/**
 * `#identity` is how a handle rename reaches the index. The event's `handle`
 * field is optional per the lexicon and real emitters omit it, so the sparse
 * case — re-resolve from the PLC directory — is the one that has to work, and
 * every way that lookup can fail has to leave the stored handle alone rather
 * than blank it.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { querySQL, setRepoStatus, updateRepoHandle } from '../src/database/db.ts'
import { emit } from '../src/logger.ts'
import { configureIndexer, handleIdentityEvent } from '../src/indexer.ts'

vi.mock('../src/database/db.ts', { spy: true })
vi.mock('../src/logger.ts', { spy: true })

const TRACKED = 'did:plc:renamer'
const PLC_URL = 'http://plc.invalid'

/** The handle stored for a DID, which is what every consumer of a rename reads. */
async function storedHandle(did: string): Promise<string | null> {
  const rows = (await querySQL(`SELECT handle FROM _repos WHERE did = $1`, [did])) as any[]
  return rows[0]?.handle ?? null
}

/** Fields of the first `indexer/<op>` wide event emitted. */
function event(op: string): Record<string, any> | undefined {
  const call = vi.mocked(emit).mock.calls.find(([mod, o]) => mod === 'indexer' && o === op)
  return call?.[2] as Record<string, any> | undefined
}

function plcResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  // Warms the repo status cache with this DID — "already tracked" is the gate
  // on the whole identity path.
  await setRepoStatus(TRACKED, 'active', undefined, { handle: 'old.example' })
  await configureIndexer({
    plcUrl: PLC_URL,
    collections: new Set([PUBLIC_COLLECTION]),
    signalCollections: new Set<string>(),
    fetchTimeout: 2,
    maxRetries: 0,
    ftsRebuildInterval: 1_000_000,
  })
})

beforeEach(async () => {
  vi.mocked(emit).mockClear()
  await setRepoStatus(TRACKED, 'active', undefined, { handle: 'old.example' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(updateRepoHandle).mockClear()
})

test('an identity event for a DID the index does not track is ignored', async () => {
  // The firehose carries identity events for the entire network; resolving each
  // one would be millions of PLC lookups for accounts we hold nothing about.
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  await handleIdentityEvent('did:plc:someoneelse', undefined)

  expect(fetchMock).not.toHaveBeenCalled()
  expect(updateRepoHandle).not.toHaveBeenCalled()
})

test('a handle carried on the event is stored without a PLC lookup', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  await handleIdentityEvent(TRACKED, 'new.example')

  expect(fetchMock).not.toHaveBeenCalled()
  expect(await storedHandle(TRACKED)).toBe('new.example')
  expect(event('identity_handle_update')).toMatchObject({ handle: 'new.example', payload_had_handle: true })
})

test('a handle-less event re-resolves the handle from the PLC directory', async () => {
  const fetchMock = vi.fn().mockResolvedValue(plcResponse({ alsoKnownAs: ['at://resolved.example'] }))
  vi.stubGlobal('fetch', fetchMock)

  await handleIdentityEvent(TRACKED, undefined)

  expect(fetchMock).toHaveBeenCalledWith(`${PLC_URL}/${TRACKED}`, expect.anything())
  // The lookup is bounded: a slow plc.directory during an identity burst would
  // otherwise pile up unbounded fire-and-forget promises.
  expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  expect(await storedHandle(TRACKED)).toBe('resolved.example')
  expect(event('identity_handle_update')).toMatchObject({ payload_had_handle: false })
})

test('the first at:// alias wins when the DID document lists several', async () => {
  // alsoKnownAs is ordered and can carry non-handle URIs; the first at:// entry
  // is the canonical handle.
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        plcResponse({ alsoKnownAs: ['https://alice.example', 'at://canonical.example', 'at://alias.example'] }),
      ),
  )

  await handleIdentityEvent(TRACKED, undefined)
  expect(await storedHandle(TRACKED)).toBe('canonical.example')
})

test('a DID document with no at:// alias leaves the stored handle alone', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(plcResponse({ alsoKnownAs: ['https://alice.example'] })))

  await handleIdentityEvent(TRACKED, undefined)

  expect(await storedHandle(TRACKED)).toBe('old.example')
  expect(event('identity_no_handle')).toMatchObject({ did: TRACKED, payload_had_handle: false })
})

test('a DID document with no alsoKnownAs at all leaves the stored handle alone', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(plcResponse({})))

  await handleIdentityEvent(TRACKED, undefined)

  expect(await storedHandle(TRACKED)).toBe('old.example')
  expect(event('identity_no_handle')).toBeDefined()
})

test('a PLC directory error response is reported with its status, not treated as a rename', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(plcResponse(null, false, 429)))

  await handleIdentityEvent(TRACKED, undefined)

  expect(event('identity_resolve_error')).toMatchObject({ did: TRACKED, status: 429 })
  expect(await storedHandle(TRACKED)).toBe('old.example')
})

test('a PLC lookup that throws is reported rather than propagated', async () => {
  // The caller is fire-and-forget inside a synchronous message handler; an
  // unhandled rejection here would take the process down under load.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('The operation was aborted')))

  await expect(handleIdentityEvent(TRACKED, undefined)).resolves.toBeUndefined()

  expect(event('identity_resolve_error')).toMatchObject({ error: 'The operation was aborted' })
  expect(await storedHandle(TRACKED)).toBe('old.example')
})

test('a handle write that fails is reported rather than propagated', async () => {
  vi.mocked(updateRepoHandle).mockRejectedValueOnce(new Error('database is locked'))

  await expect(handleIdentityEvent(TRACKED, 'new.example')).resolves.toBeUndefined()

  expect(event('identity_update_error')).toMatchObject({ did: TRACKED, handle: 'new.example' })
  expect(event('identity_handle_update')).toBeUndefined()
})

test('a rejection that is not an Error is still reported with something readable', async () => {
  // undici and AbortSignal reject with values that are not always Errors; an
  // event reading `[object Object]` is better than one that throws while logging.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue('TimeoutError'))
  vi.mocked(updateRepoHandle).mockRejectedValueOnce('not an error either')

  await expect(handleIdentityEvent(TRACKED, undefined)).resolves.toBeUndefined()
  expect(event('identity_resolve_error')).toMatchObject({ error: 'TimeoutError' })

  await expect(handleIdentityEvent(TRACKED, 'new.example')).resolves.toBeUndefined()
  expect(event('identity_update_error')).toMatchObject({ error: 'not an error either' })
})
