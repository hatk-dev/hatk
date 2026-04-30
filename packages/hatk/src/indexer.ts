import { cborDecode } from './cbor.ts'
import { parseCarFrame } from './car.ts'
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

/** A record pending insertion, buffered to enable batched writes. */
interface WriteBuffer {
  collection: string
  uri: string
  cid: string
  authorDid: string
  record: Record<string, any>
}

let buffer: WriteBuffer[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let lastSeq: number | null = null
const BATCH_SIZE = 100
const FLUSH_INTERVAL_MS = 500

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
 * Flush the write buffer — insert all buffered records, update the relay cursor,
 * run label rules on inserted records, and trigger FTS rebuilds when the write
 * threshold is reached. Emits a wide event with batch stats.
 */
async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return
  const elapsed = timer()
  const batch = buffer.splice(0)
  let insertedCount = 0
  const errors: string[] = []
  let cursorError: string | undefined

  const inserted: WriteBuffer[] = []
  for (const item of batch) {
    try {
      await insertRecord(item.collection, item.uri, item.cid, item.authorDid, item.record)
      insertedCount++
      inserted.push(item)
    } catch (err: any) {
      errors.push(err.message)
    }
  }
  if (lastSeq !== null) {
    try {
      await setCursor('relay', String(lastSeq))
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

  // Fire on-commit hooks for inserted records (async, non-blocking)
  fireOnCommitHooks(inserted.map((item) => ({
    action: 'create' as const,
    collection: item.collection,
    uri: item.uri,
    authorDid: item.authorDid,
    record: item.record,
  })))

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

/** Schedule a flush after FLUSH_INTERVAL_MS if one isn't already pending. */
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(async () => {
    flushTimer = null
    await flushBuffer()
  }, FLUSH_INTERVAL_MS)
}

/** Add a record to the write buffer. Flushes immediately if BATCH_SIZE is reached. */
function bufferWrite(item: WriteBuffer): void {
  buffer.push(item)
  if (buffer.length >= BATCH_SIZE) {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flushBuffer()
  } else {
    scheduleFlush()
  }
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
    const promise = new Promise<void>((r) => { resolveBackfill = r })
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
      await insertRecord(item.collection, item.uri, item.cid, item.authorDid, item.record)
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

/** Configuration for the firehose indexer. */
interface IndexerOpts {
  relayUrl: string
  plcUrl: string
  collections: Set<string>
  signalCollections?: Set<string>
  pinnedRepos?: Set<string>
  cursor?: string | null
  fetchTimeout: number
  maxRetries: number
  parallelism?: number
  ftsRebuildInterval?: number
}

/** Emit a memory diagnostics wide event every 30s for observability. */
function startMemoryDiagnostics(): void {
  setInterval(() => {
    const mem = process.memoryUsage()
    let pendingBufferItems = 0
    for (const [, items] of pendingBuffers) {
      pendingBufferItems += items.length
    }
    emit('diagnostics', 'memory', {
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      external_mb: Math.round(mem.external / 1024 / 1024),
      array_buffers_mb: Math.round(mem.arrayBuffers / 1024 / 1024),
      write_buffer_len: buffer.length,
      pending_buffer_dids: pendingBuffers.size,
      pending_buffer_items: pendingBufferItems,
      backfill_in_flight: backfillInFlight.size,
      repo_status_cache_size: repoStatusCache.size,
    })
  }, 30_000)
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
export async function startIndexer(opts: IndexerOpts): Promise<WebSocket> {
  const { relayUrl, collections, cursor, fetchTimeout } = opts
  if (opts.ftsRebuildInterval != null) ftsRebuildInterval = opts.ftsRebuildInterval
  indexerCollections = collections
  indexerSignalCollections = opts.signalCollections || collections
  indexerPinnedRepos = opts.pinnedRepos || null
  indexerFetchTimeout = fetchTimeout
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

  // startMemoryDiagnostics()

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
    setTimeout(() => startIndexer(opts), 3000)
  })

  return ws
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
async function handleIdentityEvent(did: string, payloadHandle: string | undefined): Promise<void> {
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
 * Process a single firehose message. Decodes the CBOR header/body, filters
 * for relevant collections, validates records against lexicons, and routes
 * writes to the buffer (or pending buffer if the DID is mid-backfill).
 */
function processMessage(bytes: Uint8Array, collections: Set<string>): void {
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
  if (body.value.seq) lastSeq = body.value.seq

  const did = body.value.repo
  if (!did) return

  // When repos are pinned, only process events from those DIDs
  if (indexerPinnedRepos && !indexerPinnedRepos.has(did)) return

  // Check if any ops in this commit are for collections we care about
  const relevantOps = body.value.ops.filter((op: any) => collections.has(op.path.split('/')[0]))
  if (relevantOps.length === 0) return

  // Copy blocks out of the original buffer before it can be GC'd
  const { blocks } = parseCarFrame(new Uint8Array(body.value.blocks))

  // Only auto-backfill when we see activity in a signal collection
  const hasSignalOp = relevantOps.some((op: any) => indexerSignalCollections.has(op.path.split('/')[0]))

  // Use in-memory cache only — never hit DB from the hot path.
  // Unknown DIDs stay unknown until backfill or auto-backfill discovers them.
  // The cache is populated by triggerAutoBackfill and setRepoStatus calls.
  const cachedStatus = repoStatusCache.get(did)
  const repoStatus = cachedStatus === undefined || cachedStatus === 'unknown' ? null : cachedStatus
  if (cachedStatus === undefined) {
    repoStatusCache.set(did, 'unknown')
  }

  if (hasSignalOp && (!indexerPinnedRepos || indexerPinnedRepos.has(did))) {
    if (repoStatus === null && backfillInFlight.size < maxConcurrentBackfills) {
      repoStatusCache.set(did, 'pending')
      triggerAutoBackfill(did)
    } else if (repoStatus === null) {
      repoStatusCache.set(did, 'pending')
      setRepoStatus(did, 'pending')
    }
  }

  // For non-signal ops (e.g. profile updates), only process if this DID is already tracked
  if (!hasSignalOp) {
    if (repoStatus === null) return
  }

  for (const op of relevantOps) {
    const collection = op.path.split('/')[0]
    const uri = `at://${did}/${op.path}`

    if (op.action === 'delete') {
      deleteRecord(collection, uri)
      fireOnCommitHooks([{
        action: 'delete',
        collection,
        uri,
        authorDid: did,
        record: null,
      }])
      continue
    }

    const opCid = typeof op.cid === 'string' ? op.cid : op.cid?.$link
    if (!opCid) continue
    const data = blocks.get(opCid)
    if (!data) continue

    try {
      const { value: record } = cborDecode(data)
      if (record?.$type === collection) {
        const validationError = validateRecord(getLexiconArray(), collection, record)
        if (validationError) {
          emit('indexer', 'validation_skip', {
            uri,
            collection,
            path: validationError.path,
            error: validationError.message,
          })
          continue
        }
        const item = { collection, uri, cid: opCid, authorDid: did, record }

        // If DID is mid-backfill, buffer instead of writing directly
        if (pendingBuffers.has(did)) {
          pendingBuffers.get(did)!.push(item)
        } else {
          bufferWrite(item)
        }
      }
    } catch {}
  }
}
