/**
 * The socket end of the relay indexer: what URL it subscribes to, what it does
 * with a frame that is not what it expected, and whether a dropped connection
 * comes back resuming from the right place. A reconnect that resumes from the
 * boot cursor instead of the live seq replays everything since boot; one that
 * resumes from nothing replays the relay's whole retention window.
 *
 * No real sockets: the WebSocket global is a stub exposing the same event
 * surface the indexer uses.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { getCursor, querySQL, runSQL, setCursor, setRepoStatus } from '../src/database/db.ts'
import { emit } from '../src/logger.ts'
import {
  _flushForTests,
  _resetCursorStateForTests,
  auxCursorKey,
  configureIndexer,
  startAuxIndexer,
  startIndexer,
} from '../src/indexer.ts'
import { buildCommitFrame } from './firehose-frame.ts'

vi.mock('../src/database/db.ts', { spy: true })
vi.mock('../src/logger.ts', { spy: true })

const DID = 'did:plc:socketeer'
const COLLECTIONS = new Set([PUBLIC_COLLECTION])
const RELAY = 'wss://relay.invalid'
const AUX = 'ws://pds.invalid:4000'

/** Minimal stand-in for the WebSocket the indexer opens. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  binaryType = ''
  closed = false
  private listeners = new Map<string, Array<(event: any) => void>>()

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: (event: any) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed = true
  }

  /** Deliver an event the way the runtime would. */
  emitEvent(type: string, event: any = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
}

/** The exact ArrayBuffer a binary frame arrives as. */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function commit(seq: number, rkey: string): ArrayBuffer {
  return asArrayBuffer(
    buildCommitFrame(DID, seq, [
      {
        action: 'create',
        collection: PUBLIC_COLLECTION,
        rkey,
        record: { $type: PUBLIC_COLLECTION, text: rkey },
      },
    ]),
  )
}

async function rkeys(): Promise<string[]> {
  const rows = (await querySQL(`SELECT uri FROM "${PUBLIC_COLLECTION}" ORDER BY uri`)) as any[]
  return rows.map((r) => r.uri.split('/').pop())
}

function decodeErrors(): Array<Record<string, any>> {
  return vi
    .mocked(emit)
    .mock.calls.filter(([mod, op]) => mod === 'indexer' && op === 'decode_error')
    .map(([, , fields]) => fields as Record<string, any>)
}

/** better-sqlite3 resolves in microtasks, so draining them settles the async reconnect. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const baseOpts = {
  relayUrl: RELAY,
  plcUrl: 'http://plc.invalid',
  collections: COLLECTIONS,
  signalCollections: new Set<string>(),
  fetchTimeout: 1,
  maxRetries: 0,
  ftsRebuildInterval: 1_000_000,
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  await setRepoStatus(DID, 'active')
  // Warm the repo status cache before any socket opens, so frames from this DID
  // take the already-tracked path.
  await configureIndexer(baseOpts)
})

beforeEach(async () => {
  setPrivateCollections([])
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  await runSQL(`DELETE FROM _cursor`)
  _resetCursorStateForTests()
  FakeWebSocket.instances = []
  vi.mocked(emit).mockClear()
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await _flushForTests()
})

// --- the relay subscription -----------------------------------------------

test('the indexer subscribes to subscribeRepos in binary mode', async () => {
  const ws = (await startIndexer(baseOpts)) as unknown as FakeWebSocket
  expect(ws.url).toBe(`${RELAY}/xrpc/com.atproto.sync.subscribeRepos`)
  // ArrayBuffer, not Blob: the frame is decoded synchronously in the handler.
  expect(ws.binaryType).toBe('arraybuffer')
})

test('a boot cursor is offered on the subscribe URL', async () => {
  const ws = (await startIndexer({ ...baseOpts, cursor: '12345' })) as unknown as FakeWebSocket
  expect(ws.url).toBe(`${RELAY}/xrpc/com.atproto.sync.subscribeRepos?cursor=12345`)
})

test('a binary commit frame off the socket becomes a row', async () => {
  const ws = (await startIndexer(baseOpts)) as unknown as FakeWebSocket
  ws.emitEvent('open')
  ws.emitEvent('message', { data: commit(10, 'wired') })
  await _flushForTests()
  expect(await rkeys()).toEqual(['wired'])
})

test('a text frame on the binary stream is ignored rather than decoded', async () => {
  // subscribeRepos is binary-only; a text frame is a proxy or a misconfigured
  // endpoint, not a commit, and must not register as a decode failure either.
  const ws = (await startIndexer(baseOpts)) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: '{"hello":"world"}' })
  await _flushForTests()
  expect(await rkeys()).toEqual([])
  expect(decodeErrors()).toEqual([])
})

test('a frame that fails to decode is reported and the socket keeps indexing', async () => {
  const ws = (await startIndexer(baseOpts)) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: asArrayBuffer(new Uint8Array([0xff, 0xff, 0xff])) })

  expect(decodeErrors()).toHaveLength(1)
  expect(decodeErrors()[0].error).toBeTruthy()

  // The stream survives it — one bad frame is not a reason to drop the tail.
  ws.emitEvent('message', { data: commit(11, 'after-garbage') })
  await _flushForTests()
  expect(await rkeys()).toEqual(['after-garbage'])
})

test('a disconnect reconnects after 3s resuming from the last seq seen', async () => {
  vi.useFakeTimers()
  const ws = (await startIndexer({ ...baseOpts, cursor: '1' })) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: commit(900, 'beforedrop') })
  ws.emitEvent('close')

  // Nothing reconnects instantly: a relay that just dropped us does not want a
  // reconnect storm.
  expect(FakeWebSocket.instances).toHaveLength(1)

  await vi.advanceTimersByTimeAsync(3000)
  await settle()

  expect(FakeWebSocket.instances).toHaveLength(2)
  // 900, not the boot cursor 1 — resuming from boot would replay everything
  // received since the process started.
  expect(FakeWebSocket.instances[1].url).toContain('cursor=900')
})

test('a disconnect before any event resumes from the boot cursor', async () => {
  vi.useFakeTimers()
  const ws = (await startIndexer({ ...baseOpts, cursor: '4242' })) as unknown as FakeWebSocket
  ws.emitEvent('close')
  await vi.advanceTimersByTimeAsync(3000)
  await settle()

  expect(FakeWebSocket.instances[1].url).toContain('cursor=4242')
})

// --- auxiliary streams -----------------------------------------------------

test('an aux stream subscribes to its own relay and indexes what arrives', async () => {
  const ws = startAuxIndexer({ relayUrl: AUX, collections: COLLECTIONS }) as unknown as FakeWebSocket
  expect(ws.url).toBe(`${AUX}/xrpc/com.atproto.sync.subscribeRepos`)
  expect(ws.binaryType).toBe('arraybuffer')

  ws.emitEvent('open')
  ws.emitEvent('message', { data: commit(70, 'fromaux') })
  await _flushForTests()
  expect(await rkeys()).toEqual(['fromaux'])
})

test('an aux stream checkpoints to its own cursor row, never the primary one', async () => {
  vi.useFakeTimers()
  const ws = startAuxIndexer({ relayUrl: AUX, collections: COLLECTIONS }) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: commit(555, 'auxseq') })

  await vi.advanceTimersByTimeAsync(5000)
  await settle()

  expect(await getCursor(auxCursorKey(AUX))).toBe('555')
  // A PDS seq read as a relay cursor would resume subscribeRepos from a
  // nonsense offset.
  expect(await getCursor('relay')).toBeNull()
})

test('an aux stream with no traffic writes no cursor at all', async () => {
  // A quiet PDS must not have a cursor row invented for it; resuming from one
  // the stream never reached would skip whatever it did send.
  vi.useFakeTimers()
  startAuxIndexer({ relayUrl: AUX, collections: COLLECTIONS })

  await vi.advanceTimersByTimeAsync(15_000)
  await settle()

  expect(await getCursor(auxCursorKey(AUX))).toBeNull()
})

test('an aux checkpoint that fails is reported against its source and retried', async () => {
  vi.useFakeTimers()
  const ws = startAuxIndexer({ relayUrl: AUX, collections: COLLECTIONS }) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: commit(556, 'auxfail') })

  vi.mocked(setCursor).mockRejectedValueOnce(new Error('db busy'))
  await vi.advanceTimersByTimeAsync(5000)
  await settle()

  const failure = vi
    .mocked(emit)
    .mock.calls.find(([mod, op]) => mod === 'indexer' && op === 'cursor_checkpoint_error')![2] as Record<string, any>
  expect(failure.source).toBe(AUX)
  expect(failure.cursor_seq).toBe(556)

  // The seq was never marked persisted, so the next tick writes it.
  await vi.advanceTimersByTimeAsync(5000)
  await settle()
  expect(await getCursor(auxCursorKey(AUX))).toBe('556')
})

test('a bad aux frame reports a decode error naming the source that sent it', async () => {
  // With more than one stream running, an error that does not name its source
  // is unactionable.
  const ws = startAuxIndexer({ relayUrl: AUX, collections: COLLECTIONS }) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: asArrayBuffer(new Uint8Array([0xff, 0xff])) })
  ws.emitEvent('message', { data: 'not binary' })

  expect(decodeErrors()).toHaveLength(1)
  expect(decodeErrors()[0].source).toBe(AUX)
})

test('an aux disconnect reconnects to the same relay with its own seq', async () => {
  vi.useFakeTimers()
  const ws = startAuxIndexer({ relayUrl: AUX, collections: COLLECTIONS, cursor: '3' }) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: commit(777, 'auxdrop') })
  ws.emitEvent('close')

  await vi.advanceTimersByTimeAsync(3000)
  await settle()

  expect(FakeWebSocket.instances).toHaveLength(2)
  expect(FakeWebSocket.instances[1].url).toBe(`${AUX}/xrpc/com.atproto.sync.subscribeRepos?cursor=777`)
})
