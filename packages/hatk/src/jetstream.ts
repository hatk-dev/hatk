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
  handleAccountEvent,
  isIndexableCollection,
  jetstreamCursorKey,
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

/**
 * Event kinds hatk consumes. `commit` carries records; `identity` drives handle
 * renames; `account` says an account was deactivated, deleted, or came back.
 */
const KINDS = ['commit', 'identity', 'account'] as const

const RECONNECT_DELAY_MS = 3000

/**
 * Refused handshakes before the next attempt drops its cursor and probes live.
 *
 * Jetstream retains roughly a day of seqs. A cursor older than that is refused
 * at the handshake — a bare close 1006, no `open`, no message. Nothing arrives,
 * so {@link getLastSeq} stays null and a plain resume offers the same dead
 * cursor forever. Restarting does not clear it either: the boot cursor is read
 * back from the row this stream never got to advance. The stream wedges for
 * good, while records written through the AppView's own path keep indexing, so
 * nothing looks broken from inside the app.
 *
 * A cursorless probe tells a dead cursor from a dead instance without guessing:
 * a reachable instance always accepts a cursorless subscribe, so a probe that
 * opens means the cursor was the problem, and a probe that is refused too means
 * the instance is down and the cursor is still worth keeping. Probing every Nth
 * attempt rather than once keeps that true across an outage of any length.
 */
export const CURSOR_PROBE_EVERY = 3

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

  if (kind === 'account') {
    // Jetstream nests the status: `{ did, seq, account: { active, status } }`,
    // unlike the relay's flat #account frame.
    const did = typeof payload.did === 'string' ? payload.did : undefined
    const account = payload.account ?? {}
    const status = typeof account.status === 'string' ? account.status : undefined
    if (did) void handleAccountEvent(did, account.active === true, status)
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
 * The cursor a connection attempt should offer, given how many attempts in a
 * row were refused before it.
 *
 * `refusals` counts consecutive closes that never reached `open`; it resets the
 * moment one does. Every {@link CURSOR_PROBE_EVERY}th refusal answers null so
 * the attempt subscribes to the live tip instead — see the constant for why
 * that is the discriminator.
 *
 * Exported for tests.
 */
export function reconnectCursor(
  refusals: number,
  liveSeq: number | null,
  bootCursor: string | null | undefined,
): string | null | undefined {
  const resume = resumeCursor(liveSeq, bootCursor)
  // Nothing to abandon — an attempt with no cursor is already a live tail.
  if (!resume) return resume
  return refusals > 0 && refusals % CURSOR_PROBE_EVERY === 0 ? null : resume
}

/**
 * Connect to a Jetstream v2 instance and begin indexing.
 *
 * Reconnects on disconnect after {@link RECONNECT_DELAY_MS}, resuming from the
 * highest seq seen rather than the boot-time cursor. Jetstream's cursor is
 * inclusive and delivery is at-least-once, so the event at the resume point
 * arrives again — harmless, since writes upsert on the record's `at://` URI.
 *
 * `opts.cursor` is the boot-time cursor and stays fixed across reconnects;
 * what each attempt actually offers comes from {@link reconnectCursor}, so a
 * live probe can drop the cursor for one attempt without losing it.
 *
 * @param refusals Consecutive refused handshakes so far. Internal — reconnects
 *   pass their own count; callers start at 0.
 * @returns The WebSocket connection (for shutdown coordination)
 */
export async function startJetstreamIndexer(opts: JetstreamOpts, refusals = 0): Promise<WebSocket> {
  const { jetstreamUrl, collections } = opts
  const pinnedRepos = opts.pinnedRepos || null

  assertFilterLimits(collections, pinnedRepos)
  setCursorKey(jetstreamCursorKey(opts.jetstreamUrl))
  await configureIndexer(opts)

  const cursor = reconnectCursor(refusals, getLastSeq(), opts.cursor)
  const wsUrl = buildSubscribeUrl(jetstreamUrl, collections, pinnedRepos, cursor)
  if (cursor) log(`[jetstream] Resuming from cursor ${cursor}`)
  else if (refusals > 0) log('[jetstream] Probing the live tip — the resume cursor keeps being refused')
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

  let opened = false
  ws.addEventListener('open', () => {
    opened = true
    log('[jetstream] Connected')
  })
  ws.addEventListener('close', (event: CloseEvent) => {
    // A close that never reached `open` is a refused handshake, not a dropped
    // stream, and the two want opposite things from the cursor.
    const nextRefusals = opened ? 0 : refusals + 1
    if (opened) {
      log(`[jetstream] Disconnected (${event.code}), reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
    } else {
      log(
        `[jetstream] Handshake refused (${event.code}${event.reason ? `: ${event.reason}` : ''}) ` +
          `x${nextRefusals}, retrying in ${RECONNECT_DELAY_MS / 1000}s...`,
      )
      emit('jetstream', 'handshake_refused', {
        code: event.code,
        reason: event.reason || undefined,
        cursor: cursor ?? null,
        refusals: nextRefusals,
      })
    }
    // `opts` goes back unchanged so the boot cursor survives a probe; the seq
    // is read at reconnect time, not here, so a resume uses everything seen.
    setTimeout(() => startJetstreamIndexer(opts, nextRefusals), RECONNECT_DELAY_MS)
  })

  return ws
}
