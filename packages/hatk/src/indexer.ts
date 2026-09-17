import { cborDecode } from './cbor.ts'
import { parseCarFrame } from './car.ts'
import { isPrivateCollection } from './private-collections.ts'
import {
  insertRecord,
  deleteRecord,
  setCursor,
  setRepoStatus,
  getRepoRetryInfo,
  listAllRepoStatuses,
  getDatabasePort,
  updateRepoHandle,
} from './database/db.ts'
import { backfillRepo } from './backfill.ts'
import { rebuildAllIndexes } from './database/fts.ts'
import { log, emit, timer } from './logger.ts'
import { runLabelRules } from './labels.ts'
import { fireOnCommitHooks } from './hooks.ts'
import { getLexiconArray } from './database/schema.ts'
import { validateRecord } from '@bigmoves/lexicon'

/**
 * One pending write, buffered to enable batched writes.
 *
 * Deletes ride the same buffer as puts rather than going straight to the
 * database, because the buffer *is* the indexer's ordering guarantee. A put is
 * deferred to the next flush; a delete applied outside the buffer would
 * therefore run before puts that arrived earlier (resurrecting the record when
 * the flush lands) and after puts that arrived later (erasing a newer record).
 * One queue, drained in arrival order, is what makes either sequence resolve
 * the way the firehose ordered it.
 */
type WriteBuffer =
  | {
      action: 'put'
      collection: string
      uri: string
      cid: string
      authorDid: string
      record: Record<string, any>
    }
  | { action: 'delete'; collection: string; uri: string; authorDid: string }

/** A single normalized repo operation, independent of the wire it arrived on. */
export interface CommitOp {
  action: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  /** Absent on deletes. */
  cid?: string
  /** Absent on deletes. */
  record?: Record<string, any>
}

let buffer: WriteBuffer[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let lastSeq: number | null = null
let lastPersistedSeq: number | null = null
let cursorCheckpointTimer: ReturnType<typeof setInterval> | null = null

/**
 * Which `_cursor` row this process persists its stream position to.
 *
 * The relay's `subscribeRepos` seq and Jetstream's seq are different
 * coordinate systems — resuming one from the other's value would either skip
 * a swathe of the stream or replay from a nonsense offset. Each source owns
 * its own key so switching between them (or back) is safe.
 */
let cursorKey: 'relay' | 'jetstream' = 'relay'
const BATCH_SIZE = 100
const FLUSH_INTERVAL_MS = 500
const CURSOR_CHECKPOINT_INTERVAL_MS = 5_000

let writesSinceRebuild = 0
let ftsRebuildInterval = 500

// Event buffer for DIDs mid-backfill
const pendingBuffers = new Map<string, WriteBuffer[]>()

// Track in-flight backfills to avoid duplicates
const backfillInFlight = new Set<string>()
const backfillPromises = new Map<string, { promise: Promise<void>; resolve: () => void }>()
const pendingReschedule = new Set<string>()

// In-memory cache of repo status to avoid flooding the DB read queue
const repoStatusCache = new Map<string, string>()

// Set by startIndexer
let indexerCollections: Set<string>
let indexerSignalCollections: Set<string>
let indexerPinnedRepos: Set<string> | null = null
let indexerFetchTimeout: number
let indexerMaxRetries: number
let indexerPlcUrl: string
let maxConcurrentBackfills = 3

/**
 * Flush the write buffer — apply all buffered puts and deletes in arrival
 * order, update the relay cursor, run label rules on inserted records, and
 * trigger FTS rebuilds when the write threshold is reached. Emits a wide event
 * with batch stats.
 */
async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return
  const elapsed = timer()
  const batch = buffer.splice(0)
  let insertedCount = 0
  let deletedCount = 0
  const errors: string[] = []
  let cursorError: string | undefined

  const inserted: Extract<WriteBuffer, { action: 'put' }>[] = []
  const applied: Parameters<typeof fireOnCommitHooks>[0] = []
  // Strictly sequential: two writes to the same URI in one batch must land in
  // the order they arrived, so nothing here may run concurrently.
  for (const item of batch) {
    try {
      if (item.action === 'delete') {
        await deleteRecord(item.collection, item.uri)
        deletedCount++
        applied.push({
          action: 'delete',
          collection: item.collection,
          uri: item.uri,
          authorDid: item.authorDid,
          record: null,
        })
      } else {
        await insertRecord(item.collection, item.uri, item.cid, item.authorDid, item.record)
        insertedCount++
        inserted.push(item)
        applied.push({
          action: 'create',
          collection: item.collection,
          uri: item.uri,
          authorDid: item.authorDid,
          record: item.record,
        })
      }
    } catch (err: any) {
      errors.push(err.message)
    }
  }
  if (lastSeq !== null) {
    const seq = lastSeq
    try {
      await setCursor(cursorKey, String(seq))
      lastPersistedSeq = seq
    } catch (err: any) {
      cursorError = err.message
    }
  }

  // Run label rules on successfully inserted records (async, non-blocking)
  for (const item of inserted) {
    runLabelRules({
      uri: item.uri,
      cid: item.cid,
      did: item.authorDid,
      collection: item.collection,
      value: item.record,
    }).catch(() => {})
  }

  // Fire on-commit hooks for everything the batch applied, in the order it was
  // applied (async, non-blocking)
  fireOnCommitHooks(applied)

  // Aggregate collection counts and unique DIDs for wide event
  const collections: Record<string, number> = {}
  const dids = new Set<string>()
  for (const item of batch) {
    collections[item.collection] = (collections[item.collection] || 0) + 1
    dids.add(item.authorDid)
  }

  emit('indexer', 'flush', {
    batch_size: batch.length,
    inserted_count: insertedCount,
    deleted_count: deletedCount,
    error_count: errors.length,
    cursor_seq: lastSeq,
    duration_ms: elapsed(),
    collections,
    unique_dids: dids.size,
    sample_dids: [...dids].slice(0, 5),
    cursor_error: cursorError,
    sample_errors: errors.length > 0 ? errors.slice(0, 3) : undefined,
  })

  writesSinceRebuild += batch.length
  if (writesSinceRebuild >= ftsRebuildInterval) {
    writesSinceRebuild = 0
    // Skip periodic full rebuild for SQLite — it uses incremental FTS updates
    const port = getDatabasePort()
    if (port.dialect !== 'sqlite') {
      rebuildAllIndexes([...indexerCollections]).catch(() => {})
    }
  }
}

/**
 * Run a flush once every flush already queued has finished.
 *
 * Nothing awaits the flush a full batch triggers, and the interval timer can
 * fire while that flush is still waiting on the database. Two flushes in flight
 * hold disjoint batches but interleave their awaits, so a write in the later
 * batch can reach the database before one in the earlier batch — which would
 * give back exactly the cross-batch reordering the single buffer removes.
 * Chaining them costs nothing on an idle indexer and keeps the queue global.
 */
let flushChain: Promise<void> = Promise.resolve()
function enqueueFlush(): Promise<void> {
  const next = flushChain.then(
    () => flushBuffer(),
    () => flushBuffer(),
  )
  flushChain = next
  return next
}

/** Schedule a flush after FLUSH_INTERVAL_MS if one isn't already pending. */
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void enqueueFlush().catch(() => {})
  }, FLUSH_INTERVAL_MS)
}

/** Add a write to the buffer. Flushes immediately if BATCH_SIZE is reached. */
function bufferWrite(item: WriteBuffer): void {
  buffer.push(item)
  if (buffer.length >= BATCH_SIZE) {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    void enqueueFlush().catch(() => {})
  } else {
    scheduleFlush()
  }
}

/** Record the latest firehose sequence seen. Source of truth for cursor persistence and reconnect resume. */
export function noteSeq(seq: number): void {
  lastSeq = seq
}

/** The highest seq this process has seen, or null before the first event. */
export function getLastSeq(): number | null {
  return lastSeq
}

/**
 * Persist the latest firehose sequence when it has advanced past the stored
 * cursor. Runs on a timer independent of the write path: an app whose
 * collections rarely appear on the firehose never flushes a batch, so the
 * flush-path cursor write alone leaves the stored cursor frozen — and a frozen
 * cursor makes the relay replay its whole retention window at line rate
 * (~135 GB/hour observed against bsky.network) on every boot and reconnect.
 */
export async function checkpointCursor(): Promise<void> {
  if (lastSeq === null || lastSeq === lastPersistedSeq) return
  const seq = lastSeq
  try {
    await setCursor(cursorKey, String(seq))
    lastPersistedSeq = seq
  } catch (err: any) {
    emit('indexer', 'cursor_checkpoint_error', { cursor_seq: seq, error: err.message })
  }
}

/** Point cursor persistence at a stream's own `_cursor` row. See {@link cursorKey}. */
export function setCursorKey(key: 'relay' | 'jetstream'): void {
  cursorKey = key
}

/**
 * The cursor a reconnect should resume from: the latest seq this process has
 * seen, falling back to the boot-time cursor before any message has arrived.
 * Reusing the boot-time cursor on every reconnect would replay everything
 * received since the process started.
 */
export function resumeCursor(liveSeq: number | null, bootCursor: string | null | undefined): string | null | undefined {
  return liveSeq !== null ? String(liveSeq) : bootCursor
}

/** Reset module cursor state between tests. */
export function _resetCursorStateForTests(): void {
  lastSeq = null
  lastPersistedSeq = null
  cursorKey = 'relay'
}

/**
 * Drain the write buffer instead of waiting out FLUSH_INTERVAL_MS. Lets
 * end-to-end tests assert on rows immediately after feeding a frame — deletes
 * included, since they are buffered alongside puts and so are covered by the
 * same await.
 */
export async function _flushForTests(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await enqueueFlush()
}

/**
 * Auto-backfill a DID's repo when first seen on the firehose.
 *
 * Fetches the full repo via CAR export, inserts all records, then replays any
 * firehose events that arrived during the backfill. Concurrency is capped at
 * `maxConcurrentBackfills`. Failed backfills retry with exponential delay up
 * to `maxRetries`.
 */
/** Wait for a DID's backfill to complete if one is in flight. */
export function awaitBackfill(did: string): Promise<void> {
  const entry = backfillPromises.get(did)
  return entry ? entry.promise : Promise.resolve()
}

/**
 * Track a repo no signal collection will ever point at.
 *
 * Backfill and the stream find repos by what they write into the signal
 * collections. A writer in a followed space is wanted for another reason:
 * their public profile is what puts a name and a face on everything they
 * wrote there, and an app that only indexes the community's own records
 * would render every member as a DID. So the space engine names them here,
 * and an unknown one is backfilled like a repo the stream just surfaced.
 * Idempotent and cheap: a repo already known is a map lookup.
 */
export function trackRepo(did: string): void {
  if (indexerPinnedRepos && !indexerPinnedRepos.has(did)) return
  const status = repoStatusCache.get(did)
  if (status && status !== 'unknown') return
  repoStatusCache.set(did, 'pending')
  void triggerAutoBackfill(did)
}

export async function triggerAutoBackfill(did: string, attempt = 0): Promise<void> {
  if (backfillInFlight.has(did)) return
  if (backfillInFlight.size >= maxConcurrentBackfills) {
    if (!pendingReschedule.has(did)) {
      pendingReschedule.add(did)
      setTimeout(() => {
        pendingReschedule.delete(did)
        triggerAutoBackfill(did, attempt)
      }, 10_000)
    }
    return
  }
  backfillInFlight.add(did)
  pendingBuffers.set(did, [])
  if (!backfillPromises.has(did)) {
    let resolveBackfill!: () => void
    const promise = new Promise<void>((r) => {
      resolveBackfill = r
    })
    backfillPromises.set(did, { promise, resolve: resolveBackfill })
  }
  if (attempt === 0) await setRepoStatus(did, 'pending')
  const elapsed = timer()

  let recordCount = 0
  let status = 'success'
  let error: string | undefined
  let replayErrors = 0

  try {
    recordCount = await backfillRepo(did, indexerCollections, indexerFetchTimeout)
  } catch (err: any) {
    status = 'error'
    error = err.message
  }

  // Replay buffered events
  const buffered = pendingBuffers.get(did) || []
  pendingBuffers.delete(did)
  backfillInFlight.delete(did)

  for (const item of buffered) {
    try {
      if (item.action === 'delete') {
        // A delete that arrived mid-backfill has to be replayed after the CAR
        // export lands, or the export's snapshot of the record outlives it.
        await deleteRecord(item.collection, item.uri)
      } else {
        await insertRecord(item.collection, item.uri, item.cid, item.authorDid, item.record)
      }
    } catch {
      replayErrors++
    }
  }

  // Schedule retry if failed and under maxRetries
  const retryInfo = status === 'error' ? await getRepoRetryInfo(did) : null
  const currentRetryCount = retryInfo?.retryCount ?? 0

  emit('indexer', 'auto_backfill', {
    did,
    record_count: recordCount,
    buffered_events: buffered.length,
    replay_errors: replayErrors,
    duration_ms: elapsed(),
    status,
    error,
    retry_count: currentRetryCount,
  })

  // Resolve awaiting callers (e.g. on-login hooks)
  const entry = backfillPromises.get(did)
  if (entry) {
    entry.resolve()
    backfillPromises.delete(did)
  }

  if (status === 'error' && currentRetryCount < indexerMaxRetries) {
    const delaySecs = Math.min(currentRetryCount * 60, 3600)
    const delayMs = Math.max(delaySecs, 60) * 1000
    setTimeout(() => {
      triggerAutoBackfill(did, currentRetryCount)
    }, delayMs)
  }
}

/**
 * Indexing behaviour shared by every stream source. Both the relay firehose
 * and the Jetstream live tail feed the same buffers, backfill signalling, and
 * cursor machinery — only the wire differs.
 */
export interface IndexerCoreOpts {
  plcUrl: string
  collections: Set<string>
  signalCollections?: Set<string>
  pinnedRepos?: Set<string>
  fetchTimeout: number
  maxRetries: number
  parallelism?: number
  ftsRebuildInterval?: number
}

/** Configuration for the relay firehose indexer. */
interface IndexerOpts extends IndexerCoreOpts {
  relayUrl: string
  cursor?: string | null
}

/**
 * Connect to the AT Protocol relay firehose and begin indexing.
 *
 * Opens a WebSocket to `subscribeRepos`, processes commit messages synchronously
 * on the event loop to minimize backpressure, and batches writes through
 * {@link flushBuffer}. New DIDs trigger auto-backfill via {@link triggerAutoBackfill}.
 * Reconnects automatically on disconnect after a 3s delay.
 *
 * @returns The WebSocket connection (for shutdown coordination)
 */
export async function configureIndexer(opts: IndexerCoreOpts): Promise<void> {
  if (opts.ftsRebuildInterval != null) ftsRebuildInterval = opts.ftsRebuildInterval
  indexerCollections = opts.collections
  indexerSignalCollections = opts.signalCollections || opts.collections
  indexerPinnedRepos = opts.pinnedRepos || null
  indexerFetchTimeout = opts.fetchTimeout
  indexerMaxRetries = opts.maxRetries
  indexerPlcUrl = opts.plcUrl
  maxConcurrentBackfills = opts.parallelism ?? 3

  // Pre-populate repo status cache from DB so non-signal updates
  // (e.g. profile changes) are processed for already-tracked DIDs
  if (repoStatusCache.size === 0) {
    const statuses = await listAllRepoStatuses()
    for (const { did, status } of statuses) {
      repoStatusCache.set(did, status)
    }
    log(`[indexer] Warmed repo status cache with ${statuses.length} entries`)
  }

  // Checkpoint the cursor on a timer regardless of write activity (see
  // checkpointCursor). Guarded so reconnects don't stack intervals; unref'd so
  // it never keeps the process alive.
  if (!cursorCheckpointTimer) {
    cursorCheckpointTimer = setInterval(() => void checkpointCursor(), CURSOR_CHECKPOINT_INTERVAL_MS)
    cursorCheckpointTimer.unref?.()
  }
}

export async function startIndexer(opts: IndexerOpts): Promise<WebSocket> {
  const { relayUrl, collections, cursor } = opts
  setCursorKey('relay')
  await configureIndexer(opts)

  let wsUrl = `${relayUrl}/xrpc/com.atproto.sync.subscribeRepos`
  if (cursor) {
    wsUrl += `?cursor=${cursor}`
    log(`[indexer] Resuming from cursor ${cursor}`)
  }
  log(`[indexer] Connecting to ${relayUrl}...`)

  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      // Process synchronously to drain the event queue as fast as possible.
      // Each pending event holds its ArrayBuffer; async handlers let them pile up.
      if (!(event.data instanceof ArrayBuffer)) return
      const bytes = new Uint8Array(event.data)
      processMessage(bytes, collections)
    } catch (err: unknown) {
      emit('indexer', 'decode_error', { error: err instanceof Error ? err.message : String(err) })
    }
  })

  ws.addEventListener('open', () => log('[indexer] Connected to relay'))
  ws.addEventListener('close', () => {
    log('[indexer] Disconnected, reconnecting in 3s...')
    setTimeout(() => startIndexer({ ...opts, cursor: resumeCursor(lastSeq, opts.cursor) }), 3000)
  })

  return ws
}

/** Configuration for an auxiliary firehose (see {@link startAuxIndexer}). */
export interface AuxIndexerOpts {
  relayUrl: string
  collections: Set<string>
  cursor?: string | null
}

/** The `_cursor` row an auxiliary firehose persists its position to. */
export function auxCursorKey(relayUrl: string): string {
  return `relay:${relayUrl}`
}

/**
 * Tail a second `subscribeRepos` alongside the primary stream.
 *
 * A relay is one coordinate system; a PDS tailed directly is another. Nothing
 * below the wire cares which socket a frame arrived on — `processMessage`
 * decodes it and `applyCommit` indexes it — so the only state an extra source
 * needs of its own is a seq and a cursor row. Both live in this closure,
 * keyed by URL, so an aux stream never advances (or resumes from) the primary
 * cursor. Use this when a repo's PDS is not behind the relay being tailed —
 * a self-hosted network, a dev stack with more than one PDS — rather than
 * standing up a relay just to merge two streams.
 *
 * Must be called after {@link configureIndexer} (or {@link startIndexer}),
 * which owns the shared indexer configuration.
 */
export function startAuxIndexer(opts: AuxIndexerOpts): WebSocket {
  const { relayUrl, collections } = opts
  const cursorKey = auxCursorKey(relayUrl)
  let seq: number | null = null
  let persistedSeq: number | null = null

  const checkpoint = async () => {
    if (seq === null || seq === persistedSeq) return
    const s = seq
    try {
      await setCursor(cursorKey, String(s))
      persistedSeq = s
    } catch (err: any) {
      emit('indexer', 'cursor_checkpoint_error', { source: relayUrl, cursor_seq: s, error: err.message })
    }
  }
  const timer = setInterval(() => void checkpoint(), CURSOR_CHECKPOINT_INTERVAL_MS)
  timer.unref?.()

  const connect = (cursor: string | null | undefined): WebSocket => {
    let wsUrl = `${relayUrl}/xrpc/com.atproto.sync.subscribeRepos`
    if (cursor) {
      wsUrl += `?cursor=${cursor}`
      log(`[indexer:aux] Resuming ${relayUrl} from cursor ${cursor}`)
    }
    log(`[indexer:aux] Connecting to ${relayUrl}...`)

    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        if (!(event.data instanceof ArrayBuffer)) return
        processMessage(new Uint8Array(event.data), collections, (s) => {
          seq = s
        })
      } catch (err: unknown) {
        emit('indexer', 'decode_error', { source: relayUrl, error: err instanceof Error ? err.message : String(err) })
      }
    })
    ws.addEventListener('open', () => log(`[indexer:aux] Connected to ${relayUrl}`))
    ws.addEventListener('close', () => {
      log(`[indexer:aux] Disconnected from ${relayUrl}, reconnecting in 3s...`)
      setTimeout(() => connect(resumeCursor(seq, opts.cursor)), 3000)
    })
    return ws
  }

  return connect(opts.cursor)
}

/**
 * Handle a `#identity` firehose event for a DID. The `handle` field on the
 * event is optional per the lexicon, and some emitters omit it (signalling
 * "re-resolve"). When absent, we re-resolve from the PLC directory so handle
 * renames propagate even when the relay payload is sparse.
 *
 * Only updates DIDs we already track (present in repoStatusCache) to avoid
 * writing rows for the entire network.
 */
export async function handleIdentityEvent(did: string, payloadHandle: string | undefined): Promise<void> {
  if (!repoStatusCache.has(did)) return

  let handle = payloadHandle
  const payloadHadHandle = handle !== undefined

  if (!handle) {
    try {
      // Bound the PLC fetch so a slow plc.directory can't pile up unbounded
      // promises during an identity-event burst (fire-and-forget caller).
      const res = await fetch(`${indexerPlcUrl}/${did}`, {
        signal: AbortSignal.timeout(indexerFetchTimeout * 1000),
      })
      if (res.ok) {
        const doc = (await res.json()) as { alsoKnownAs?: string[] }
        // First at:// entry is the canonical handle (per @atproto/identity convention)
        const aka = doc.alsoKnownAs?.find((u) => u.startsWith('at://'))
        handle = aka ? aka.slice('at://'.length) : undefined
      } else {
        emit('indexer', 'identity_resolve_error', { did, status: res.status })
      }
    } catch (err: unknown) {
      emit('indexer', 'identity_resolve_error', {
        did,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!handle) {
    emit('indexer', 'identity_no_handle', { did, payload_had_handle: payloadHadHandle })
    return
  }

  try {
    await updateRepoHandle(did, handle)
    emit('indexer', 'identity_handle_update', { did, handle, payload_had_handle: payloadHadHandle })
  } catch (err: unknown) {
    emit('indexer', 'identity_update_error', {
      did,
      handle,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Whether a collection's records may be written from network data.
 *
 * Private collections are AppView-authoritative: nothing on the network may
 * write or delete their rows, so stream ops naming them are spoofed by
 * definition and must be dropped regardless of which source delivered them.
 */
export function isIndexableCollection(collection: string, collections: Set<string>): boolean {
  return collections.has(collection) && !isPrivateCollection(collection)
}

/**
 * Apply a repo's commit ops to the index.
 *
 * Wire-agnostic: the relay path reaches here after CBOR/CAR decoding, the
 * Jetstream path after parsing JSON. Callers must have already filtered `ops`
 * through {@link isIndexableCollection}.
 *
 * Handles auto-backfill signalling, buffering for DIDs mid-backfill, lexicon
 * validation, and delete/put routing.
 */
export function applyCommit(did: string, ops: CommitOp[]): void {
  if (ops.length === 0) return

  // When repos are pinned, only process events from those DIDs
  if (indexerPinnedRepos && !indexerPinnedRepos.has(did)) return

  // Only auto-backfill when we see activity in a signal collection
  const hasSignalOp = ops.some((op) => indexerSignalCollections.has(op.collection))

  // Use in-memory cache only — never hit DB from the hot path.
  // Unknown DIDs stay unknown until backfill or auto-backfill discovers them.
  // The cache is populated by triggerAutoBackfill and setRepoStatus calls.
  const cachedStatus = repoStatusCache.get(did)
  const repoStatus = cachedStatus === undefined || cachedStatus === 'unknown' ? null : cachedStatus
  if (cachedStatus === undefined) {
    repoStatusCache.set(did, 'unknown')
  }

  if (hasSignalOp) {
    if (repoStatus === null && backfillInFlight.size < maxConcurrentBackfills) {
      repoStatusCache.set(did, 'pending')
      triggerAutoBackfill(did)
    } else if (repoStatus === null) {
      repoStatusCache.set(did, 'pending')
      setRepoStatus(did, 'pending')
    }
  }

  // For non-signal ops (e.g. profile updates), only process if this DID is already tracked
  if (!hasSignalOp && repoStatus === null) return

  /** Queue a write behind anything already queued for this DID. */
  const enqueue = (item: WriteBuffer) => {
    // If DID is mid-backfill, buffer instead of writing directly
    if (pendingBuffers.has(did)) pendingBuffers.get(did)!.push(item)
    else bufferWrite(item)
  }

  for (const op of ops) {
    const uri = `at://${did}/${op.collection}/${op.rkey}`

    if (op.action === 'delete') {
      // Buffered, not applied here: see {@link WriteBuffer}. The on-commit hook
      // fires from the flush too, so a handler never sees a delete announced
      // before the row is actually gone.
      enqueue({ action: 'delete', collection: op.collection, uri, authorDid: did })
      continue
    }

    const record = op.record
    if (!op.cid || !record) continue
    if (record.$type !== op.collection) continue

    const validationError = validateRecord(getLexiconArray(), op.collection, record)
    if (validationError) {
      emit('indexer', 'validation_skip', {
        uri,
        collection: op.collection,
        path: validationError.path,
        error: validationError.message,
      })
      continue
    }

    enqueue({ action: 'put', collection: op.collection, uri, cid: op.cid, authorDid: did, record })
  }
}

/**
 * Process a single firehose message. Decodes the CBOR header/body, filters
 * for relevant collections, validates records against lexicons, and routes
 * writes to the buffer (or pending buffer if the DID is mid-backfill).
 */
export function processMessage(
  bytes: Uint8Array,
  collections: Set<string>,
  onSeq: (seq: number) => void = noteSeq,
): void {
  const header = cborDecode(bytes, 0)
  const body = cborDecode(bytes, header.offset)

  // Handle identity events (handle changes). Fire-and-forget — keeps
  // processMessage synchronous so the WS event loop drains without backpressure.
  if (header.value.t === '#identity') {
    const did = typeof body.value.did === 'string' ? body.value.did : undefined
    const handle = typeof body.value.handle === 'string' ? body.value.handle : undefined
    if (did) handleIdentityEvent(did, handle)
    return
  }

  if (header.value.op !== 1 || header.value.t !== '#commit') return
  if (!body.value.blocks || !body.value.ops) return

  // Track sequence number for cursor
  if (body.value.seq) onSeq(body.value.seq)

  const did = body.value.repo
  if (!did) return

  // Check if any ops in this commit are for collections we care about, before
  // paying for the CAR parse below.
  const relevantOps = body.value.ops.filter((op: any) => isIndexableCollection(op.path.split('/')[0], collections))
  if (relevantOps.length === 0) return

  // Copy blocks out of the original buffer before it can be GC'd
  const { blocks } = parseCarFrame(new Uint8Array(body.value.blocks))

  const ops: CommitOp[] = []
  for (const op of relevantOps) {
    const collection = op.path.split('/')[0]
    const rkey = op.path.split('/').slice(1).join('/')

    if (op.action === 'delete') {
      ops.push({ action: 'delete', collection, rkey })
      continue
    }

    const opCid = typeof op.cid === 'string' ? op.cid : op.cid?.$link
    if (!opCid) continue
    const data = blocks.get(opCid)
    if (!data) continue

    try {
      const { value: record } = cborDecode(data)
      ops.push({ action: op.action === 'update' ? 'update' : 'create', collection, rkey, cid: opCid, record })
    } catch {}
  }

  applyCommit(did, ops)
}
