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
  upsertClassification,
  getClassificationFingerprints,
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

/** Every subject a classifier applies to, as `{uri, did, handle, value}`. */
async function enumerateSubjects(c: LoadedClassifier): Promise<ClassifierSubject[]> {
  if (c.subject === 'account') {
    const rows = (await querySQL(`SELECT did, handle FROM _repos WHERE status = 'active'`)) as {
      did: string
      handle: string | null
    }[]
    return rows.map((r) => ({ uri: r.did, did: r.did, handle: r.handle }))
  }

  const out: ClassifierSubject[] = []
  for (const collection of c.collections ?? []) {
    const schema = getSchema(collection)
    if (!schema) continue
    const rows = (await querySQL(`SELECT * FROM ${schema.tableName}`)) as Record<string, any>[]
    for (const row of rows) {
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
      out.push({ uri: row.uri, did: row.did, collection, value })
    }
  }
  return out
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
      const subjects = await enumerateSubjects(c)
      const seen = opts.force ? new Map<string, string>() : await getClassificationFingerprints(c.name)
      // The questions are part of what produced a score, so the fingerprint
      // covers them as well as the state: rewording a classifier's criteria,
      // or changing which images it sends, invalidates every score written
      // under the old version.
      const questionsHash = createHash('sha256')
        .update(JSON.stringify(c.questions ?? c.classify?.toString() ?? ''))
        .update(c.images?.toString() ?? '')
        .digest('hex')
        .slice(0, 16)
      const queue = opts.limit ? subjects.slice(0, opts.limit) : subjects
      const concurrency = opts.concurrency ?? 8

      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
          if (opts.signal?.aborted) return
          const subject = queue[cursor++]
          progress.scanned++
          try {
            const state = await c.buildState({ db: dbCtx, subject })
            if (!state) {
              progress.skipped++
              continue
            }
            const fingerprint = createHash('sha256')
              .update(questionsHash)
              .update(JSON.stringify(state))
              .digest('hex')
              .slice(0, 32)
            if (seen.get(subject.uri) === fingerprint) {
              progress.skipped++
              continue
            }

            let answers: Record<string, Signal>
            let model: string
            if (c.classify) {
              const raw = await c.classify(state, { db: dbCtx, subject })
              answers = Object.fromEntries(
                Object.entries(raw).map(([k, v]) => [k, typeof v === 'number' ? { score: v, type: 'local' } : v]),
              )
              model = `local:${c.name}`
            } else {
              const urls = c.images ? (await c.images(state, { db: dbCtx, subject })).slice(0, MAX_IMAGES) : []
              const images = await Promise.all(urls.map((u) => embedImage(u, opts.signal)))
              const res = await askClef(state, c.questions!, { images, signal: opts.signal })
              answers = res.answers
              model = res.model
              progress.inputTokens += res.inputTokens
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
            progress.scored++

            // File on the highest-scoring signal that crosses its own threshold —
            // a second report for the same subject would only split the review.
            let crossing: { signal: string; score: number } | null = null
            for (const [name, sig] of Object.entries(answers)) {
              const t = thresholdFor(c, name)
              if (t != null && sig.score >= t && (!crossing || sig.score > crossing.score)) {
                crossing = { signal: name, score: sig.score }
              }
            }
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
                progress.filed++
              }
            }
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
    log(
      `[classifiers] scan: ${progress.scored} scored, ${progress.skipped} skipped, ` +
        `${progress.filed} filed, ${progress.errors} errors, ${progress.inputTokens} tokens`,
    )
  }

  return progress
}
