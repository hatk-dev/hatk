/**
 * The socket end of the Jetstream tail. The behaviour that matters is what
 * happens when the handshake is refused rather than the stream dropped: a
 * cursor past Jetstream's ~1 day of retention is refused before `open`, so a
 * plain resume offers the same dead cursor forever and the stream wedges
 * silently while the app looks healthy.
 *
 * No real sockets: the WebSocket global is a stub exposing the same event
 * surface the client uses.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { setPrivateCollections } from '../src/private-collections.ts'
import { getCursor, querySQL, runSQL, setRepoStatus } from '../src/database/db.ts'
import { emit } from '../src/logger.ts'
import {
  _flushForTests,
  _resetCursorStateForTests,
  checkpointCursor,
  configureIndexer,
  jetstreamCursorKey,
} from '../src/indexer.ts'
import { CURSOR_PROBE_EVERY, MAX_COLLECTIONS, startJetstreamIndexer } from '../src/jetstream.ts'
import { jetstreamCommitFrame } from './firehose-frame.ts'

vi.mock('../src/logger.ts', { spy: true })

const DID = 'did:plc:jetsocket'
const COLLECTIONS = new Set([PUBLIC_COLLECTION])
const JETSTREAM = 'wss://jetstream.invalid'

/** Minimal stand-in for the WebSocket the client opens. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
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

  close(): void {}

  emitEvent(type: string, event: any = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
}

const baseOpts = {
  jetstreamUrl: JETSTREAM,
  plcUrl: 'http://plc.invalid',
  collections: COLLECTIONS,
  signalCollections: new Set<string>(),
  fetchTimeout: 1,
  maxRetries: 0,
  ftsRebuildInterval: 1_000_000,
}

/** better-sqlite3 resolves in microtasks, so draining them settles the async reconnect. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** Let the reconnect timer fire and the new attempt open its socket. */
async function reconnect(): Promise<FakeWebSocket> {
  await vi.advanceTimersByTimeAsync(3000)
  await settle()
  return FakeWebSocket.instances.at(-1)!
}

function lastUrl(): URL {
  return new URL(FakeWebSocket.instances.at(-1)!.url)
}

function refusalEvents(): Array<Record<string, any>> {
  return vi
    .mocked(emit)
    .mock.calls.filter(([mod, op]) => mod === 'jetstream' && op === 'handshake_refused')
    .map(([, , fields]) => fields as Record<string, any>)
}

async function rkeys(): Promise<string[]> {
  const rows = (await querySQL(`SELECT uri FROM "${PUBLIC_COLLECTION}" ORDER BY uri`)) as any[]
  return rows.map((r) => r.uri.split('/').pop())
}

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  await setRepoStatus(DID, 'active')
  // Warms the repo status cache so frames from this DID take the tracked path.
  await configureIndexer({ ...baseOpts, collections: COLLECTIONS })
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

// --- the subscription ------------------------------------------------------

test('the tail subscribes with the JSON subprotocol and the configured filters', async () => {
  const ws = (await startJetstreamIndexer(baseOpts)) as unknown as FakeWebSocket
  // The server picks the JSON arm from the subprotocol rather than guessing.
  expect(ws.protocols).toEqual(['xrpc.v1.json'])

  const url = new URL(ws.url)
  expect(url.pathname).toBe('/xrpc/network.bsky.jetstream.subscribeEvents')
  expect(url.searchParams.getAll('collections')).toEqual([PUBLIC_COLLECTION])
  expect(url.searchParams.getAll('kinds')).toEqual(['commit', 'identity'])
})

test('a boot cursor is offered on the first attempt', async () => {
  await startJetstreamIndexer({ ...baseOpts, cursor: '24943722777' })
  expect(lastUrl().searchParams.get('cursor')).toBe('24943722777')
})

test('filters the server would reject are refused before a socket is opened', async () => {
  const tooMany = new Set(Array.from({ length: MAX_COLLECTIONS + 1 }, (_, i) => `a.b.c${i}`))
  await expect(startJetstreamIndexer({ ...baseOpts, collections: tooMany })).rejects.toThrow(/at most 100 collections/)
  expect(FakeWebSocket.instances).toHaveLength(0)
})

// --- frames off the socket -------------------------------------------------

test('an event envelope off the socket is unwrapped and indexed', async () => {
  const ws = (await startJetstreamIndexer(baseOpts)) as unknown as FakeWebSocket
  ws.emitEvent('open')
  ws.emitEvent('message', {
    data: jetstreamCommitFrame(DID, 24664288881, {
      action: 'create',
      collection: PUBLIC_COLLECTION,
      rkey: 'j1',
      record: { $type: PUBLIC_COLLECTION, text: 'j1' },
    }),
  })
  await _flushForTests()

  expect(await rkeys()).toEqual(['j1'])
  // The seq rides the same cursor machinery as the relay, under its own key.
  await checkpointCursor()
  expect(await getCursor(jetstreamCursorKey(JETSTREAM))).toBe('24664288881')
  expect(await getCursor('relay')).toBeNull()
})

test('two instances keep their own cursors', async () => {
  // A Jetstream seq addresses a position on the instance that issued it and
  // nothing on any other. Sharing one row across instances hands a number from
  // somewhere else to whichever is pointed at next — no error, no refusal, and
  // the stream resumes past whatever fell in between. Found that way: an
  // instance went to 503, the deployment moved region, and a day of records
  // were skipped in silence.
  const other = 'wss://jetstream.elsewhere.invalid'
  const ws = (await startJetstreamIndexer(baseOpts)) as unknown as FakeWebSocket
  ws.emitEvent('open')
  ws.emitEvent('message', {
    data: jetstreamCommitFrame(DID, 11111111111, {
      action: 'create',
      collection: PUBLIC_COLLECTION,
      rkey: 'from-first',
      record: { $type: PUBLIC_COLLECTION, text: 'first' },
    }),
  })
  await _flushForTests()
  await checkpointCursor()

  const second = (await startJetstreamIndexer({
    ...baseOpts,
    jetstreamUrl: other,
  })) as unknown as FakeWebSocket
  second.emitEvent('open')
  second.emitEvent('message', {
    data: jetstreamCommitFrame(DID, 22222222222, {
      action: 'create',
      collection: PUBLIC_COLLECTION,
      rkey: 'from-second',
      record: { $type: PUBLIC_COLLECTION, text: 'second' },
    }),
  })
  await _flushForTests()
  await checkpointCursor()

  expect(await getCursor(jetstreamCursorKey(JETSTREAM))).toBe('11111111111')
  expect(await getCursor(jetstreamCursorKey(other))).toBe('22222222222')
})

test('a frame with no payload is ignored', async () => {
  const ws = (await startJetstreamIndexer(baseOpts)) as unknown as FakeWebSocket
  // Jetstream sends envelopes hatk does not consume (options acks, heartbeats).
  ws.emitEvent('message', { data: JSON.stringify({ $type: 'message' }) })
  await _flushForTests()
  expect(await rkeys()).toEqual([])
})

test('a binary frame on the JSON stream is ignored', async () => {
  const ws = (await startJetstreamIndexer(baseOpts)) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: new Uint8Array([1, 2, 3]).buffer })
  await _flushForTests()
  expect(await rkeys()).toEqual([])
  expect(vi.mocked(emit).mock.calls.filter(([, op]) => op === 'decode_error')).toHaveLength(0)
})

test('malformed JSON is reported as a decode error and the socket keeps indexing', async () => {
  const ws = (await startJetstreamIndexer(baseOpts)) as unknown as FakeWebSocket
  ws.emitEvent('message', { data: '{"payload": ' })

  const errors = vi.mocked(emit).mock.calls.filter(([mod, op]) => mod === 'jetstream' && op === 'decode_error')
  expect(errors).toHaveLength(1)

  ws.emitEvent('message', {
    data: jetstreamCommitFrame(DID, 2, {
      action: 'create',
      collection: PUBLIC_COLLECTION,
      rkey: 'after',
      record: { $type: PUBLIC_COLLECTION, text: 'after' },
    }),
  })
  await _flushForTests()
  expect(await rkeys()).toEqual(['after'])
})

// --- reconnects ------------------------------------------------------------

test('a stream that drops after opening reconnects without counting a refusal', async () => {
  vi.useFakeTimers()
  const ws = (await startJetstreamIndexer({ ...baseOpts, cursor: '100' })) as unknown as FakeWebSocket
  ws.emitEvent('open')
  ws.emitEvent('close', { code: 1006, reason: '' })

  expect(FakeWebSocket.instances).toHaveLength(1)
  const next = await reconnect()

  expect(FakeWebSocket.instances).toHaveLength(2)
  // A dropped stream is not evidence against the cursor, so it is offered again.
  expect(new URL(next.url).searchParams.get('cursor')).toBe('100')
  expect(refusalEvents()).toEqual([])
})

test('a close that never opened is reported as a refused handshake', async () => {
  vi.useFakeTimers()
  const ws = (await startJetstreamIndexer({ ...baseOpts, cursor: '100' })) as unknown as FakeWebSocket
  ws.emitEvent('close', { code: 1006, reason: 'cursor in the future' })
  await reconnect()

  expect(refusalEvents()).toEqual([{ code: 1006, reason: 'cursor in the future', cursor: '100', refusals: 1 }])
})

test('a refused handshake with no reason still reports its close code', async () => {
  vi.useFakeTimers()
  const ws = (await startJetstreamIndexer(baseOpts)) as unknown as FakeWebSocket
  ws.emitEvent('close', { code: 1006, reason: '' })
  await reconnect()

  expect(refusalEvents()[0]).toMatchObject({ code: 1006, cursor: null })
  expect(refusalEvents()[0].reason).toBeUndefined()
})

test('consecutive refusals drop the cursor to probe the live tip, then keep it again', async () => {
  vi.useFakeTimers()
  let ws = (await startJetstreamIndexer({ ...baseOpts, cursor: '24943722777' })) as unknown as FakeWebSocket

  // Refusals below the threshold could still be the network, so the cursor stays.
  for (let i = 1; i < CURSOR_PROBE_EVERY; i++) {
    ws.emitEvent('close', { code: 1006, reason: '' })
    ws = await reconnect()
    expect(lastUrl().searchParams.get('cursor')).toBe('24943722777')
  }

  // The Nth refusal probes without a cursor: a reachable instance always
  // accepts a cursorless subscribe, so an open here means the cursor was dead.
  ws.emitEvent('close', { code: 1006, reason: '' })
  ws = await reconnect()
  expect(lastUrl().searchParams.has('cursor')).toBe(false)

  // The probe was refused too, so the instance is down and the cursor is still
  // worth keeping.
  ws.emitEvent('close', { code: 1006, reason: '' })
  await reconnect()
  expect(lastUrl().searchParams.get('cursor')).toBe('24943722777')
})

test('a successful open resets the refusal count, so the next drop starts over', async () => {
  vi.useFakeTimers()
  let ws = (await startJetstreamIndexer({ ...baseOpts, cursor: '24943722777' })) as unknown as FakeWebSocket
  ws.emitEvent('close', { code: 1006, reason: '' })
  ws = await reconnect()

  // This attempt got through — whatever the earlier refusals were, they are over.
  ws.emitEvent('open')
  ws.emitEvent('close', { code: 1006, reason: '' })
  ws = await reconnect()
  expect(refusalEvents()).toHaveLength(1)

  // A fresh run of refusals has to start from one again, not from the old count.
  ws.emitEvent('close', { code: 1006, reason: '' })
  await reconnect()
  expect(refusalEvents().at(-1)!.refusals).toBe(1)
  expect(lastUrl().searchParams.get('cursor')).toBe('24943722777')
})
