/**
 * Keeping the index level with a permissioned space.
 *
 * A space never reaches a firehose. There is no stream to tail and no relay
 * that has seen it, so the only way to know a space has moved is to ask the
 * authority who has written into it and then ask each of those writers' hosts
 * what changed. Two loops do that:
 *
 *   reconcile   the authority's `listRepos` gives the writer set with each
 *               writer's current rev. Anything whose rev has moved is synced;
 *               anything the authority no longer names is dropped.
 *   sync        one writer's repo, forward from the rev we last read, through
 *               `listRepoOps` — or wholesale through `getRepo` when there is
 *               no position to start from, or when the op log has been
 *               compacted past it.
 *
 * Write notices exist too and are far cheaper, but they are best-effort by
 * design: a notice that never arrives is recovered only by the next sweep. So
 * reconcile is the thing that makes sync correct, and a notice only makes it
 * prompt.
 *
 * Everything read is verified before it is indexed. A commit carries no
 * signature; the writer's host vouches for it with a MAC keyed to this one
 * request (see mac.ts), and the commit's `data` is the hash of the repo's
 * whole record set. A full read checks the archive against it. A forward read
 * folds each op into the set hash held from the last read and checks the
 * result against the head commit, so ops that do not add up to the repo the
 * host vouched for are never applied — the writer is read whole instead.
 */

import type { OAuthConfig } from '../config.ts'
import { getLexicon, getLexiconArray } from '../database/schema.ts'
import { bulkInsertRecords, deleteRecord, insertRecord, purgeSpaceRecords } from '../database/db.ts'
import { validateRecord } from '@bigmoves/lexicon'
import { encode } from '@atproto/lex-cbor'
import { cidForCbor, parseCid, type LexMap } from '@atproto/lex-data'
import { jsonToLex, lexToJson, type JsonValue } from '@atproto/lex-json'
import {
  type Commit,
  RepoCommit,
  RepoVerificationError,
  verifyCommit,
  verifyRecord,
  verifyRepoStarFull,
} from '@atproto/space'
import { noteReferencedRepos, trackRepo } from '../indexer.ts'
import { emit, timer } from '../logger.ts'
import { isPrivateCollection } from '../private-collections.ts'
import { listSessionDids } from '../oauth/db.ts'
import { forgetSpaceCredential, getSpaceCredential, isSpaceGone, type SpaceCredential } from './credential.ts'
import { repoEndpoint, spaceHostEndpoint } from './identity.ts'
import { COMMIT_MAC_TYPE, RECORD_MAC_TYPE, requestMac, responseMac } from './mac.ts'
import {
  deleteSpaceRepo,
  deleteSpaceWatch,
  getSpaceRepo,
  getSpaceWatch,
  listSpaceRepos,
  listSpaceWatches,
  putSpaceRepo,
  putSpaceWatch,
  updateSpaceWatch,
  type SpaceWatch,
} from './store.ts'
import { parseSpaceRef, spaceRecordUri } from './uri.ts'

const OPS_PAGE = 1000

export interface SpaceEngineOptions {
  oauth: OAuthConfig
  /** Space type NSIDs this instance will follow. Anything else is refused. */
  types: Set<string>
  /** Collections hatk indexes at all; a space collection outside this is skipped. */
  collections: Set<string>
  /**
   * This instance's service identifier — `did:web:...#atproto_space_syncer`.
   * Absent when the instance receives no notices, in which case the sweep is
   * the only thing that notices a write.
   */
  serviceId?: string
}

/**
 * Re-register this long before a registration lapses.
 *
 * The reference host holds one for a day, and a lapsed registration stops
 * notices silently — the sweep would carry on working and nobody would notice
 * the latency had gone back up.
 */
const REGISTRATION_RENEW_LEAD_MS = 60 * 60 * 1000

let options: SpaceEngineOptions | null = null

export function configureSpaceEngine(opts: SpaceEngineOptions): void {
  options = opts
}

function requireOptions(): SpaceEngineOptions {
  if (!options) throw new Error('Space engine is not configured')
  return options
}

/**
 * The collections a space of this type holds, narrowed to the ones hatk has a
 * table for.
 *
 * A space type's lexicon declares its collections, which is what makes a space
 * readable without the app being told what is in it — but a space may name
 * collections this instance does not index, and those are simply not its
 * business.
 */
export function collectionsForSpaceType(spaceType: string): string[] {
  const { collections } = requireOptions()
  const lexicon = getLexicon(spaceType)
  const declared = lexicon?.defs?.main?.collections
  if (!Array.isArray(declared)) return []
  return declared
    .filter((c: unknown): c is string => typeof c === 'string')
    .filter((c) => collections.has(c) && !isPrivateCollection(c))
}

// --- Credentials ---

/**
 * Sessions worth trying for this space, best first.
 *
 * The reader that worked last time leads: a member who could read the space an
 * hour ago is overwhelmingly likely to still be one, and putting them first
 * means the common case costs one delegation rather than a walk through
 * everybody signed in.
 */
async function readerCandidates(watch: SpaceWatch): Promise<string[]> {
  const dids = await listSessionDids()
  if (!watch.readerDid) return dids
  return [watch.readerDid, ...dids.filter((did) => did !== watch.readerDid)]
}

async function credentialFor(watch: SpaceWatch, refresh = false): Promise<SpaceCredential> {
  const { oauth } = requireOptions()
  const candidates = await readerCandidates(watch)
  const credential = await getSpaceCredential(oauth, watch.space, candidates, { refresh })
  if (credential.readerDid !== watch.readerDid) {
    await updateSpaceWatch(watch.space, { readerDid: credential.readerDid })
    watch.readerDid = credential.readerDid
  }
  return credential
}

// --- Transport ---

interface SpaceOp {
  rev: string
  collection: string
  rkey: string
  cid: string | null
  prev: string | null
  value?: Record<string, unknown>
}

/** A repo's position: the rev it was read to, and its set hash there. */
interface RepoPosition {
  rev: string
  setHash: Uint8Array
}

async function credentialedFetch(
  credential: SpaceCredential,
  endpoint: string,
  nsid: string,
  params: Record<string, string | number | undefined>,
  headers?: Record<string, string>,
): Promise<Response> {
  const url = new URL(`${endpoint}/xrpc/${nsid}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const res = await credential.fetch(url, headers ? { headers } : undefined)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
    const err = new Error(body.message ?? `${nsid} failed (${res.status})`) as Error & {
      status: number
      code?: string
    }
    err.status = res.status
    err.code = body.error
    throw err
  }
  return res
}

async function credentialedGet(
  credential: SpaceCredential,
  endpoint: string,
  nsid: string,
  params: Record<string, string | number | undefined>,
): Promise<Record<string, any>> {
  return (await (await credentialedFetch(credential, endpoint, nsid, params)).json()) as Record<string, any>
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status
  return typeof status === 'number' ? status : undefined
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Run a credentialed read, re-minting once on a 401.
 *
 * A credential lives ten minutes and a sweep can outlive one; an authority can
 * also revoke one early. Re-minting costs a round trip; treating the refusal as
 * a failure costs the whole sync and leaves the space looking unreadable when
 * nothing about the membership changed.
 */
async function withCredential<T>(
  watch: SpaceWatch,
  operation: (credential: SpaceCredential) => Promise<T>,
): Promise<T> {
  let credential = await credentialFor(watch)
  try {
    return await operation(credential)
  } catch (err) {
    if (statusOf(err) !== 401) throw err
    forgetSpaceCredential(watch.space)
    credential = await credentialFor(watch, true)
    return operation(credential)
  }
}

// --- Record application ---

/**
 * Skip a record the lexicon refuses, the way the firehose path does — and say
 * why, the way the firehose path does. A record silently skipped is a record
 * that never appears with no trace of the reason, which is the worst kind of
 * missing.
 */
function indexable(uri: string, collection: string, record: unknown): record is Record<string, any> {
  if (!record || typeof record !== 'object') {
    emit('spaces', 'validation_skip', { uri, collection, error: 'record is not an object' })
    return false
  }
  const typed = record as Record<string, unknown>
  // A record whose $type disagrees with the collection it was filed under is
  // not the record the collection's table is shaped for.
  if (typeof typed.$type === 'string' && typed.$type !== collection) {
    emit('spaces', 'validation_skip', { uri, collection, error: `$type is ${typed.$type}` })
    return false
  }
  const problem = validateRecord(getLexiconArray(), collection, { $type: collection, ...typed })
  if (problem) {
    emit('spaces', 'validation_skip', { uri, collection, path: problem.path, error: problem.message })
    return false
  }
  return true
}

/**
 * The current value of one record, read from its writer's host and checked
 * against the MAC the host answered with. Null when the record is gone.
 */
async function fetchRecord(
  watch: SpaceWatch,
  writer: string,
  collection: string,
  rkey: string,
  credential: SpaceCredential,
  writerHost: string,
): Promise<{ cid: string; value: Record<string, unknown> } | null> {
  const uri = spaceRecordUri(watch.space, writer, collection, rkey)
  const mac = await requestMac(RECORD_MAC_TYPE, writer)
  let res: Response
  try {
    res = await credentialedFetch(
      credential,
      writerHost,
      'com.atproto.space.getRecord',
      { space: watch.space, repo: writer, collection, rkey },
      mac.headers,
    )
  } catch (err) {
    if (statusOf(err) === 404 || codeOf(err) === 'RecordNotFound') return null
    throw err
  }
  const out = (await res.json()) as { uri: string; cid: string; value: Record<string, unknown> }
  const verified = await verifyRecord(
    { uri: out.uri, cid: out.cid, value: jsonToLex(out.value as JsonValue) as LexMap },
    { uri, sharedSecret: mac.sharedSecret, mac: responseMac(res, mac) },
  )
  if (!verified) throw new RepoVerificationError(`record failed verification: ${uri}`)
  return { cid: out.cid, value: out.value }
}

/**
 * Apply ops to the index, once they have been verified.
 *
 * Ops carry no action: a create has no `prev`, a delete no `cid`, an update
 * both. And `value` is inlined only when it is still the record's current
 * value, so an op superseded later arrives without one — which is why the
 * final state per rkey is resolved here before anything is written, and why a
 * final op still missing its value has to be fetched.
 */
async function applyOps(
  watch: SpaceWatch,
  writer: string,
  ops: SpaceOp[],
  credential: SpaceCredential,
  writerHost: string,
): Promise<{ inserted: number; deleted: number; skipped: number }> {
  const indexed = new Set(collectionsForSpaceType(watch.spaceType))
  // Last op wins per record: a page can create and then delete the same rkey,
  // and only the end state belongs in the index.
  const final = new Map<string, SpaceOp>()
  for (const op of ops) {
    if (!indexed.has(op.collection)) continue
    final.set(`${op.collection}/${op.rkey}`, op)
  }

  let inserted = 0
  let deleted = 0
  let skipped = 0
  for (const op of final.values()) {
    const uri = spaceRecordUri(watch.space, writer, op.collection, op.rkey)
    if (!op.cid) {
      await deleteRecord(op.collection, uri)
      deleted++
      continue
    }

    let cid = op.cid
    let value = op.value
    if (!value) {
      // Superseded since, or served metadata-only. Either way the current
      // value is one round trip away and the alternative is an index that
      // silently disagrees with the repo.
      const current = await fetchRecord(watch, writer, op.collection, op.rkey, credential, writerHost)
      if (!current) {
        await deleteRecord(op.collection, uri)
        deleted++
        continue
      }
      cid = current.cid
      value = current.value
    }

    if (!indexable(uri, op.collection, value)) {
      skipped++
      continue
    }
    noteReferencedRepos(op.collection, op.rkey, value)
    await insertRecord(op.collection, uri, cid, writer, { $type: op.collection, ...value })
    inserted++
  }
  return { inserted, deleted, skipped }
}

// --- Sync ---

/** A value an op inlines must be the record its cid names. */
async function checkOpValue(op: SpaceOp): Promise<void> {
  if (!op.value || !op.cid) return
  const cid = await cidForCbor(encode(jsonToLex(op.value as JsonValue)))
  if (!cid.equals(parseCid(op.cid))) {
    throw new RepoVerificationError(`op value does not match its cid: ${op.collection}/${op.rkey}`)
  }
}

/**
 * Read one writer's repo forward from where we left it.
 *
 * Every op is folded into the set hash held at our position, and the result
 * must match the head commit the host MACs; nothing is applied until it does.
 * Returns null if the op log could not carry us to the head — the log is a
 * transport optimization with no history guarantee, so a host may have
 * compacted past our position, and the answer then is a full read rather
 * than a gap.
 */
async function syncForward(
  watch: SpaceWatch,
  writer: string,
  from: RepoPosition,
  credential: SpaceCredential,
  writerHost: string,
): Promise<RepoPosition | null> {
  const repo = RepoCommit.fromState(from.setHash)
  const ops: SpaceOp[] = []
  let cursor: string | undefined
  let head: Commit | null = null

  for (let page = 0; page < 100; page++) {
    // A fresh key share per request: a MAC is only ever good for one.
    const mac = await requestMac(COMMIT_MAC_TYPE, writer)
    const res = await credentialedFetch(
      credential,
      writerHost,
      'com.atproto.space.listRepoOps',
      { space: watch.space, repo: writer, since: from.rev, cursor, limit: OPS_PAGE },
      mac.headers,
    )
    const out = (await res.json()) as { ops?: SpaceOp[]; commit?: JsonValue; cursor?: string }
    for (const op of out.ops ?? []) {
      await checkOpValue(op)
      repo.applyOp({
        collection: op.collection as `${string}.${string}.${string}`,
        rkey: op.rkey,
        cid: op.cid ? parseCid(op.cid) : null,
        prev: op.prev ? parseCid(op.prev) : null,
      })
      ops.push(op)
    }

    // The commit describes the head, so it only appears once the response has
    // reached it; a full page has more behind it and carries a cursor instead.
    if (out.commit) {
      const commit = jsonToLex(out.commit) as unknown as Commit
      const params = { space: watch.space, repo: writer, sharedSecret: mac.sharedSecret, mac: responseMac(res, mac) }
      if (!verifyCommit(commit, params)) throw new RepoVerificationError('commit failed verification')
      head = commit
      break
    }
    cursor = typeof out.cursor === 'string' ? out.cursor : undefined
    if (!cursor) break
  }

  if (!head) return null
  if (!repo.matches(head)) throw new RepoVerificationError('ops do not add up to the commit')

  const totals = await applyOps(watch, writer, ops, credential, writerHost)
  if (totals.inserted || totals.deleted || totals.skipped) {
    emit('spaces', 'sync_ops', { space: watch.space, writer, ...totals, head: head.rev })
  }
  return { rev: head.rev, setHash: repo.setHash.state() }
}

/**
 * Read a writer's whole repo in a space and replace what the index holds for it.
 *
 * One archive, the commit its metadata and every record after it, checked
 * against the MAC before a record is trusted and against the commit's set
 * hash once the last one is in.
 */
async function syncFull(
  watch: SpaceWatch,
  writer: string,
  credential: SpaceCredential,
  writerHost: string,
): Promise<RepoPosition | null> {
  const collections = collectionsForSpaceType(watch.spaceType)
  if (collections.length === 0) return null

  const mac = await requestMac(COMMIT_MAC_TYPE, writer)
  let res: Response
  try {
    res = await credentialedFetch(
      credential,
      writerHost,
      'com.atproto.space.getRepo',
      { space: watch.space, repo: writer },
      mac.headers,
    )
  } catch (err) {
    // A writer the authority named but whose host holds no repo for them yet:
    // nothing to read, and nothing wrong.
    if (statusOf(err) === 404 || codeOf(err) === 'RepoNotFound') return null
    throw err
  }
  if (!res.body) throw new RepoVerificationError('getRepo returned no archive')
  const { commit, records } = await verifyRepoStarFull(res.body as unknown as AsyncIterable<Uint8Array>, {
    space: watch.space,
    repo: writer,
    sharedSecret: mac.sharedSecret,
    mac: responseMac(res, mac),
  })

  const wanted = new Set(collections)
  const rows: { collection: string; uri: string; cid: string; did: string; record: Record<string, any> }[] = []
  let skipped = 0
  for (const rec of records) {
    if (!wanted.has(rec.collection)) continue
    const uri = spaceRecordUri(watch.space, writer, rec.collection, rec.rkey)
    const value = lexToJson(rec.record) as Record<string, unknown>
    if (!indexable(uri, rec.collection, value)) {
      skipped++
      continue
    }
    noteReferencedRepos(rec.collection, rec.rkey, value)
    rows.push({
      collection: rec.collection,
      uri,
      cid: rec.cid.toString(),
      did: writer,
      record: { $type: rec.collection, ...value },
    })
  }

  await purgeSpaceRecords(watch.space, writer, collections)
  const inserted = rows.length > 0 ? await bulkInsertRecords(rows) : 0
  emit('spaces', 'sync_full', { space: watch.space, writer, inserted, skipped, rev: commit.rev })
  return { rev: commit.rev, setHash: RepoCommit.fromRecords(records).setHash.state() }
}

/** Bring one writer's repo in a space up to date, however that has to happen. */
export async function syncSpaceRepo(watch: SpaceWatch, writer: string, credential: SpaceCredential): Promise<void> {
  const writerHost = await repoEndpoint(writer)
  const local = await getSpaceRepo(watch.space, writer)

  let position: RepoPosition | null = null
  if (local?.rev && local.setHash) {
    try {
      const from = { rev: local.rev, setHash: new Uint8Array(Buffer.from(local.setHash, 'base64')) }
      position = await syncForward(watch, writer, from, credential, writerHost)
    } catch (err) {
      if (statusOf(err) === 401) throw err
      emit('spaces', 'incremental_fell_back', {
        space: watch.space,
        writer,
        since: local.rev,
        error: err instanceof Error ? err.message : String(err),
      })
      position = null
    }
  }
  if (!position) position = await syncFull(watch, writer, credential, writerHost)
  if (!position) return

  await putSpaceRepo({
    space: watch.space,
    did: writer,
    pds: writerHost,
    rev: position.rev,
    setHash: Buffer.from(position.setHash).toString('base64'),
  })
}

// --- Reconcile ---

/**
 * Subscribe to this space's write notices, if this instance can receive them.
 *
 * Authenticated with the space credential, so only somebody the authority
 * already admits can subscribe — which is why this happens inside reconcile,
 * where a credential is already in hand. The delivery endpoint is not sent:
 * the authority resolves it from our own DID document, so a registration can
 * only ever point at an endpoint we published for ourselves.
 *
 * Best-effort. Failing to register costs latency, not correctness, and must
 * not fail the sweep that was about to read the space anyway.
 */
async function ensureRegistered(watch: SpaceWatch, credential: SpaceCredential): Promise<void> {
  const { serviceId } = requireOptions()
  if (!serviceId) return
  const until = watch.registeredUntil ? Date.parse(watch.registeredUntil) : 0
  if (Number.isFinite(until) && until - REGISTRATION_RENEW_LEAD_MS > Date.now()) return

  try {
    const authorityHost = await spaceHostEndpoint(watch.authority)
    const res = await credential.fetch(`${authorityHost}/xrpc/com.atproto.space.registerNotify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ space: watch.space, service: serviceId }),
    })
    if (!res.ok) throw new Error(`registerNotify refused (${res.status})`)
    const body = (await res.json()) as { expiresAt?: string }
    if (body.expiresAt) {
      await updateSpaceWatch(watch.space, { registeredUntil: body.expiresAt })
      watch.registeredUntil = body.expiresAt
    }
    emit('spaces', 'registered', { space: watch.space, expires_at: body.expiresAt })
  } catch (err) {
    emit('spaces', 'register_failed', {
      space: watch.space,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function listWriters(
  watch: SpaceWatch,
  credential: SpaceCredential,
): Promise<{ did: string; rev: string | null }[]> {
  const authorityHost = await spaceHostEndpoint(watch.authority)
  const writers: { did: string; rev: string | null }[] = []
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const out = await credentialedGet(credential, authorityHost, 'com.atproto.space.listRepos', {
      space: watch.space,
      cursor,
      limit: 1000,
    })
    // Ordered by space revision, and a repo updated mid-walk can turn up twice;
    // the later entry is the newer state. The walk ends on an empty page, the
    // only one without a cursor.
    for (const repo of (out.repos ?? []) as { did: string; repoRev?: string }[]) {
      writers.push({ did: repo.did, rev: typeof repo.repoRev === 'string' ? repo.repoRev : null })
    }
    cursor = typeof out.cursor === 'string' ? out.cursor : undefined
    if (!cursor) break
  }
  return [...new Map(writers.map((w) => [w.did, w])).values()]
}

/**
 * Compare the authority's writer set against what the index holds, and close
 * the difference.
 *
 * The writer set is what the authority has been told, not what is true: a
 * repo's own host is the source of truth, and after a community migrates hosts
 * the set is empty until each writer writes again. So a writer the authority
 * stops naming has their rows dropped, but the rev comparison is only ever a
 * reason to read — never a reason to believe a repo has not moved.
 */
export async function reconcileSpace(watch: SpaceWatch): Promise<void> {
  const elapsed = timer()
  await withCredential(watch, async (credential) => {
    await ensureRegistered(watch, credential)
    const writers = await listWriters(watch, credential)
    const remote = new Set(writers.map((w) => w.did))

    // Whoever writes into the space is somebody the app will name, so their
    // public repo — profile first of all — is indexed too.
    for (const writer of writers) trackRepo(writer.did)

    let synced = 0
    for (const writer of writers) {
      const local = await getSpaceRepo(watch.space, writer.did)
      if (local?.rev && writer.rev && local.rev === writer.rev) continue
      await syncSpaceRepo(watch, writer.did, credential)
      synced++
    }

    // A writer the space no longer names is not readable through it any more,
    // so neither are their rows.
    let dropped = 0
    const collections = collectionsForSpaceType(watch.spaceType)
    for (const local of await listSpaceRepos(watch.space)) {
      if (remote.has(local.did)) continue
      await purgeSpaceRecords(watch.space, local.did, collections)
      await deleteSpaceRepo(watch.space, local.did)
      dropped++
    }

    await updateSpaceWatch(watch.space, { lastError: null })
    emit('spaces', 'reconcile', {
      space: watch.space,
      writers: writers.length,
      synced,
      dropped,
      reader_did: watch.readerDid,
      duration_ms: elapsed(),
    })
  })
}

// --- Public surface ---

/** Follow a space from now on, and read it once. */
export async function watchSpace(space: string): Promise<SpaceWatch> {
  const { types } = requireOptions()
  const ref = parseSpaceRef(space)
  if (!ref) throw new Error(`Not a space ref: ${space}`)
  if (!types.has(ref.type)) throw new Error(`Not an indexed space type: ${ref.type}`)

  await putSpaceWatch({ space, authority: ref.authority, spaceType: ref.type })
  const watch = (await getSpaceWatch(space))!
  await reconcileSpace(watch)
  return watch
}

/** Stop following a space and drop everything indexed from it. */
export async function unwatchSpace(space: string): Promise<void> {
  const watch = await getSpaceWatch(space)
  if (watch) {
    const collections = collectionsForSpaceType(watch.spaceType)
    for (const repo of await listSpaceRepos(space)) {
      await purgeSpaceRecords(space, repo.did, collections)
    }
  }
  await deleteSpaceWatch(space)
  forgetSpaceCredential(space)
  emit('spaces', 'unwatched', { space })
}

/**
 * Act on a write notice: read the one repo it names.
 *
 * Only for a space already followed. A notice about anything else is not an
 * instruction to start following it — that decision belongs to config or to the
 * app, never to whoever can reach this endpoint.
 *
 * The notice's `rev` is deliberately not trusted as the new position: it is
 * read from the repo's own host, which is the source of truth, by the ordinary
 * sync path. The notice only says "look again".
 */
export async function handleWriteNotice(notice: { space: string; repo: string }): Promise<boolean> {
  const watch = await getSpaceWatch(notice.space)
  if (!watch) return false
  await withCredential(watch, (credential) => syncSpaceRepo(watch, notice.repo, credential))
  return true
}

/**
 * Reconcile every followed space.
 *
 * Failures are per space and recorded rather than thrown: one community's host
 * being unreachable is not a reason to stop reading the others, and a space
 * whose last reader logged out should go quiet rather than take the sweep down.
 */
export async function reconcileAll(): Promise<void> {
  for (const watch of await listSpaceWatches()) {
    try {
      await reconcileSpace(watch)
    } catch (err) {
      if (isSpaceGone(err)) {
        await unwatchSpace(watch.space)
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      await updateSpaceWatch(watch.space, { lastError: message })
      emit('spaces', 'reconcile_failed', { space: watch.space, error: message })
    }
  }
}
