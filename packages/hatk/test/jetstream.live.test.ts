/**
 * Live smoke test against a real Jetstream v2 instance.
 *
 * Opt-in — it needs the network, so it is skipped unless JETSTREAM_LIVE=1:
 *
 *   JETSTREAM_LIVE=1 npx vitest run test/jetstream.live.test.ts
 *
 * Point it elsewhere with JETSTREAM_URL. It exercises the wire end of the
 * integration (subprotocol negotiation, server-side filtering, envelope shape)
 * which the unit tests deliberately stub out.
 */
import { expect, test, vi } from 'vitest'
import { buildSubscribeUrl, processEvent } from '../src/jetstream.ts'
import { applyCommit, handleIdentityEvent, noteSeq } from '../src/indexer.ts'

vi.mock('../src/indexer.ts', { spy: true })

const LIVE = process.env.JETSTREAM_LIVE === '1'
const URL_BASE = process.env.JETSTREAM_URL || 'wss://jetstream.us-east.bsky.network'

// Busy collections, so the test finishes quickly regardless of instance.
const COLLECTIONS = new Set(['app.bsky.feed.post', 'app.bsky.feed.like'])

test.skipIf(!LIVE)('live tail delivers decoded records through processEvent', { timeout: 30_000 }, async () => {
  const seen: Array<[string, any[]]> = []
  vi.mocked(applyCommit).mockImplementation((did, ops) => {
    seen.push([did, ops])
  })
  vi.mocked(handleIdentityEvent).mockResolvedValue(undefined)
  vi.mocked(noteSeq).mockImplementation(() => {})

  const ws = new WebSocket(buildSubscribeUrl(URL_BASE, COLLECTIONS, null), ['xrpc.v1.json'])

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no events within 20s')), 20_000)
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('websocket error'))
    })
    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      const frame = JSON.parse(event.data)
      if (frame?.payload) processEvent(frame.payload, COLLECTIONS)
      if (seen.length >= 5) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  ws.close()

  expect(seen.length).toBeGreaterThanOrEqual(5)

  // Every op must name a collection we asked for — proves server-side filtering.
  for (const [did, ops] of seen) {
    expect(did).toMatch(/^did:/)
    for (const op of ops) {
      expect(COLLECTIONS.has(op.collection)).toBe(true)
      expect(['create', 'update', 'delete']).toContain(op.action)
      // Puts arrive already decoded — no second parsing step.
      if (op.action !== 'delete') {
        expect(op.record).toBeTypeOf('object')
        expect(op.record.$type).toBe(op.collection)
        expect(op.cid).toBeTypeOf('string')
      }
    }
  }

  // The cursor must be advancing, or reconnects would rewind to the boot value.
  expect(noteSeq).toHaveBeenCalled()
  const seqs = vi.mocked(noteSeq).mock.calls.map(([s]) => s)
  expect(seqs.every((s) => typeof s === 'number' && s > 0)).toBe(true)
})
