import { parseCarStream } from './car.ts'
import { cborDecode } from './cbor.ts'
import { walkMst } from './mst.ts'
import {
  setRepoStatus,
  getRepoStatus,
  getRepoRev,
  getRepoRetryInfo,
  listRetryEligibleRepos,
  listPendingRepos,
  querySQL,
  runSQL,
  getSchema,
  bulkInsertRecords,
} from './database/db.ts'
import type { BulkRecord } from './database/db.ts'
import { emit, timer } from './logger.ts'
import type { BackfillConfig } from './config.ts'
import { validateRecord } from '@bigmoves/lexicon'
import { getLexiconArray } from './database/schema.ts'

/** Options passed to {@link runBackfill}. */
interface BackfillOpts {
  /** Base URL of the relay or PDS to enumerate repos from (e.g. `wss://bsky.network`). */
  pdsUrl: string
  /** PLC directory URL used to resolve `did:plc` identifiers (e.g. `https://plc.directory`). */
  plcUrl: string
  /** AT Protocol collection NSIDs to index (e.g. `app.bsky.feed.post`). */
  collections: Set<string>
  /** Backfill behavior settings from `hatk.config.ts`. */
  config: BackfillConfig
}

interface PdsResolution {
  /** The PDS service endpoint URL from the DID document. */
  pds: string
  /** The user's handle extracted from `alsoKnownAs`, or `null` if not present. */
  handle: string | null
}

/** In-memory cache of DID → PDS resolution results to avoid redundant lookups. */
const pdsCache = new Map<string, PdsResolution>()
let plcUrl: string

/**
 * Resolves a DID to its PDS endpoint and handle by fetching the DID document.
 *
 * Supports both `did:web` (fetches `/.well-known/did.json`) and `did:plc`
 * (fetches from the PLC directory). Results are cached for the lifetime of the process.
 *
 * @example
 * ```ts
 * const { pds, handle } = await resolvePds('did:plc:abc123')
 * // pds = "https://puffball.us-east.host.bsky.network"
 * // handle = "alice.bsky.social"
 * ```
 */
async function resolvePds(did: string): Promise<PdsResolution> {
  const cached = pdsCache.get(did)
  if (cached) return cached

  let didDoc: any
  if (did.startsWith('did:web:')) {
    const domain = did.slice('did:web:'.length)
    const res = await fetch(`https://${domain}/.well-known/did.json`)
    if (!res.ok) throw new Error(`did:web resolution failed for ${did}: ${res.status}`)
    didDoc = await res.json()
  } else {
    const res = await fetch(`${plcUrl}/${did}`)
    if (!res.ok) throw new Error(`PLC resolution failed for ${did}: ${res.status}`)
    didDoc = await res.json()
  }

  const pds = didDoc.service?.find((s: any) => s.id === '#atproto_pds')?.serviceEndpoint
  if (!pds) throw new Error(`No PDS endpoint in DID document for ${did}`)

  // Extract handle from alsoKnownAs (format: "at://handle")
  const aka = didDoc.alsoKnownAs?.find((u: string) => u.startsWith('at://'))
  const handle = aka ? aka.slice('at://'.length) : null

  const result = { pds, handle }
  pdsCache.set(did, result)
  return result
}

/**
 * Paginates through all active repos on a relay/PDS using `com.atproto.sync.listRepos`.
 * Yields `{ did, rev }` for each active repo. Skips deactivated repos.
 */
async function* listRepos(pdsUrl: string): AsyncGenerator<{ did: string; rev: string }> {
  let cursor: string | undefined
  while (true) {
    const params = new URLSearchParams({ limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.sync.listRepos?${params}`)
    if (!res.ok) throw new Error(`listRepos failed: ${res.status}`)
    const data = await res.json()
    for (const repo of data.repos || []) {
      if (repo.active !== false) yield { did: repo.did, rev: repo.rev }
    }
    if (!data.cursor || (data.repos || []).length === 0) break
    cursor = data.cursor
  }
}

/**
 * Paginates through repos that contain records in a specific collection using
 * `com.atproto.sync.listReposByCollection`. More efficient than {@link listRepos}
 * when only a few collections are needed, since the relay can filter server-side.
 *
 * Not all relays support this endpoint — callers should fall back to {@link listRepos}.
 */
async function* listReposByCollection(
  pdsUrl: string,
  collection: string,
): AsyncGenerator<{ did: string; rev: string }> {
  let cursor: string | undefined
  while (true) {
    const params = new URLSearchParams({ collection, limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.sync.listReposByCollection?${params}`)
    if (!res.ok) throw new Error(`listReposByCollection failed: ${res.status}`)
    const data = await res.json()
    for (const repo of data.repos || []) {
      yield { did: repo.did, rev: repo.rev || '' }
    }
    if (!data.cursor || (data.repos || []).length === 0) break
    cursor = data.cursor
  }
}

/**
 * Downloads and indexes a single user's repo via `com.atproto.sync.getRepo`.
 *
 * The full flow:
 * 1. Resolve the DID to find the user's PDS endpoint
 * 2. Fetch the repo as a CAR file from the PDS
 * 3. Parse the CAR, decode the commit, and walk the MST (Merkle Search Tree)
 * 4. Delete any existing records for this DID (so deletions are reflected)
 * 5. Bulk-insert all records matching the target collections
 *
 * On failure, applies exponential backoff retry logic. HTTP 4xx errors are
 * treated as permanent failures (repo doesn't exist or is deactivated) and
 * are not retried.
 *
 * @param did - The DID of the repo to backfill (e.g. `did:plc:abc123`)
 * @param collections - Collection NSIDs to index; records in other collections are skipped
 * @param fetchTimeout - Maximum seconds to wait for the CAR download before aborting
 * @returns The number of records successfully indexed
 *
 * @example
 * ```ts
 * const count = await backfillRepo('did:plc:abc123', new Set(['app.bsky.feed.post']), 30)
 * console.log(`Indexed ${count} records`)
 * ```
 */
export async function backfillRepo(did: string, collections: Set<string>, fetchTimeout: number): Promise<number> {
  const elapsed = timer()
  let count = 0
  let carSizeBytes: number | undefined
  let status = 'success'
  let error: string | undefined
  let resolvedPds: string | undefined
  let resolvedHandle: string | null = null
  let resolvedSince: string | null = null
  let retryCount: number | undefined
  let retryAfter: number | undefined

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const { pds: pdsUrl, handle } = await resolvePds(did)
    resolvedPds = pdsUrl
    resolvedHandle = handle
    timeout = setTimeout(() => controller.abort(), fetchTimeout * 1000)
    let lastRev = await getRepoRev(did)
    const baseUrl = `${resolvedPds}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`
    let repoUrl = lastRev ? `${baseUrl}&since=${encodeURIComponent(lastRev)}` : baseUrl
    let res = await fetch(repoUrl, { signal: controller.signal })

    // If the PDS rejected our `since` rev (compacted history), fall back to full import
    if (res.status === 400 && lastRev) {
      lastRev = null
      res = await fetch(baseUrl, { signal: controller.signal })
    }

    if (!res.ok) {
      const httpErr = new Error(`getRepo failed for ${did}: ${res.status}`) as Error & { httpStatus: number }
      httpErr.httpStatus = res.status
      throw httpErr
    }

    resolvedSince = lastRev
    let { roots, blocks, byteLength } = await parseCarStream(res.body!)
    carSizeBytes = byteLength

    // Decode commit to get MST root — if the diff CAR is missing the root block,
    // fall back to a full import (the PDS compacted past our `since` rev)
    let rootData = blocks.get(roots[0])
    if (!rootData && lastRev) {
      lastRev = null
      resolvedSince = null
      res = await fetch(baseUrl, { signal: controller.signal })
      if (!res.ok) {
        const httpErr = new Error(`getRepo failed for ${did}: ${res.status}`) as Error & { httpStatus: number }
        httpErr.httpStatus = res.status
        throw httpErr
      }
      ;({ roots, blocks, byteLength } = await parseCarStream(res.body!))
      carSizeBytes = byteLength
      rootData = blocks.get(roots[0])
    }
    if (!rootData) throw new Error(`No root block for ${did}`)
    const { value: commit } = cborDecode(rootData)

    // Walk MST to find all record paths
    const entries = walkMst(blocks, commit.data.$link)

    // Delete existing records for this DID before re-importing so deletions are reflected
    // Only on full imports (no since) — diff CARs only contain changes
    if (!lastRev) {
      for (const col of collections) {
        const schema = getSchema(col)
        if (!schema) continue
        await runSQL(`DELETE FROM ${schema.tableName} WHERE did = $1`, [did])
        for (const child of schema.children) {
          await runSQL(`DELETE FROM ${child.tableName} WHERE parent_did = $1`, [did])
        }
        for (const union of schema.unions) {
          for (const branch of union.branches) {
            await runSQL(`DELETE FROM ${branch.tableName} WHERE parent_did = $1`, [did])
          }
        }
      }
    }

    // Insert records in chunks to limit memory usage
    const CHUNK_SIZE = 1000
    let chunk: BulkRecord[] = []
    const validationSkips: Record<string, number> = {}
    for (const entry of entries) {
      const collection = entry.path.split('/')[0]
      if (!collections.has(collection)) continue

      const blockData = blocks.get(entry.cid)
      if (!blockData) continue
      blocks.delete(entry.cid) // free block data as we go

      try {
        const { value: record } = cborDecode(blockData)
        if (!record?.$type) continue

        const rkey = entry.path.split('/').slice(1).join('/')
        const uri = `at://${did}/${collection}/${rkey}`

        const validationError = validateRecord(getLexiconArray(), collection, record)
        if (validationError) {
          validationSkips[collection] = (validationSkips[collection] || 0) + 1
          continue
        }

        chunk.push({ collection, uri, cid: entry.cid, did, record })

        if (chunk.length >= CHUNK_SIZE) {
          count += await bulkInsertRecords(chunk)
          chunk = []
        }
      } catch (recordErr: any) {
        emit('backfill', 'record_error', {
          did,
          uri: `at://${did}/${entry.path}`,
          collection,
          error: recordErr.message,
        })
      }
    }
    if (chunk.length > 0) {
      count += await bulkInsertRecords(chunk)
    }
    const totalSkips = Object.values(validationSkips).reduce((a, b) => a + b, 0)
    if (totalSkips > 0) {
      emit('backfill', 'validation_skips', { did, total: totalSkips, by_collection: validationSkips })
    }
    await setRepoStatus(did, 'active', commit.rev, { handle })
    return count
  } catch (err: any) {
    status = 'error'
    error = err.message
    // Don't retry permanent failures (4xx = client error, repo doesn't exist / is deactivated)
    const isPermanent = err.httpStatus && err.httpStatus >= 400 && err.httpStatus < 500
    if (isPermanent) {
      retryCount = 999
      await setRepoStatus(did, 'failed', undefined, { retryCount: 999, retryAfter: 0, handle: resolvedHandle })
    } else {
      const info = await getRepoRetryInfo(did)
      retryCount = (info?.retryCount ?? 0) + 1
      const backoffSecs = Math.min(retryCount * 60, 3600)
      retryAfter = Math.floor(Date.now() / 1000) + backoffSecs
      await setRepoStatus(did, 'failed', undefined, { retryCount, retryAfter, handle: resolvedHandle })
    }
    throw err
  } finally {
    clearTimeout(timeout)
    emit('backfill', 'repo', {
      did,
      record_count: count,
      duration_ms: elapsed(),
      status,
      error,
      pds_url: resolvedPds,
      car_size_bytes: carSizeBytes,
      import_mode: carSizeBytes !== undefined ? (resolvedSince ? 'diff' : 'full') : undefined,
      since_rev: resolvedSince,
      retry_count: retryCount,
      retry_after: retryAfter,
      permanent_failure: retryCount === 999 ? true : undefined,
    })
  }
}

/**
 * Processes items concurrently with a fixed number of workers.
 * Workers pull from a shared index so the pool stays saturated even when
 * individual items complete at different speeds. Errors from `fn` are
 * swallowed (they're expected to be captured via structured logging).
 *
 * @param items - The work items to process
 * @param parallelism - Maximum number of concurrent workers
 * @param fn - Async function to run for each item
 */
async function runWorkerPool<T>(items: T[], parallelism: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0

  async function worker() {
    while (index < items.length) {
      const item = items[index++]
      try {
        await fn(item)
      } catch {
        // Errors captured by backfill.repo event
      }
    }
  }

  const workers = Array.from({ length: Math.min(parallelism, items.length) }, () => worker())
  await Promise.all(workers)
}

/**
 * Orchestrates a full backfill run: enumerate repos, filter to pending, download, and index.
 *
 * Operates in one of three modes based on config:
 * - **Pinned repos** — backfill only the DIDs listed in `config.repos`
 * - **Full network** — enumerate every active repo on the relay via `listRepos`
 * - **Collection signal** (default) — use `listReposByCollection` to discover repos that
 *   contain records in the configured signal collections, falling back to `listRepos`
 *   if the relay doesn't support collection-scoped enumeration
 *
 * After the initial pass, failed repos are retried with exponential backoff
 * (up to `config.maxRetries` attempts). The run emits structured log events for
 * monitoring via the `backfill.run` and `backfill.retry_round` event types.
 *
 * @example
 * ```ts
 * await runBackfill({
 *   pdsUrl: 'wss://bsky.network',
 *   plcUrl: 'https://plc.directory',
 *   collections: new Set(['xyz.statusphere.status']),
 *   config: {
 *     fullNetwork: false,
 *     parallelism: 10,
 *     fetchTimeout: 30,
 *     maxRetries: 5,
 *   },
 * })
 * ```
 */
export async function runBackfill(opts: BackfillOpts): Promise<number> {
  const { pdsUrl, collections, config } = opts
  plcUrl = opts.plcUrl
  const signalCollections = config.signalCollections || [...collections]
  const elapsed = timer()

  const mode = config.repos?.length ? 'pinned repos' : config.fullNetwork ? 'full network' : 'collection signal'

  // 1. Enumerate repos
  const dids = new Set<string>()

  if (config.repos?.length) {
    for (const did of config.repos) {
      dids.add(did)
    }
  } else if (config.fullNetwork) {
    for await (const repo of listRepos(pdsUrl)) {
      dids.add(repo.did)
    }
  } else {
    for (const col of signalCollections) {
      try {
        for await (const repo of listReposByCollection(pdsUrl, col)) {
          dids.add(repo.did)
        }
      } catch (err: any) {
        // Fall back to listRepos if listReposByCollection not supported
        if (err.message.includes('400') || err.message.includes('401') || err.message.includes('501')) {
          for await (const repo of listRepos(pdsUrl)) {
            dids.add(repo.did)
          }
          break
        }
        throw err
      }
    }
  }

  // 2. Filter to repos that haven't been backfilled + pick up existing pending repos
  const pending: string[] = []
  for (const did of dids) {
    const status = await getRepoStatus(did)
    if (status !== 'active') {
      if (!status) await setRepoStatus(did, 'pending')
      pending.push(did)
    }
  }
  // Also re-queue any repos left pending from previous runs
  const existingPending = await listPendingRepos()
  for (const did of existingPending) {
    if (!pending.includes(did)) pending.push(did)
  }

  if (pending.length === 0) {
    emit('backfill', 'run', {
      mode,
      total_repos: dids.size,
      pending_repos: 0,
      total_records: 0,
      failed_count: 0,
      duration_ms: elapsed(),
      parallelism: config.parallelism,
      status: 'success',
    })
    return 0
  }

  // 3. Backfill with worker pool
  let totalRecords = 0
  let failedCount = 0

  await runWorkerPool(pending, config.parallelism, async (did) => {
    try {
      const count = await backfillRepo(did, collections, config.fetchTimeout)
      totalRecords += count
    } catch {
      failedCount++
    }
  })

  // 4. Retry failed repos with exponential backoff
  const maxRetries = config.maxRetries
  let retryRound = 0
  while (true) {
    const eligible = await listRetryEligibleRepos(maxRetries)
    if (eligible.length === 0) break
    retryRound++

    // Wait until the earliest retry_after has passed
    const now = Math.floor(Date.now() / 1000)
    const rows = (await querySQL(
      `SELECT MIN(retry_after) as earliest FROM _repos WHERE status = 'failed' AND retry_after > $1 AND retry_count < $2`,
      [now, maxRetries],
    )) as { earliest: number | null }[]
    const earliest = rows[0]?.earliest ? Number(rows[0].earliest) : 0
    if (earliest > now) {
      await new Promise((resolve) => setTimeout(resolve, (earliest - now) * 1000))
    }

    const retryEligible = await listRetryEligibleRepos(maxRetries)
    if (retryEligible.length === 0) break

    emit('backfill', 'retry_round', {
      round: retryRound,
      eligible_repos: retryEligible.length,
    })

    await runWorkerPool(retryEligible, config.parallelism, async (did) => {
      try {
        const count = await backfillRepo(did, collections, config.fetchTimeout)
        totalRecords += count
        failedCount--
      } catch {
        // retry info already updated in backfillRepo
      }
    })
  }

  emit('backfill', 'run', {
    mode,
    total_repos: dids.size,
    pending_repos: pending.length,
    total_records: totalRecords,
    failed_count: failedCount,
    duration_ms: elapsed(),
    parallelism: config.parallelism,
    retry_rounds: retryRound,
    status: failedCount > 0 ? 'partial' : 'success',
  })
  return totalRecords
}
