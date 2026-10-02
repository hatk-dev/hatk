import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import sharp from 'sharp'
import { createHandler } from '../src/server.ts'
import {
  clearClassifiers,
  configureClef,
  registerClassifier,
  runScan,
  getScanProgress,
  tidTime,
  startScheduledScans,
  stopScheduledScans,
} from '../src/classifiers.ts'
import {
  getRepoStatus,
  getCursor,
  insertRecord,
  queryReports,
  runSQL,
  setRepoStatus,
  queryClassifications,
} from '../src/database/db.ts'
import { setupFixtureDatabase, PUBLIC_COLLECTION, PRIVATE_COLLECTION } from './fixture.ts'

// A classifier turns a model's probabilities into review queue entries. Nothing
// here may take an enforcement action on its own: a crossing score files a
// report, and a person decides what happens to it.

const ADMIN = 'did:plc:admin'
const SPAMMER = 'did:plc:spammer'
const REGULAR = 'did:plc:regular'
const EMPTY = 'did:plc:empty'

let viewer: { did: string } | null = { did: ADMIN }

function handler() {
  return createHandler({
    collections: [PUBLIC_COLLECTION, PRIVATE_COLLECTION],
    publicDir: null,
    oauth: null,
    admins: [ADMIN],
    resolveViewer: () => viewer,
  })
}
const get = (path: string) => handler()(new Request(`http://localhost${path}`))
const post = (path: string, body: unknown) =>
  handler()(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) }))

/** A model response in the envelope Workers AI wraps every result in. */
function clefResponse(result: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ result: { model: 'clef', ...result }, success: true, errors: [], messages: [] }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  )
}

/** Answers keyed by the handle in the state, so one mock serves every subject. */
function mockModel(byHandle: Record<string, number>) {
  return vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    const score = byHandle[body.state.handle as string] ?? 0
    return clefResponse({
      answers: { looks_like_spam: { type: 'noul', noul: score } },
      usage: { input_tokens: 100 },
    })
  })
}

beforeAll(async () => {
  await setupFixtureDatabase()
  await setRepoStatus(ADMIN, 'active', undefined, { handle: 'admin.test' })
  await setRepoStatus(SPAMMER, 'active', undefined, { handle: 'spammer.test' })
  await setRepoStatus(REGULAR, 'active', undefined, { handle: 'regular.test' })
  await setRepoStatus(EMPTY, 'active', undefined, { handle: 'empty.test' })
})

beforeEach(async () => {
  clearClassifiers()
  configureClef({ apiToken: 'test-token', model: 'clef', endpoint: 'https://model.test/v1' })
  await runSQL(`DELETE FROM _classifications`)
  await runSQL(`DELETE FROM _reports`)
  // A scan enumerates active repos only, so a test that takes an account down
  // would otherwise shrink the population every test after it sees.
  await runSQL(`UPDATE _repos SET status = 'active'`)
})

afterEach(() => {
  viewer = { did: ADMIN }
  vi.unstubAllGlobals()
})

/** A classifier over accounts that skips the DID named in `gate`. */
function spamClassifier(opts: { threshold?: number; gate?: string } = {}) {
  registerClassifier('spam', {
    subject: 'account',
    label: 'spam',
    threshold: opts.threshold ?? 0.5,
    questions: { looks_like_spam: { type: 'noul', instructions: 'Is this spam?' } },
    async buildState({ subject }) {
      if (opts.gate && subject.did === opts.gate) return null
      return { handle: subject.handle }
    },
  })
}

test('a crossing score files a report; a score below the threshold does not', async () => {
  spamClassifier()
  vi.stubGlobal('fetch', mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 }))

  const progress = await runScan({})
  expect(progress.scored).toBe(4)
  expect(progress.filed).toBe(1)

  const { reports } = await queryReports({ status: 'open' })
  expect(reports).toHaveLength(1)
  expect(reports[0].subject_did).toBe(SPAMMER)
  expect(reports[0].reported_by).toBe('system:spam')
  expect(reports[0].reason).toContain('looks_like_spam 0.90')
})

test('every subject is scored and kept, not only the ones that crossed', async () => {
  spamClassifier()
  vi.stubGlobal('fetch', mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 }))
  await runScan({})

  const { rows, total } = await queryClassifications({ state: 'all' })
  expect(total).toBe(4)
  expect(rows[0].subject_did).toBe(SPAMMER)
  expect(rows[0].top_score).toBeCloseTo(0.9)
  // The state the model saw is kept alongside the score, so a reviewer can see
  // what was actually judged.
  expect(rows[0].state).toEqual({ handle: 'spammer.test' })
})

test('a subject gated out by buildState costs nothing and is never scored', async () => {
  spamClassifier({ gate: EMPTY })
  const fetchMock = mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2 })
  vi.stubGlobal('fetch', fetchMock)

  const progress = await runScan({})
  expect(progress.skipped).toBe(1)
  expect(progress.scored).toBe(3)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  for (const call of fetchMock.mock.calls) {
    expect(JSON.parse((call[1] as any).body).state.handle).not.toBe('empty.test')
  }
})

test('a rescan skips subjects whose state has not changed', async () => {
  spamClassifier()
  const fetchMock = mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 })
  vi.stubGlobal('fetch', fetchMock)

  await runScan({})
  expect(fetchMock).toHaveBeenCalledTimes(4)

  const second = await runScan({})
  expect(second.skipped).toBe(4)
  expect(second.scored).toBe(0)
  expect(fetchMock).toHaveBeenCalledTimes(4)

  const forced = await runScan({ force: true })
  expect(forced.scored).toBe(4)
  expect(fetchMock).toHaveBeenCalledTimes(8)
})

test('a second scan does not file a duplicate report for a subject already queued', async () => {
  spamClassifier()
  vi.stubGlobal('fetch', mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 }))

  await runScan({})
  await runScan({ force: true })

  const { reports } = await queryReports({ status: 'open' })
  expect(reports).toHaveLength(1)
})

test('scanning never changes a repo status on its own', async () => {
  spamClassifier()
  vi.stubGlobal('fetch', mockModel({ 'spammer.test': 0.99, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 }))
  await runScan({})
  expect(await getRepoStatus(SPAMMER)).toBe('active')
})

test('a per-question threshold files only for the questions that carry one', async () => {
  registerClassifier('identity', {
    subject: 'account',
    label: 'impersonation',
    threshold: { passing_as: 0.7 },
    questions: {
      identity_use: { type: 'noul', instructions: 'Trades on a famous identity?' },
      passing_as: { type: 'noul', instructions: 'Pretending to be them?' },
    },
    async buildState({ subject }) {
      return { handle: subject.handle }
    },
  })

  // A declared parody: high on identity_use, low on passing_as. Only the
  // question with a threshold can file, so this is scored but not queued.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      const handle = JSON.parse(init.body).state.handle
      const parody = handle === 'spammer.test'
      return clefResponse({
        answers: {
          identity_use: { type: 'noul', noul: parody ? 0.95 : 0.02 },
          passing_as: { type: 'noul', noul: parody ? 0.1 : 0.01 },
        },
        usage: { input_tokens: 10 },
      })
    }),
  )

  const progress = await runScan({})
  expect(progress.scored).toBe(4)
  expect(progress.filed).toBe(0)

  const { rows } = await queryClassifications({ state: 'all' })
  expect(rows[0].top_signal).toBe('identity_use')
})

test('a retryable model failure is retried, and a persistent one is counted not thrown', async () => {
  spamClassifier()
  let calls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      calls++
      const handle = JSON.parse(init.body).state.handle
      if (handle === 'spammer.test' && calls < 3) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
      }
      if (handle === 'regular.test') return new Response('nope', { status: 400 })
      return clefResponse({ answers: { looks_like_spam: { type: 'noul', noul: 0.1 } }, usage: {} })
    }),
  )

  const progress = await runScan({ concurrency: 1 })
  expect(progress.errors).toBe(1) // the 400, which is not retried
  expect(progress.scored).toBe(3) // including the one that needed two retries
})

// --- endpoints ---

test('a classifier’s images reach the model embedded and scaled down', async () => {
  const photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer()
  registerClassifier('nudity', {
    subject: 'account',
    label: 'nudity',
    threshold: 0.5,
    questions: { nudity: { type: 'noul', instructions: 'Is anyone nude?' } },
    async buildState({ subject }) {
      return subject.did === SPAMMER ? { handle: subject.handle } : null
    },
    images: (state) => [`https://img.test/${state.handle}.jpg`],
  })

  let sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      if (url.startsWith('https://img.test/')) {
        return new Response(photo, { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      sent = JSON.parse(init.body).images
      return clefResponse({ answers: { nudity: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 900 } })
    }),
  )

  const progress = await runScan({})
  expect(progress.scored).toBe(1)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatch(/^data:image\/jpeg;base64,/)
  const meta = await sharp(Buffer.from(sent[0].split(',')[1], 'base64')).metadata()
  expect(Math.max(meta.width!, meta.height!)).toBe(512)
})

test('a model error reported inside a successful response is counted, not stored', async () => {
  spamClassifier()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ result: {}, success: false, errors: [{ code: 5021, message: 'too long' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )

  const progress = await runScan({ concurrency: 1 })
  expect(progress.errors).toBe(4)
  expect(progress.scored).toBe(0)
})

test('a record scan covers public records from active repos only', async () => {
  const rec = (did: string, key: string) =>
    insertRecord(PUBLIC_COLLECTION, `at://${did}/${PUBLIC_COLLECTION}/${key}`, `cid-${key}`, did, {
      $type: PUBLIC_COLLECTION,
      text: key,
    })
  await rec(REGULAR, 'kept')
  await rec(SPAMMER, 'takendown')
  await rec(REGULAR, 'inspace')
  await runSQL(`UPDATE "${PUBLIC_COLLECTION}" SET space = 'ats://did:plc:owner/space/1' WHERE uri LIKE '%/inspace'`)
  await setRepoStatus(SPAMMER, 'takendown')

  registerClassifier('records', {
    subject: 'record',
    collections: [PUBLIC_COLLECTION],
    threshold: 0.5,
    questions: { looks_like_spam: { type: 'noul', instructions: 'Is this spam?' } },
    async buildState({ subject }) {
      return { text: subject.value?.text }
    },
  })
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      asked.push(JSON.parse(init.body).state.text)
      return clefResponse({ answers: { looks_like_spam: { type: 'noul', noul: 0.9 } }, usage: {} })
    }),
  )

  await runScan({})
  expect(asked).toEqual(['kept'])
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
})

/** A TID record key minted at `at`, as a client creating a record would. */
function tidAt(at: Date): string {
  const chars = '234567abcdefghijklmnopqrstuvwxyz'
  let n = BigInt(at.getTime()) * 1000n * 1024n
  let out = ''
  for (let i = 0; i < 13; i++) {
    out = chars[Number(n % 32n)] + out
    n /= 32n
  }
  return out
}

test('a TID record key reads back as the moment it was minted', () => {
  const at = new Date('2026-10-02T21:39:32.000Z')
  expect(tidTime(tidAt(at))?.toISOString()).toBe(at.toISOString())
  expect(tidTime('self')).toBeNull()
  expect(tidTime('3mwnsasw3witw')?.getUTCFullYear()).toBe(2026)
})

test('a scan since a moment covers records written after it, not ones merely re-indexed', async () => {
  const since = new Date('2026-10-01T00:00:00Z')
  const rec = (did: string, rkey: string) =>
    insertRecord(PUBLIC_COLLECTION, `at://${did}/${PUBLIC_COLLECTION}/${rkey}`, `cid-${rkey}`, did, {
      $type: PUBLIC_COLLECTION,
      text: rkey,
    })
  // All three are indexed now. Only the key says which were written before.
  const fresh = tidAt(new Date('2026-10-02T12:00:00Z'))
  const reindexed = tidAt(new Date('2025-01-01T00:00:00Z'))
  await rec(REGULAR, fresh)
  await rec(REGULAR, reindexed)
  await rec(ADMIN, 'self')

  registerClassifier('records', {
    subject: 'record',
    collections: [PUBLIC_COLLECTION],
    questions: { looks_like_spam: { type: 'noul', instructions: 'Is this spam?' } },
    async buildState({ subject }) {
      return { text: subject.value?.text }
    },
  })
  registerClassifier('accounts', {
    subject: 'account',
    questions: { looks_like_spam: { type: 'noul', instructions: 'Is this spam?' } },
    async buildState({ subject }) {
      return { handle: subject.handle }
    },
  })
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      const state = JSON.parse(init.body).state
      asked.push(state.text ?? state.handle)
      return clefResponse({ answers: { looks_like_spam: { type: 'noul', noul: 0.1 } }, usage: {} })
    }),
  )

  await runScan({ since: since.toISOString() })
  // The re-indexed record is left out, and so is SPAMMER, who wrote nothing.
  expect(asked.sort()).toEqual([fresh, 'admin.test', 'regular.test', 'self'].sort())
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
})

test('scheduled scans start from when they were first switched on, across restarts', async () => {
  await runSQL(`DELETE FROM _cursor WHERE key = 'classifiers:since'`)
  await startScheduledScans(3600)
  const first = await getCursor('classifiers:since')
  expect(first).toBeTruthy()
  stopScheduledScans()

  await new Promise((r) => setTimeout(r, 5))
  await startScheduledScans(3600)
  expect(await getCursor('classifiers:since')).toBe(first)
  stopScheduledScans()
})

test('review endpoints are gated like the rest of /admin', async () => {
  viewer = null
  expect((await get('/admin/review')).status).toBe(401)
  expect((await post('/admin/review/scan', {})).status).toBe(401)

  viewer = { did: 'did:plc:nobody' }
  expect((await get('/admin/review')).status).toBe(403)
  expect((await post('/admin/review/act', { did: SPAMMER, action: 'takedown' })).status).toBe(403)
  expect(await getRepoStatus(SPAMMER)).toBe('active')
})

test('acting on a queued subject takes it down and closes its report together', async () => {
  spamClassifier()
  vi.stubGlobal('fetch', mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 }))
  await runScan({})

  const res = await post('/admin/review/act', { did: SPAMMER, uri: SPAMMER, action: 'takedown' })
  expect(res.status).toBe(200)
  expect(await getRepoStatus(SPAMMER)).toBe('takendown')
  expect((await queryReports({ status: 'open' })).reports).toHaveLength(0)
  expect((await queryReports({ status: 'resolved' })).reports).toHaveLength(1)
})

test('dismissing closes the report without touching the account', async () => {
  spamClassifier()
  vi.stubGlobal('fetch', mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 }))
  await runScan({})

  await post('/admin/review/act', { did: SPAMMER, uri: SPAMMER, action: 'dismiss' })
  expect(await getRepoStatus(SPAMMER)).toBe('active')
  expect((await queryReports({ status: 'dismissed' })).reports).toHaveLength(1)
})

test('the queue reports what has been scored and what is still pending', async () => {
  spamClassifier()
  vi.stubGlobal('fetch', mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 }))
  await runScan({})

  const stats = await (await get('/admin/review/stats')).json()
  expect(stats.total).toBe(4)
  expect(stats.pending).toBe(1)
  expect(stats.classifiers).toEqual(['spam'])
  expect(stats.configured).toBe(true)

  const queue = await (await get('/admin/review?state=pending&minScore=0.5')).json()
  expect(queue.rows).toHaveLength(1)
  expect(queue.rows[0].handle).toBe('spammer.test')
})

test('a scan cannot start when the model is not configured', async () => {
  spamClassifier()
  configureClef(null)
  const res = await post('/admin/review/scan', {})
  expect(res.status).toBe(400)
  expect((await res.json()).error).toContain('not configured')
  expect(getScanProgress()?.running).not.toBe(true)
})

test('a subject flagged again after being dismissed comes back to the queue', async () => {
  spamClassifier()
  vi.stubGlobal('fetch', mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 }))
  await runScan({})

  await post('/admin/review/act', { did: SPAMMER, uri: SPAMMER, action: 'dismiss' })
  let queue = await (await get('/admin/review?state=pending&minScore=0.5')).json()
  expect(queue.rows).toHaveLength(0)

  // A later scan finds it again — the old dismissal must not keep it hidden.
  await runScan({ force: true })
  queue = await (await get('/admin/review?state=pending&minScore=0.5')).json()
  expect(queue.rows).toHaveLength(1)
  expect(queue.rows[0].handle).toBe('spammer.test')
})

test('editing a classifier invalidates its earlier scores', async () => {
  const fetchMock = mockModel({ 'spammer.test': 0.9, 'regular.test': 0.1, 'admin.test': 0.2, 'empty.test': 0.1 })
  vi.stubGlobal('fetch', fetchMock)

  spamClassifier()
  await runScan({})
  expect(fetchMock).toHaveBeenCalledTimes(4)

  // Same subjects, same state, reworded question: the old answers no longer
  // describe what is being asked, so every subject must be scored again.
  clearClassifiers()
  registerClassifier('spam', {
    subject: 'account',
    label: 'spam',
    threshold: 0.5,
    questions: { looks_like_spam: { type: 'noul', instructions: 'Is this spam? Be stricter about links.' } },
    async buildState({ subject }) {
      return { handle: subject.handle }
    },
  })

  const second = await runScan({})
  expect(second.scored).toBe(4)
  expect(second.skipped).toBe(0)
})

test('a classifier with its own model runs without Clef configured', async () => {
  configureClef(null)
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  registerClassifier('local', {
    subject: 'account',
    label: 'spam',
    threshold: 0.5,
    async buildState({ subject }) {
      return { handle: subject.handle }
    },
    // A host-local model: no network, no key, no questions.
    async classify(state) {
      return { looks_bad: state.handle === 'spammer.test' ? 0.91 : 0.02 }
    },
  })

  const progress = await runScan({})
  expect(progress.scored).toBe(4)
  expect(progress.filed).toBe(1)
  expect(progress.inputTokens).toBe(0)
  expect(fetchMock).not.toHaveBeenCalled()

  const { reports } = await queryReports({ status: 'open' })
  expect(reports[0].subject_did).toBe(SPAMMER)
  expect(reports[0].reason).toContain('looks_bad 0.91')

  const { rows } = await queryClassifications({ state: 'all' })
  // The queue tags each merged signal with the classifier that produced it.
  expect(rows[0].signals.looks_bad).toEqual({ score: 0.91, type: 'local', classifier: 'local' })
})

test('a scan mixing a local and a model-backed classifier still needs a key', async () => {
  configureClef(null)
  spamClassifier()
  registerClassifier('local', {
    subject: 'account',
    async buildState() {
      return {}
    },
    async classify() {
      return { x: 0 }
    },
  })
  await expect(runScan({})).rejects.toThrow('not configured')
})
