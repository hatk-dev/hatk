import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setPrivateCollections } from '../src/private-collections.ts'
import {
  MAX_COLLECTIONS,
  MAX_DIDS,
  assertFilterLimits,
  buildSubscribeUrl,
  commitToOp,
  processEvent,
} from '../src/jetstream.ts'
import { applyCommit, handleIdentityEvent, noteSeq } from '../src/indexer.ts'

vi.mock('../src/indexer.ts', { spy: true })

const COLLECTIONS = new Set(['social.grain.photo', 'social.grain.gallery'])

function commitEvent(overrides: Record<string, any> = {}) {
  return {
    $type: 'network.bsky.jetstream.subscribeEvents#commit',
    did: 'did:plc:alice',
    seq: 24664288881,
    time: '2026-08-13T06:47:43.959305Z',
    operation: 'create',
    collection: 'social.grain.photo',
    rkey: '3msx2efqdxs27',
    rev: '3msx2efqjtc27',
    cid: 'bafyreigwnxqttkhzha2ig4io6wwht3qiugtor4ruglceyfdbnyq53a55fe',
    record: { $type: 'social.grain.photo', createdAt: '2026-08-13T06:47:44.859Z' },
    ...overrides,
  }
}

beforeEach(() => {
  setPrivateCollections([])
  vi.mocked(applyCommit).mockImplementation(() => {})
  vi.mocked(handleIdentityEvent).mockResolvedValue(undefined)
  vi.mocked(noteSeq).mockImplementation(() => {})
})

afterEach(() => {
  vi.mocked(applyCommit).mockReset()
  vi.mocked(handleIdentityEvent).mockReset()
  vi.mocked(noteSeq).mockReset()
})

// --- buildSubscribeUrl -----------------------------------------------------

test('buildSubscribeUrl sends each collection explicitly rather than a wildcard', () => {
  const url = new URL(buildSubscribeUrl('wss://js.example', COLLECTIONS, null))
  expect(url.pathname).toBe('/xrpc/network.bsky.jetstream.subscribeEvents')
  expect(url.searchParams.getAll('collections')).toEqual(['social.grain.photo', 'social.grain.gallery'])
  expect(url.toString()).not.toContain('*')
})

test('buildSubscribeUrl requests commit and identity kinds', () => {
  const url = new URL(buildSubscribeUrl('wss://js.example', COLLECTIONS, null))
  // A collections filter constrains commits only, so a commits-only stream
  // needs kinds — but dropping identity would break handle renames.
  expect(url.searchParams.getAll('kinds')).toEqual(['commit', 'identity'])
})

test('buildSubscribeUrl omits the cursor when starting from the live tip', () => {
  const url = new URL(buildSubscribeUrl('wss://js.example', COLLECTIONS, null, null))
  expect(url.searchParams.has('cursor')).toBe(false)
})

test('buildSubscribeUrl passes the cursor through when resuming', () => {
  const url = new URL(buildSubscribeUrl('wss://js.example', COLLECTIONS, null, '12345'))
  expect(url.searchParams.get('cursor')).toBe('12345')
})

test('buildSubscribeUrl narrows to pinned repos when configured', () => {
  const url = new URL(buildSubscribeUrl('wss://js.example', COLLECTIONS, new Set(['did:plc:a', 'did:plc:b'])))
  expect(url.searchParams.getAll('dids')).toEqual(['did:plc:a', 'did:plc:b'])
})

// --- assertFilterLimits ----------------------------------------------------

test('assertFilterLimits accepts filters within the server caps', () => {
  expect(() => assertFilterLimits(COLLECTIONS, new Set(['did:plc:a']))).not.toThrow()
})

test('assertFilterLimits rejects too many collections before the handshake', () => {
  const tooMany = new Set(Array.from({ length: MAX_COLLECTIONS + 1 }, (_, i) => `a.b.c${i}`))
  expect(() => assertFilterLimits(tooMany, null)).toThrow(/at most 100 collections, got 101/)
})

test('assertFilterLimits rejects too many pinned dids before the handshake', () => {
  const tooMany = new Set(Array.from({ length: MAX_DIDS + 1 }, (_, i) => `did:plc:${i}`))
  expect(() => assertFilterLimits(COLLECTIONS, tooMany)).toThrow(/at most 10000 dids/)
})

// --- commitToOp ------------------------------------------------------------

test('commitToOp maps a create to a create op carrying cid and record', () => {
  const op = commitToOp(commitEvent(), COLLECTIONS)
  expect(op).toEqual({
    action: 'create',
    collection: 'social.grain.photo',
    rkey: '3msx2efqdxs27',
    cid: 'bafyreigwnxqttkhzha2ig4io6wwht3qiugtor4ruglceyfdbnyq53a55fe',
    record: { $type: 'social.grain.photo', createdAt: '2026-08-13T06:47:44.859Z' },
  })
})

test('commitToOp maps an update to an update op', () => {
  expect(commitToOp(commitEvent({ operation: 'update' }), COLLECTIONS)?.action).toBe('update')
})

test('commitToOp maps a delete, which carries no record or cid', () => {
  const op = commitToOp(
    { did: 'did:plc:alice', operation: 'delete', collection: 'social.grain.photo', rkey: '3msx2efqdxs27' },
    COLLECTIONS,
  )
  expect(op).toEqual({ action: 'delete', collection: 'social.grain.photo', rkey: '3msx2efqdxs27' })
})

test('commitToOp drops collections this AppView does not index', () => {
  expect(commitToOp(commitEvent({ collection: 'app.bsky.feed.like' }), COLLECTIONS)).toBeNull()
})

test('commitToOp drops private collections even though the server sent them', () => {
  // Private collections are AppView-authoritative — an op naming one is
  // spoofed by definition, whichever source delivered it.
  setPrivateCollections(['social.grain.photo'])
  expect(commitToOp(commitEvent(), COLLECTIONS)).toBeNull()
})

test('commitToOp drops a private-collection delete too', () => {
  setPrivateCollections(['social.grain.photo'])
  const op = commitToOp({ operation: 'delete', collection: 'social.grain.photo', rkey: 'abc' }, COLLECTIONS)
  expect(op).toBeNull()
})

test('commitToOp drops a put missing its cid or record', () => {
  expect(commitToOp(commitEvent({ cid: undefined }), COLLECTIONS)).toBeNull()
  expect(commitToOp(commitEvent({ record: undefined }), COLLECTIONS)).toBeNull()
})

test('commitToOp drops an unknown operation rather than guessing', () => {
  expect(commitToOp(commitEvent({ operation: 'frobnicate' }), COLLECTIONS)).toBeNull()
})

// --- processEvent ----------------------------------------------------------

test('processEvent routes a commit to applyCommit', () => {
  processEvent(commitEvent(), COLLECTIONS)
  expect(applyCommit).toHaveBeenCalledWith('did:plc:alice', [
    expect.objectContaining({ action: 'create', collection: 'social.grain.photo' }),
  ])
})

test('processEvent records the seq even when the commit is filtered out', () => {
  // The cursor must advance past events we do not index, or a reconnect
  // rewinds to before them and re-reads the whole span.
  processEvent(commitEvent({ collection: 'app.bsky.feed.like' }), COLLECTIONS)
  expect(noteSeq).toHaveBeenCalledWith(24664288881)
  expect(applyCommit).not.toHaveBeenCalled()
})

test('processEvent routes an identity event to the handle updater', () => {
  processEvent(
    {
      $type: 'network.bsky.jetstream.subscribeEvents#identity',
      did: 'did:plc:alice',
      handle: 'alice.example',
    },
    COLLECTIONS,
  )
  expect(handleIdentityEvent).toHaveBeenCalledWith('did:plc:alice', 'alice.example')
})

test('processEvent passes an identity event with no handle through for re-resolution', () => {
  processEvent({ $type: 'network.bsky.jetstream.subscribeEvents#identity', did: 'did:plc:alice' }, COLLECTIONS)
  expect(handleIdentityEvent).toHaveBeenCalledWith('did:plc:alice', undefined)
})

test('processEvent ignores kinds hatk does not consume', () => {
  processEvent({ $type: 'network.bsky.jetstream.subscribeEvents#account', did: 'did:plc:alice' }, COLLECTIONS)
  expect(applyCommit).not.toHaveBeenCalled()
  expect(handleIdentityEvent).not.toHaveBeenCalled()
})

test('processEvent ignores a commit with no did', () => {
  processEvent(commitEvent({ did: undefined }), COLLECTIONS)
  expect(applyCommit).not.toHaveBeenCalled()
})

test('processEvent survives an unrecognised payload shape', () => {
  expect(() => processEvent({}, COLLECTIONS)).not.toThrow()
  expect(() => processEvent(null, COLLECTIONS)).not.toThrow()
  expect(applyCommit).not.toHaveBeenCalled()
})
