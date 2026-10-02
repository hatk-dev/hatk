/**
 * Classifier system for scoring accounts and records with Clef, Cloudflare's
 * decision model on Workers AI.
 *
 * A classifier is the moderation counterpart to a label rule: where a label rule
 * decides from the record alone, a classifier asks a model a set of narrow typed
 * questions and stores the probabilities. Nothing acts on a score — crossing a
 * threshold files a report into the same `_reports` queue a user report lands in,
 * so a person still makes every enforcement decision.
 *
 * Place classifier modules in the `classifiers/` directory.
 *
 * @example
 * ```ts
 * // classifiers/impersonation.ts
 * import { defineClassifier } from '$hatk'
 *
 * export default defineClassifier({
 *   subject: 'account',
 *   label: 'impersonation',
 *   threshold: 0.7,
 *   questions: {
 *     passing_as: {
 *       type: 'noul',
 *       instructions: 'Is this account trying to be mistaken for a famous person?',
 *     },
 *   },
 *   async buildState({ subject, db }) {
 *     const [p] = await db.query(`SELECT description FROM profile WHERE did = $1`, [subject.did])
 *     return { handle: subject.handle, bio: p?.description }
 *   },
 * })
 * ```
 */
import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  querySQL,
  runSQL,
  getSchema,
  listSchemas,
  getCursor,
  setCursor,
  upsertClassification,
  getClassificationFingerprints,
  getClassificationFingerprint,
  findOpenReport,
  insertReport,
} from './database/db.ts'
import { log, emit } from './logger.ts'

/** A typed question in the shape Clef accepts. */
export interface ClassifierQuestion {
  type: 'noul' | 'choice' | 'score'
  instructions: string | Record<string, unknown> | unknown[]
  criteria?: unknown
}

/** The thing being scored: an account (by DID) or a single record. */
export interface ClassifierSubject {
  /** `at://` URI for a record subject; the bare DID for an account subject. */
  uri: string
  did: string
  handle?: string | null
  collection?: string
  value?: Record<string, any>
}

export interface ClassifierContext {
  db: {
    query: (sql: string, params?: any[]) => Promise<any[]>
    run: (sql: string, ...params: any[]) => Promise<void>
  }
  subject: ClassifierSubject
}

export interface ClassifierModule {
  /** `account` scans every indexed repo; `record` scans rows of `collections`. */
  subject: 'account' | 'record'
  /** Collections to scan. Required when `subject` is `record`. */
  collections?: string[]
  /** The questions to ask. Answers come back under the same keys. Omit when
   *  the classifier supplies its own `classify`. */
  questions?: Record<string, ClassifierQuestion>
  /**
   * Produce signals without asking Clef.
   *
   * A classifier that runs its own model — an image classifier on the host, a
   * hash lookup, a heuristic — sets this instead of `questions`. Everything
   * downstream is unchanged: the same thresholds, the same report, the same
   * review card. Return a bare number for a plain score.
   */
  classify?: (state: Record<string, unknown>, ctx: ClassifierContext) => Promise<Record<string, number | Signal>>
  /**
   * Build the model `state` for this subject. Return `null` to skip it — a
   * skipped subject costs no tokens. Gate on whatever makes the question
   * answerable: an account with no content cannot be judged on its content.
   */
  buildState: (ctx: ClassifierContext) => Promise<Record<string, unknown> | null>
  /**
   * URLs of images to show the model alongside `state`, at most four. hatk
   * fetches each and embeds it in the request, since Clef takes images inline
   * rather than by reference.
   *
   * Return small renditions. Clef's context window is counted on the encoded
   * bytes, so a full-size photo can overflow it where a 512px one never does.
   * The state should carry whatever identifies the image — a blob CID — so
   * that a changed image changes the fingerprint and is scored again.
   */
  images?: (state: Record<string, unknown>, ctx: ClassifierContext) => Promise<string[]> | string[]
  /**
   * Score at or above which a signal files a report. A number applies to every
   * question; a map sets it per question. Questions absent from the map never
   * file, though their scores are still stored and shown.
   */
  threshold?: number | Record<string, number>
  /** Label the filed report carries. A function receives the crossing signal. */
  label?: string | ((signal: string, score: number) => string)
}

export function defineClassifier(module: ClassifierModule) {
  return { __type: 'classifiers' as const, ...module }
}

interface LoadedClassifier extends ClassifierModule {
  name: string
}

const classifiers: LoadedClassifier[] = []

/** Discover and load classifier modules from the `classifiers/` directory. */
export async function initClassifiers(classifiersDir: string): Promise<void> {
  let files: string[]
  try {
    files = readdirSync(classifiersDir)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('_'))
      .sort()
  } catch {
    return
  }

  for (const file of files) {
    const name = file.replace(/\.(ts|js)$/, '')
    const scriptPath = resolve(classifiersDir, file)
    const mod = await import(/* @vite-ignore */ `${scriptPath}?t=${Date.now()}`)
    const handler = mod.default
    if (!handler?.buildState || !(handler.questions || handler.classify)) {
      log(`[classifiers] skipped ${name}: needs buildState plus questions or classify`)
      continue
    }
    classifiers.push({ name, ...handler })
    log(`[classifiers] discovered: ${name} (${handler.subject})`)
  }
}

/**
 * Register a classifier directly, bypassing directory discovery.
 *
 * Mirrors {@link registerLabelModule}: tests and embedders that build their own
 * module graph have no `classifiers/` directory to read.
 */
export function registerClassifier(name: string, module: ClassifierModule): void {
  classifiers.push({ name, ...module })
}

/** Clear all registered classifiers (for hot-reload). */
export function clearClassifiers(): void {
  classifiers.length = 0
}

/** Names of all loaded classifiers. */
export function listClassifiers(): string[] {
  return classifiers.map((c) => c.name)
}

export function getClassifier(name: string): LoadedClassifier | undefined {
  return classifiers.find((c) => c.name === name)
}

// ── Clef client ────────────────────────────────────────────────────────────

export interface ClefClientConfig {
  apiToken: string
  model: string
  endpoint: string
}

let clef: ClefClientConfig | null = null

export function configureClef(config: ClefClientConfig | null): void {
  clef = config
}

export function isClefConfigured(): boolean {
  return clef !== null
}

/** Clef's ceiling on images per request. */
const MAX_IMAGES = 4

/**
 * The longest side an image is sent at. Clef counts its context on the encoded
 * bytes: a 1000px feed thumbnail of 200KB or more overflows the 65k window,
 * while at 512px every image measured fit in about a thousand tokens.
 */
const IMAGE_EDGE = 512

let sharpModule: Promise<typeof import('sharp').default | null> | undefined
function loadSharp(): Promise<typeof import('sharp').default | null> {
  sharpModule ??= import('sharp')
    .then((m) => m.default)
    .catch(() => {
      emit('classifiers', 'resize_unavailable', { reason: 'sharp is not installed' })
      return null
    })
  return sharpModule
}

/**
 * Fetch an image and embed it as the base64 data URI Clef requires, scaled
 * down to {@link IMAGE_EDGE}. Without sharp the original is sent, and an image
 * too large for the context window fails that one subject.
 */
async function embedImage(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`image ${res.status}: ${url}`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!/^image\/(png|jpeg|webp)$/.test(type))
    throw new Error(`image ${url} is ${type || 'untyped'}, not PNG, JPEG or WebP`)
  const source = Buffer.from(await res.arrayBuffer())

  const sharp = await loadSharp()
  if (!sharp) return `data:${type};base64,${source.toString('base64')}`
  const scaled = await sharp(source)
    .rotate()
    .resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  return `data:image/jpeg;base64,${scaled.toString('base64')}`
}

/** A single answer, normalized to a 0–1 score regardless of question type. */
export interface Signal {
  score: number
  type: string
  /** Choice/Score only: the selected option and its confidence. */
  choice?: string
  confidence?: number
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

/** A response that a retry would only repeat: a rejected request, or the last attempt. */
class FatalClefError extends Error {}

/**
 * Ask Clef one request's worth of questions about one state.
 *
 * Retries on 429 and 5xx, honoring `retry-after` when the response carries one.
 * The caller's concurrency is what keeps us under the rate limit; this only
 * recovers the requests that still slip past it.
 */
export async function askClef(
  state: Record<string, unknown>,
  questions: Record<string, ClassifierQuestion>,
  opts: { images?: string[]; attempts?: number; signal?: AbortSignal } = {},
): Promise<{ answers: Record<string, Signal>; model: string; inputTokens: number }> {
  if (!clef) throw new Error('Clef is not configured — set `clef` in hatk.config.ts')
  const attempts = opts.attempts ?? 4
  const images = opts.images?.length ? opts.images : undefined
  const body = JSON.stringify({ state, model: clef.model, questions, ...(images ? { images } : {}) })

  let lastError: Error | null = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(clef.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${clef.apiToken}`, 'content-type': 'application/json' },
        body,
        signal: opts.signal,
      })

      if (!res.ok) {
        if (!RETRYABLE.has(res.status) || attempt === attempts - 1) {
          throw new FatalClefError(`Clef ${res.status}: ${(await res.text()).slice(0, 200)}`)
        }
        const retryAfter = Number(res.headers.get('retry-after'))
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }

      // Workers AI wraps the model's output in `{ result, success, errors }`.
      const json = (await res.json()) as any
      if (json.success === false) throw new FatalClefError(`Clef: ${JSON.stringify(json.errors).slice(0, 200)}`)
      const out = json.result ?? json
      const answers: Record<string, Signal> = {}
      for (const [key, a] of Object.entries<any>(out.answers ?? {})) {
        answers[key] = normalizeAnswer(a)
      }
      return { answers, model: out.model ?? clef.model, inputTokens: out.usage?.input_tokens ?? 0 }
    } catch (err: any) {
      if (err?.name === 'AbortError' || err instanceof FatalClefError) throw err
      lastError = err
      if (attempt === attempts - 1) break
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500))
    }
  }
  throw lastError ?? new Error('Clef request failed')
}

/**
 * Collapse any answer type to one 0–1 number so a mixed question set can share a
 * threshold. A Noul is already a probability. A Choice reports the probability
 * of the option it picked, and a Score its position across the levels — both
 * keep the original answer alongside, because the number alone loses which
 * option was chosen.
 */
function normalizeAnswer(a: any): Signal {
  if (a?.type === 'noul') return { score: a.noul ?? 0, type: 'noul' }
  if (a?.type === 'choice') {
    const choice = a.choice
    return { score: a.probabilities?.[choice] ?? 0, type: 'choice', choice, confidence: a.confidence }
  }
  if (a?.type === 'score') {
    const levels = a.probabilities ? Object.keys(a.probabilities).length : 0
    const raw = typeof a.score === 'number' ? a.score : 0
    return {
      score: levels > 1 ? raw / (levels - 1) : raw,
      type: 'score',
      choice: String(a.score),
      confidence: a.confidence,
    }
  }
  return { score: 0, type: a?.type ?? 'unknown' }
}

// ── Scanning ───────────────────────────────────────────────────────────────

export interface ScanProgress {
  /** Subjects considered. */
  scanned: number
  /** Gated out by `buildState` returning null, or unchanged since the last scan. */
  skipped: number
  /** Sent to the model and stored. */
  scored: number
  /** Reports filed for crossing a threshold. */
  filed: number
  errors: number
  inputTokens: number
  running: boolean
  startedAt: string
  finishedAt?: string
  error?: string
}

function thresholdFor(c: LoadedClassifier, signal: string): number | null {
  if (c.threshold == null) return null
  if (typeof c.threshold === 'number') return c.threshold
  return c.threshold[signal] ?? null
}

function labelFor(c: LoadedClassifier, signal: string, score: number): string {
  if (typeof c.label === 'function') return c.label(signal, score)
  return c.label ?? 'spam'
}

const dbCtx = {
  query: (sql: string, params?: any[]) => querySQL(sql, params) as Promise<any[]>,
  run: (sql: string, ...params: any[]) => runSQL(sql, params).then(() => undefined),
}

const TID_CHARS = '234567abcdefghijklmnopqrstuvwxyz'

/** When a TID record key was minted, or null if the key is not a TID. */
export function tidTime(rkey: string): Date | null {
  if (rkey.length !== 13) return null
  let n = 0n
  for (const ch of rkey) {
    const i = TID_CHARS.indexOf(ch)
    if (i < 0) return null
    n = n * 32n + BigInt(i)
  }
  return new Date(Number(n >> 10n) / 1000)
}

/**
 * Whether a row is new since `since`: written into its repo after then, not
 * merely indexed after then.
 *
 * Index time alone is not enough. A repo backfilled again rewrites every row
 * with a fresh `indexed_at`, so old content would read as new. `createdAt` is no
 * better: an import of an old archive carries the photos' original dates. The
 * record key is minted when the record is written, so for a TID key that is the
 * answer; a key that is not a TID (`self`) falls back to the index time the
 * caller has already filtered on.
 */
function isNewSince(uri: string, since: string): boolean {
  const t = tidTime(uri.slice(uri.lastIndexOf('/') + 1))
  return t === null || t.toISOString() >= since
}

/**
 * Rows of a table indexed at or after `since`, public ones only.
 *
 * The query names `indexed_at` alone. Given `space IS NULL` as well, SQLite
 * picks the space index, which matches nearly every row, and walks the whole
 * table; on a few million Bluesky posts that is seconds of a blocked process.
 * So the space filter is applied here instead.
 */
async function indexedSince(tableName: string, columns: string, since: string): Promise<Record<string, any>[]> {
  const rows = (await querySQL(`SELECT ${columns}, space FROM ${tableName} WHERE indexed_at >= $1`, [since])) as Record<
    string,
    any
  >[]
  return rows.filter((r) => r.space == null)
}

/** Active DIDs with any public record new since `since`, in any collection. */
async function activeSince(since: string): Promise<Set<string>> {
  const dids = new Set<string>()
  for (const schema of listSchemas()) {
    for (const r of await indexedSince(schema.tableName, 'uri, did', since)) {
      if (isNewSince(r.uri, since)) dids.add(r.did)
    }
  }
  return dids
}

/**
 * Every subject a classifier applies to. With `since`, only what is new after
 * it: records written after then, and accounts that wrote one.
 */
async function enumerateSubjects(c: LoadedClassifier, since?: string): Promise<ClassifierSubject[]> {
  if (c.subject === 'account') {
    const rows = (await querySQL(`SELECT did, handle FROM _repos WHERE status = 'active'`)) as {
      did: string
      handle: string | null
    }[]
    const recent = since ? await activeSince(since) : null
    return rows.filter((r) => !recent || recent.has(r.did)).map((r) => ({ uri: r.did, did: r.did, handle: r.handle }))
  }

  const out: ClassifierSubject[] = []
  let active: Set<string> | undefined
  for (const collection of c.collections ?? []) {
    const schema = getSchema(collection)
    if (!schema) continue
    // The same population as an account scan: active repos only, so content an
    // administrator already took down is not filed again. Space rows are left
    // out entirely; they are members' permissioned data, not public posts.
    let rows: Record<string, any>[]
    if (since) {
      active ??= new Set(
        ((await querySQL(`SELECT did FROM _repos WHERE status = 'active'`)) as { did: string }[]).map((r) => r.did),
      )
      rows = (await indexedSince(schema.tableName, '*', since)).filter((r) => active!.has(r.did))
    } else {
      rows = (await querySQL(
        `SELECT t.* FROM ${schema.tableName} t
           JOIN _repos r ON r.did = t.did AND r.status = 'active'
          WHERE t.space IS NULL`,
      )) as Record<string, any>[]
    }
    for (const row of rows) {
      if (since && !isNewSince(row.uri, since)) continue
      out.push({ uri: row.uri, did: row.did, collection, value: rowValue(schema, row) })
    }
  }
  return out
}

/** A table row back in the record's own field names, JSON columns parsed. */
function rowValue(schema: NonNullable<ReturnType<typeof getSchema>>, row: Record<string, any>): Record<string, any> {
  const value: Record<string, any> = {}
  for (const col of schema.columns) {
    let v = row[col.name]
    if (v === null || v === undefined) continue
    if (col.isJson && typeof v === 'string') {
      try {
        v = JSON.parse(v)
      } catch {}
    }
    value[col.originalName] = v
  }
  return value
}

/**
 * The questions are part of what produced a score, so a fingerprint covers them
 * as well as the state: rewording a classifier's criteria, or changing which
 * images it sends, invalidates every score written under the old version.
 */
function classifierHash(c: LoadedClassifier): string {
  return createHash('sha256')
    .update(JSON.stringify(c.questions ?? c.classify?.toString() ?? ''))
    .update(c.images?.toString() ?? '')
    .digest('hex')
    .slice(0, 16)
}

type Outcome = { outcome: 'skipped' } | { outcome: 'scored'; filed: boolean; inputTokens: number }

/**
 * Score one subject: build its state, skip it if that state was already scored
 * (`known` is the stored fingerprint), otherwise ask the model, store the
 * result, and file a report if a signal crosses its threshold. Throws on a
 * failure, for the caller to count or retry.
 */
async function scoreSubject(
  c: LoadedClassifier,
  subject: ClassifierSubject,
  hash: string,
  known: string | undefined,
  signal?: AbortSignal,
): Promise<Outcome> {
  const state = await c.buildState({ db: dbCtx, subject })
  if (!state) return { outcome: 'skipped' }
  const fingerprint = createHash('sha256').update(hash).update(JSON.stringify(state)).digest('hex').slice(0, 32)
  if (known === fingerprint) return { outcome: 'skipped' }

  let answers: Record<string, Signal>
  let model: string
  let inputTokens = 0
  if (c.classify) {
    const raw = await c.classify(state, { db: dbCtx, subject })
    answers = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === 'number' ? { score: v, type: 'local' } : v]),
    )
    model = `local:${c.name}`
  } else {
    const urls = c.images ? (await c.images(state, { db: dbCtx, subject })).slice(0, MAX_IMAGES) : []
    const images = await Promise.all(urls.map((u) => embedImage(u, signal)))
    const res = await askClef(state, c.questions!, { images, signal })
    answers = res.answers
    model = res.model
    inputTokens = res.inputTokens
  }

  let topSignal: string | null = null
  let topScore = 0
  for (const [name, sig] of Object.entries(answers)) {
    if (sig.score > topScore) {
      topScore = sig.score
      topSignal = name
    }
  }

  await upsertClassification({
    subjectUri: subject.uri,
    subjectDid: subject.did,
    classifier: c.name,
    signals: answers,
    state,
    topSignal,
    topScore,
    fingerprint,
    model,
  })

  // File on the highest-scoring signal that crosses its own threshold — a
  // second report for the same subject would only split the review.
  let crossing: { signal: string; score: number } | null = null
  for (const [name, sig] of Object.entries(answers)) {
    const t = thresholdFor(c, name)
    if (t != null && sig.score >= t && (!crossing || sig.score > crossing.score)) {
      crossing = { signal: name, score: sig.score }
    }
  }
  let filed = false
  if (crossing) {
    const label = labelFor(c, crossing.signal, crossing.score)
    if (!(await findOpenReport(subject.uri, label))) {
      await insertReport({
        subjectUri: subject.uri,
        subjectDid: subject.did,
        label,
        reason: `${c.name}: ${crossing.signal} ${crossing.score.toFixed(2)}`,
        reportedBy: `system:${c.name}`,
      })
      filed = true
    }
  }
  return { outcome: 'scored', filed, inputTokens }
}

let current: ScanProgress | null = null

/** Progress of the scan in flight, or the last one to finish. */
export function getScanProgress(): ScanProgress | null {
  return current
}

/**
 * Score every subject a classifier applies to, storing results and filing a
 * report for each crossing signal.
 *
 * Subjects whose state is unchanged since the last scan are skipped unless
 * `force` is set, so a repeat scan costs only what actually moved.
 */
export async function runScan(
  opts: {
    classifier?: string
    force?: boolean
    limit?: number
    concurrency?: number
    signal?: AbortSignal
    /** Only subjects new after this ISO time; see {@link enumerateSubjects}. */
    since?: string
  } = {},
): Promise<ScanProgress> {
  if (current?.running) throw new Error('A scan is already running')

  const selected = opts.classifier ? classifiers.filter((c) => c.name === opts.classifier) : classifiers
  if (!selected.length) throw new Error(opts.classifier ? `No classifier named ${opts.classifier}` : 'No classifiers')
  // Only the classifiers that actually ask Clef need it configured. A
  // host-local classifier runs with no API token at all.
  if (selected.some((c) => !c.classify) && !isClefConfigured()) throw new Error('Clef is not configured')

  const progress: ScanProgress = {
    scanned: 0,
    skipped: 0,
    scored: 0,
    filed: 0,
    errors: 0,
    inputTokens: 0,
    running: true,
    startedAt: new Date().toISOString(),
  }
  current = progress

  try {
    for (const c of selected) {
      const subjects = await enumerateSubjects(c, opts.since)
      const seen = opts.force ? new Map<string, string>() : await getClassificationFingerprints(c.name)
      const hash = classifierHash(c)
      const queue = opts.limit ? subjects.slice(0, opts.limit) : subjects
      const concurrency = opts.concurrency ?? 8

      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
          if (opts.signal?.aborted) return
          const subject = queue[cursor++]
          progress.scanned++
          try {
            const res = await scoreSubject(c, subject, hash, seen.get(subject.uri), opts.signal)
            if (res.outcome === 'skipped') {
              progress.skipped++
              continue
            }
            progress.scored++
            progress.inputTokens += res.inputTokens
            if (res.filed) progress.filed++
          } catch (err: any) {
            if (err?.name === 'AbortError') return
            progress.errors++
            emit('classifiers', 'scan_error', { classifier: c.name, subject: subject.uri, error: err.message })
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    }
  } catch (err: any) {
    progress.error = err.message
    throw err
  } finally {
    progress.running = false
    progress.finishedAt = new Date().toISOString()
    // A scheduled pass that found nothing new is the common case, every few
    // minutes; only a pass that did something is worth a line.
    if (!opts.since || progress.scored || progress.errors)
      log(
        `[classifiers] scan: ${progress.scored} scored, ${progress.skipped} skipped, ` +
          `${progress.filed} filed, ${progress.errors} errors, ${progress.inputTokens} tokens`,
      )
  }

  return progress
}

// ── Scoring on index ───────────────────────────────────────────────────────

/** Where scoring's starting point is kept, so a restart keeps it. */
const SINCE_CURSOR = 'classifiers:since'

/**
 * How long an account waits after its last write before it is scored. An import
 * writes hundreds of photos in a row, and an account's state counts them, so
 * scoring on every write would ask the model once per photo; waiting for the
 * account to settle asks once.
 */
const ACCOUNT_SETTLE_MS = 60_000
const LIVE_CONCURRENCY = 4
/** How long after boot the catch-up pass waits. */
let CATCH_UP_DELAY_MS = 60_000

/** For tests: run the boot catch-up after `ms` rather than a minute. */
export function _setCatchUpDelayForTests(ms: number): void {
  CATCH_UP_DELAY_MS = ms
}
const MAX_ATTEMPTS = 5

interface Pending {
  classifier: LoadedClassifier
  /** For a record, its collection; the row is read when the item is scored. */
  collection?: string
  uri: string
  did: string
  attempts: number
}

let since: string | null = null
const pending = new Map<string, Pending>()
const settling = new Map<string, ReturnType<typeof setTimeout>>()
let inFlight = 0

/**
 * Score new content as it is indexed, from the moment this was first switched
 * on. What existed before then is never scored here — a pass over the existing
 * library is a deliberate, manual scan from /admin.
 *
 * Starts with one catch-up pass over everything new since that moment, which
 * picks up what a restart dropped from the queue; anything already scored is
 * skipped on its fingerprint before it costs a model call.
 */
export async function startScoringOnIndex(): Promise<void> {
  since = await getCursor(SINCE_CURSOR)
  if (!since) {
    since = new Date().toISOString()
    await setCursor(SINCE_CURSOR, since)
  }
  log(`[classifiers] scoring on index, for content new since ${since}`)
  // Held back from boot: the catch-up reads the database, and a server still
  // starting up should not wait on that.
  const from = since
  const catchUp = setTimeout(() => {
    if (since !== from || current?.running) return
    runScan({ since: from }).catch((err) => emit('classifiers', 'catch_up_error', { error: err.message }))
  }, CATCH_UP_DELAY_MS)
  catchUp.unref?.()
}

export function stopScoringOnIndex(): void {
  since = null
  pending.clear()
  for (const t of settling.values()) clearTimeout(t)
  settling.clear()
}

/**
 * Called by the indexer with each batch it applied. Queues every new record for
 * the record classifiers that cover its collection, and its author for the
 * account classifiers once the author has settled. Returns immediately: the
 * indexer never waits on a model.
 */
export function noteIndexed(
  items: Array<{ action: 'create' | 'delete'; collection: string; uri: string; authorDid: string }>,
): void {
  if (!since || !classifiers.length) return
  for (const item of items) {
    if (item.action !== 'create' || !isNewSince(item.uri, since)) continue
    for (const c of classifiers) {
      if (c.subject === 'record' && c.collections?.includes(item.collection)) {
        enqueue({ classifier: c, collection: item.collection, uri: item.uri, did: item.authorDid, attempts: 0 })
      }
    }
    if (!classifiers.some((c) => c.subject === 'account')) continue
    clearTimeout(settling.get(item.authorDid))
    const did = item.authorDid
    const timer = setTimeout(() => {
      settling.delete(did)
      for (const c of classifiers) {
        if (c.subject === 'account') enqueue({ classifier: c, uri: did, did, attempts: 0 })
      }
    }, ACCOUNT_SETTLE_MS)
    timer.unref?.()
    settling.set(did, timer)
  }
}

/**
 * Called by the indexer when a repo backfill lands. Its rows were written
 * without passing through {@link noteIndexed} — a new account's first posts
 * arrive this way — so queue whatever in it is new.
 */
export function noteBackfilled(did: string): void {
  if (!since || !classifiers.length) return
  const from = since
  void (async () => {
    const items: Parameters<typeof noteIndexed>[0] = []
    // Every collection, not only the record classifiers': a write anywhere is
    // what queues the account for the account classifiers.
    for (const schema of listSchemas()) {
      const collection = schema.collection
      const rows = (await querySQL(`SELECT uri FROM ${schema.tableName} WHERE did = $1 AND space IS NULL`, [did])) as {
        uri: string
      }[]
      for (const r of rows)
        if (isNewSince(r.uri, from)) items.push({ action: 'create', collection, uri: r.uri, authorDid: did })
    }
    noteIndexed(items)
  })().catch((err) => emit('classifiers', 'backfill_queue_error', { did, error: err.message }))
}

function enqueue(item: Pending): void {
  pending.set(`${item.classifier.name}|${item.uri}`, item)
  pump()
}

function pump(): void {
  while (inFlight < LIVE_CONCURRENCY && pending.size) {
    const [key, item] = pending.entries().next().value as [string, Pending]
    pending.delete(key)
    inFlight++
    scorePending(item)
      .catch((err) => {
        item.attempts++
        if (item.attempts >= MAX_ATTEMPTS || !since) {
          emit('classifiers', 'live_dropped', {
            classifier: item.classifier.name,
            subject: item.uri,
            error: err.message,
          })
          return
        }
        const retry = setTimeout(() => enqueue(item), 2 ** item.attempts * 5_000)
        retry.unref?.()
      })
      .finally(() => {
        inFlight--
        pump()
      })
  }
}

/** Read the subject as it stands now, and score it if it is still in scope. */
async function scorePending(item: Pending): Promise<void> {
  const c = item.classifier
  let subject: ClassifierSubject
  if (item.collection) {
    const schema = getSchema(item.collection)
    if (!schema) return
    const [row] = (await querySQL(
      `SELECT t.* FROM ${schema.tableName} t
         JOIN _repos r ON r.did = t.did AND r.status = 'active'
        WHERE t.uri = $1 AND t.space IS NULL`,
      [item.uri],
    )) as Record<string, any>[]
    // Deleted, taken down, or in a space since it was queued.
    if (!row) return
    subject = { uri: row.uri, did: row.did, collection: item.collection, value: rowValue(schema, row) }
  } else {
    const [repo] = (await querySQL(`SELECT did, handle FROM _repos WHERE did = $1 AND status = 'active'`, [
      item.did,
    ])) as { did: string; handle: string | null }[]
    if (!repo) return
    subject = { uri: repo.did, did: repo.did, handle: repo.handle }
  }

  const res = await scoreSubject(c, subject, classifierHash(c), await getClassificationFingerprint(c.name, subject.uri))
  if (res.outcome === 'scored' && res.filed) log(`[classifiers] ${c.name} filed a report on ${subject.uri}`)
}

/** Items waiting to be scored, for tests and the admin view. */
export function pendingCount(): number {
  return pending.size + inFlight
}
