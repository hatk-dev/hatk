/**
 * Jetstream payloads arrive as JSON from a server, which means the shapes that
 * reach `processEvent` are whatever the socket carried — not whatever the
 * interface says. These are the malformed and half-filled payloads: a commit
 * missing the fields that identify what it touched, an identity event whose
 * `did` is not a string, a seq that arrived as text.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setPrivateCollections } from '../src/private-collections.ts'
import { commitToOp, processEvent } from '../src/jetstream.ts'
import { applyCommit, handleIdentityEvent, noteSeq } from '../src/indexer.ts'

vi.mock('../src/indexer.ts', { spy: true })

const COLLECTIONS = new Set(['social.grain.photo'])

function commitEvent(overrides: Record<string, any> = {}) {
  return {
    $type: 'network.bsky.jetstream.subscribeEvents#commit',
    did: 'did:plc:alice',
    seq: 24664288881,
    operation: 'create',
    collection: 'social.grain.photo',
    rkey: '3msx2efqdxs27',
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

test('commitToOp drops a commit that does not say what it touched', () => {
  // Without all three of collection, rkey and operation there is no URI to
  // write and no verb to write it with.
  expect(commitToOp(commitEvent({ collection: undefined }), COLLECTIONS)).toBeNull()
  expect(commitToOp(commitEvent({ rkey: undefined }), COLLECTIONS)).toBeNull()
  expect(commitToOp(commitEvent({ operation: undefined }), COLLECTIONS)).toBeNull()
  expect(commitToOp({}, COLLECTIONS)).toBeNull()
})

test('commitToOp drops an rkey that is present but empty', () => {
  // An empty rkey would build `at://did/collection/`, a URI that matches nothing.
  expect(commitToOp(commitEvent({ rkey: '' }), COLLECTIONS)).toBeNull()
})

test('processEvent ignores an identity event whose did is not a string', () => {
  processEvent({ $type: 'network.bsky.jetstream.subscribeEvents#identity', did: 12345 }, COLLECTIONS)
  expect(handleIdentityEvent).not.toHaveBeenCalled()
})

test('processEvent treats a non-string handle as no handle and re-resolves', () => {
  processEvent(
    { $type: 'network.bsky.jetstream.subscribeEvents#identity', did: 'did:plc:alice', handle: null },
    COLLECTIONS,
  )
  expect(handleIdentityEvent).toHaveBeenCalledWith('did:plc:alice', undefined)
})

test('processEvent ignores a seq that is not a number', () => {
  // Persisting a non-numeric cursor would have the next resume rejected at the
  // handshake, which is the failure that wedges the stream for good.
  processEvent(commitEvent({ seq: '24664288881' }), COLLECTIONS)
  expect(noteSeq).not.toHaveBeenCalled()
  // The commit itself is still indexed — only the cursor is withheld.
  expect(applyCommit).toHaveBeenCalled()
})

test('processEvent ignores a payload whose $type is not a string', () => {
  processEvent({ $type: 42, did: 'did:plc:alice' }, COLLECTIONS)
  expect(applyCommit).not.toHaveBeenCalled()
  expect(handleIdentityEvent).not.toHaveBeenCalled()
})

test('processEvent records the seq of a commit it then drops as unusable', () => {
  // The event was delivered; the cursor has to move past it even though there
  // is nothing indexable in it.
  processEvent(commitEvent({ operation: 'frobnicate' }), COLLECTIONS)
  expect(noteSeq).toHaveBeenCalledWith(24664288881)
  expect(applyCommit).not.toHaveBeenCalled()
})
