/**
 * Jetstream v2 live tail — an alternative stream source to the relay firehose.
 *
 * Where `com.atproto.sync.subscribeRepos` ships every commit on the network as
 * DAG-CBOR frames wrapping a CAR block store, Jetstream filters server-side and
 * delivers records as already-decoded JSON. For an AppView tracking a handful
 * of collections that is the difference between decoding the whole network and
 * decoding only what it indexes.
 *
 * What this trades away: the CAR/MST proofs. hatk never verified them — it
 * already trusts the relay — so nothing is lost that was being used. The
 * `getRepo` backfill path in backfill.ts still speaks CAR and is unaffected.
 *
 * @see https://bsky.network/docs/jetstream
 * @module
 */

import {
  applyCommit,
  configureIndexer,
  getLastSeq,
  handleIdentityEvent,
  isIndexableCollection,
  noteSeq,
  resumeCursor,
  setCursorKey,
  type CommitOp,
  type IndexerCoreOpts,
} from './indexer.ts'
import { log, emit } from './logger.ts'

/** Server-side filter caps, rejected before the WebSocket upgrade. */
export const MAX_COLLECTIONS = 100
export const MAX_DIDS = 10_000

/** Event kinds hatk consumes. `commit` carries records; `identity` drives handle renames. */
const KINDS = ['commit', 'identity'] as const

const RECONNECT_DELAY_MS = 3000

export interface JetstreamOpts extends IndexerCoreOpts {
  /** Instance base URL, e.g. `wss://jetstream.us-east.bsky.network`. */
  jetstreamUrl: string
  cursor?: string | null
}

/** A `#commit` payload as delivered by Jetstream v2. */
interface JetstreamCommit {
  did?: string
  seq?: number
  operation?: string
  collection?: string
  rkey?: string
  cid?: string
  record?: Record<string, any>
}

/**
 * Build the subscribe URL.
 *
 * Collections are sent explicitly rather than as an `ns.*` wildcard: a wildcard
 * would also match sibling NSIDs the app has no lexicon for (and, for private
 * collections, ones it must never accept from the network).
 *
 * Exported for tests.
 */
export function buildSubscribeUrl(
  jetstreamUrl: string,
  collections: Set<string>,
  pinnedRepos: Set<string> | null,
  cursor?: string | null,
): string {
  const params = new URLSearchParams()
  for (const collection of collections) params.append('collections', collection)
  for (const kind of KINDS) params.append('kinds', kind)
  if (pinnedRepos) {
    for (const did of pinnedRepos) params.append('dids', did)
  }
  if (cursor) params.append('cursor', cursor)
  return `${jetstreamUrl}/xrpc/network.bsky.jetstream.subscribeEvents?${params}`
}

/**
 * Reject filters the server would reject at the handshake, where the message
 * can name the actual limit instead of surfacing as a failed connection.
 * Exported for tests.
 */
export function assertFilterLimits(collections: Set<string>, pinnedRepos: Set<string> | null): void {
  if (collections.size > MAX_COLLECTIONS) {
    throw new Error(
      `Jetstream accepts at most ${MAX_COLLECTIONS} collections, got ${collections.size}. ` +
        `Narrow the indexed collections or use the relay firehose instead.`,
    )
  }
  if (pinnedRepos && pinnedRepos.size > MAX_DIDS) {
    throw new Error(
      `Jetstream accepts at most ${MAX_DIDS} dids, got ${pinnedRepos.size}. ` +
        `Unpin some repos or use the relay firehose instead.`,
    )
  }
}

/**
 * Translate one Jetstream commit payload into hatk's wire-agnostic op shape.
 *
 * Deletes carry no `record` or `cid` — only the collection and rkey that
 * identify what went away. Returns `null` when the payload is unusable or
 * names a collection this AppView must not accept from the network.
 *
 * Exported for tests.
 */
export function commitToOp(commit: JetstreamCommit, collections: Set<string>): CommitOp | null {
  const { collection, rkey, operation } = commit
  if (!collection || !rkey || !operation) return null
  if (!isIndexableCollection(collection, collections)) return null

  if (operation === 'delete') {
    return { action: 'delete', collection, rkey }
  }
  if (operation !== 'create' && operation !== 'update') return null
  if (!commit.cid || !commit.record) return null

  return { action: operation, collection, rkey, cid: commit.cid, record: commit.record }
}

/**
 * Handle one decoded frame. Kept synchronous so the socket's event queue drains
 * without backpressure — identity resolution is fire-and-forget, matching the
 * relay path.
 *
 * Exported for tests.
 */
export function processEvent(payload: any, collections: Set<string>): void {
  const kind = typeof payload?.$type === 'string' ? payload.$type.split('#')[1] : undefined

  if (kind === 'identity') {
    const did = typeof payload.did === 'string' ? payload.did : undefined
    const handle = typeof payload.handle === 'string' ? payload.handle : undefined
    if (did) handleIdentityEvent(did, handle)
    return
  }

  if (kind !== 'commit') return

  // Track sequence for the cursor before filtering: a stream of events for
  // collections we don't index still advances the position we must resume from.
  if (typeof payload.seq === 'number') noteSeq(payload.seq)

  const did = typeof payload.did === 'string' ? payload.did : undefined
  if (!did) return

  const op = commitToOp(payload as JetstreamCommit, collections)
  if (!op) return

  applyCommit(did, [op])
}

/**
 * Connect to a Jetstream v2 instance and begin indexing.
 *
 * Reconnects on disconnect after {@link RECONNECT_DELAY_MS}, resuming from the
 * highest seq seen rather than the boot-time cursor. Jetstream's cursor is
 * inclusive and delivery is at-least-once, so the event at the resume point
 * arrives again — harmless, since writes upsert on the record's `at://` URI.
 *
 * @returns The WebSocket connection (for shutdown coordination)
 */
export async function startJetstreamIndexer(opts: JetstreamOpts): Promise<WebSocket> {
  const { jetstreamUrl, collections, cursor } = opts
  const pinnedRepos = opts.pinnedRepos || null

  assertFilterLimits(collections, pinnedRepos)
  setCursorKey('jetstream')
  await configureIndexer(opts)

  const wsUrl = buildSubscribeUrl(jetstreamUrl, collections, pinnedRepos, cursor)
  if (cursor) log(`[jetstream] Resuming from cursor ${cursor}`)
  log(`[jetstream] Connecting to ${jetstreamUrl} (${collections.size} collections)...`)

  // The lexicon default is identical framing, so an empty subprotocol echo is
  // fine; we offer it so the server can pick the JSON arm explicitly.
  const ws = new WebSocket(wsUrl, ['xrpc.v1.json'])

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      if (typeof event.data !== 'string') return
      const frame = JSON.parse(event.data)
      // Events arrive wrapped in an envelope with the event under `payload`.
      if (frame?.payload) processEvent(frame.payload, collections)
    } catch (err: unknown) {
      emit('jetstream', 'decode_error', { error: err instanceof Error ? err.message : String(err) })
    }
  })

  ws.addEventListener('open', () => log('[jetstream] Connected'))
  ws.addEventListener('close', () => {
    log(`[jetstream] Disconnected, reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
    // Read the seq at close time, not connect time — reusing the boot cursor on
    // every reconnect would replay everything received since the process started.
    setTimeout(
      () => startJetstreamIndexer({ ...opts, cursor: resumeCursor(getLastSeq(), opts.cursor) }),
      RECONNECT_DELAY_MS,
    )
  })

  return ws
}
