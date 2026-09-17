import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const configureSpaceEngine = vi.fn()
const configureSpaceIdentity = vi.fn()
const reconcileAll = vi.fn()
const watchSpace = vi.fn()

vi.mock('../src/spaces/engine.ts', () => ({
  configureSpaceEngine: (...a: unknown[]) => configureSpaceEngine(...a),
  reconcileAll: (...a: unknown[]) => reconcileAll(...a),
  watchSpace: (...a: unknown[]) => watchSpace(...a),
  unwatchSpace: vi.fn(),
  collectionsForSpaceType: vi.fn(),
  reconcileSpace: vi.fn(),
  syncSpaceRepo: vi.fn(),
}))
vi.mock('../src/spaces/identity.ts', () => ({
  configureSpaceIdentity: (...a: unknown[]) => configureSpaceIdentity(...a),
  spaceHostEndpoint: vi.fn(),
  repoEndpoint: vi.fn(),
  clearSpaceIdentityCache: vi.fn(),
}))

const { startSpaces, stopSpaces } = await import('../src/spaces/index.ts')

const SPACE = 'at://did:plc:authority/space/test.hatk.board/self'
const oauth = { issuer: 'https://appview.test', scopes: ['atproto'], clients: [] } as any
const base = {
  spaces: { types: ['test.hatk.board'], watch: [SPACE], reconcileInterval: 300 },
  oauth,
  plc: 'https://plc.test',
  collections: new Set(['app.bsky.actor.profile']),
}

beforeEach(() => {
  vi.useFakeTimers()
  configureSpaceEngine.mockReset()
  configureSpaceIdentity.mockReset()
  reconcileAll.mockReset()
  reconcileAll.mockResolvedValue(undefined)
  watchSpace.mockReset()
  watchSpace.mockResolvedValue(undefined)
})

afterEach(() => {
  stopSpaces()
  vi.useRealTimers()
})

test('without OAuth there is no way into a space, so nothing starts', () => {
  // Reading one begins with a delegation token from a member's own PDS; an
  // instance holding no sessions could only sweep forever finding nothing.
  startSpaces({ ...base, oauth: null })
  expect(configureSpaceEngine).not.toHaveBeenCalled()
})

test('with no space types configured, nothing starts', () => {
  startSpaces({ ...base, spaces: { types: [] } })
  expect(configureSpaceEngine).not.toHaveBeenCalled()
})

test('starting configures the engine with the types and collections it may index', () => {
  startSpaces(base)
  expect(configureSpaceIdentity).toHaveBeenCalledWith('https://plc.test')
  expect(configureSpaceEngine).toHaveBeenCalledWith({
    oauth,
    types: new Set(['test.hatk.board']),
    collections: base.collections,
  })
})

test('the first sweep is deferred so it does not sit in front of the first request', async () => {
  startSpaces(base)
  expect(watchSpace).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(watchSpace).toHaveBeenCalledWith(SPACE)
  expect(reconcileAll).toHaveBeenCalledTimes(1)
})

test('the sweep repeats on the configured interval', async () => {
  startSpaces(base)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.advanceTimersByTimeAsync(300_000)
  expect(reconcileAll).toHaveBeenCalledTimes(2)
})

test('a pinned space that cannot be watched does not stop the sweep', async () => {
  watchSpace.mockRejectedValue(new Error('unreachable'))
  startSpaces(base)
  await vi.advanceTimersByTimeAsync(1000)
  expect(reconcileAll).toHaveBeenCalledTimes(1)
})

test('an interval below the floor is raised rather than honoured', async () => {
  // A sweep reaches several hosts; letting it run every second would be a load
  // test aimed at somebody else's server.
  startSpaces({ ...base, spaces: { types: ['test.hatk.board'], reconcileInterval: 1 } })
  await vi.advanceTimersByTimeAsync(1000)
  reconcileAll.mockClear()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(reconcileAll).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(25_000)
  expect(reconcileAll).toHaveBeenCalledTimes(1)
})

test('an instance with no pinned spaces still reconciles what it already follows', async () => {
  startSpaces({ ...base, spaces: { types: ['test.hatk.board'] } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(watchSpace).not.toHaveBeenCalled()
  expect(reconcileAll).toHaveBeenCalledTimes(1)
})

test('stopping ends the sweep', async () => {
  startSpaces(base)
  await vi.advanceTimersByTimeAsync(1000)
  reconcileAll.mockClear()
  stopSpaces()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(reconcileAll).not.toHaveBeenCalled()
})

// --- Receiving notices ---

test('with no service DID the instance is addressable by nobody', async () => {
  // Which is also what makes the inbound notice routes refuse everything.
  const { spaceServiceId } = await import('../src/spaces/index.ts')
  startSpaces(base)
  expect(spaceServiceId()).toBeNull()
  expect(configureSpaceEngine.mock.calls[0][0].serviceId).toBeUndefined()
})

test('a service DID gives the instance an identifier notices are addressed to', async () => {
  const { spaceServiceId } = await import('../src/spaces/index.ts')
  startSpaces({ ...base, spaces: { ...base.spaces, serviceDid: 'did:web:appview.test' } })
  expect(spaceServiceId()).toBe('did:web:appview.test#atproto_space_syncer')
  expect(configureSpaceEngine.mock.calls[0][0].serviceId).toBe('did:web:appview.test#atproto_space_syncer')
})

test('the service fragment can be named rather than assumed', async () => {
  const { spaceServiceId } = await import('../src/spaces/index.ts')
  startSpaces({
    ...base,
    spaces: { ...base.spaces, serviceDid: 'did:web:appview.test', serviceFragment: 'hatk' },
  })
  expect(spaceServiceId()).toBe('did:web:appview.test#hatk')
})

test('stopping makes the instance unaddressable again', async () => {
  const { spaceServiceId } = await import('../src/spaces/index.ts')
  startSpaces({ ...base, spaces: { ...base.spaces, serviceDid: 'did:web:appview.test' } })
  stopSpaces()
  expect(spaceServiceId()).toBeNull()
})

test('the published document points an authority at this instance and carries no key', async () => {
  const { spaceDidDocument } = await import('../src/spaces/index.ts')
  const doc = spaceDidDocument('did:web:appview.test', 'https://appview.test', 'atproto_space_syncer') as any
  expect(doc.id).toBe('did:web:appview.test')
  expect(doc.service[0]).toEqual({
    id: '#atproto_space_syncer',
    type: 'AtprotoSpaceService',
    serviceEndpoint: 'https://appview.test',
  })
  expect(doc.verificationMethod).toBeUndefined()
})
