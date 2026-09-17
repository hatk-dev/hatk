/**
 * The internal tables (_repos, _cursor, _labels, _preferences, _reports) back
 * backfill scheduling, moderation, and the admin UI. None of them go through
 * the lexicon-driven record path, so each accessor in db.ts is its own small
 * contract. These tests share one in-memory database; each describe block
 * uses its own DIDs/keys so ordering between blocks does not matter.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { setupFixtureDatabase, PUBLIC_COLLECTION, PRIVATE_COLLECTION } from './fixture.ts'
import {
  deleteLabels,
  filterTakendownDids,
  getCursor,
  getDatabaseSize,
  getLabelCount,
  getOpenReportCount,
  getPreferences,
  getRepoHandle,
  getRepoRetryInfo,
  getRepoRev,
  getRepoStatus,
  getRepoStatusCounts,
  getSchemaDump,
  insertLabels,
  insertReport,
  isTakendownDid,
  listActiveRepoDids,
  listAllRepoStatuses,
  listPendingRepos,
  listReposPaginated,
  listRetryEligibleRepos,
  putPreference,
  querySQL,
  queryLabelsByDid,
  queryLabelsForUris,
  queryReports,
  removeRepo,
  resolveReport,
  runSQL,
  searchAccounts,
  setCursor,
  setRepoStatus,
  updateRepoHandle,
} from '../src/database/db.ts'

beforeAll(async () => {
  await setupFixtureDatabase()
})

describe('cursor checkpoints', () => {
  test('a cursor that was never set reads as null', async () => {
    expect(await getCursor('firehose')).toBeNull()
  })

  test('setCursor overwrites the previous value for the same key', async () => {
    await setCursor('firehose', '100')
    await setCursor('firehose', '250')
    expect(await getCursor('firehose')).toBe('250')
  })

  test('cursors are independent per key', async () => {
    await setCursor('jetstream', '7')
    expect(await getCursor('firehose')).toBe('250')
    expect(await getCursor('jetstream')).toBe('7')
  })
})

describe('repo status lifecycle', () => {
  const did = 'did:plc:lifecycle'

  test('an unknown repo has no status, rev, handle or retry info', async () => {
    expect(await getRepoStatus(did)).toBeNull()
    expect(await getRepoRev(did)).toBeNull()
    expect(await getRepoHandle(did)).toBeNull()
    expect(await getRepoRetryInfo(did)).toBeNull()
  })

  test('setting a plain status creates the row', async () => {
    await setRepoStatus(did, 'pending')
    expect(await getRepoStatus(did)).toBe('pending')
    expect(await getRepoRetryInfo(did)).toEqual({ retryCount: 0, retryAfter: 0 })
  })

  test('marking active records rev, handle and a backfilled_at timestamp, and clears retries', async () => {
    await setRepoStatus(did, 'failed', undefined, { retryCount: 3, retryAfter: 999 })
    await setRepoStatus(did, 'active', 'rev-1', { handle: 'life.test' })
    expect(await getRepoStatus(did)).toBe('active')
    expect(await getRepoRev(did)).toBe('rev-1')
    expect(await getRepoHandle(did)).toBe('life.test')
    expect(await getRepoRetryInfo(did)).toEqual({ retryCount: 0, retryAfter: 0 })
    const [row] = (await querySQL(`SELECT backfilled_at FROM _repos WHERE did = $1`, [did])) as any[]
    expect(row.backfilled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('re-activating without a handle or rev keeps the ones already stored', async () => {
    // Firehose commits re-mark a repo active constantly; they must not wipe the
    // handle backfill resolved once.
    await setRepoStatus(did, 'active')
    expect(await getRepoHandle(did)).toBe('life.test')
    expect(await getRepoRev(did)).toBe('rev-1')
  })

  test('marking active on a brand-new DID inserts the row with the handle', async () => {
    await setRepoStatus('did:plc:fresh', 'active', 'r0', { handle: 'fresh.test' })
    expect(await getRepoStatus('did:plc:fresh')).toBe('active')
    expect(await getRepoHandle('did:plc:fresh')).toBe('fresh.test')
  })

  test('marking failed with retry info stores the backoff and preserves the handle', async () => {
    await setRepoStatus(did, 'failed', undefined, { retryCount: 2, retryAfter: 123 })
    expect(await getRepoStatus(did)).toBe('failed')
    expect(await getRepoRetryInfo(did)).toEqual({ retryCount: 2, retryAfter: 123 })
    expect(await getRepoHandle(did)).toBe('life.test')
  })

  test('marking failed on a brand-new DID inserts the row with the retry info', async () => {
    await setRepoStatus('did:plc:failfresh', 'failed', undefined, { retryCount: 1, retryAfter: 5 })
    expect(await getRepoRetryInfo('did:plc:failfresh')).toEqual({ retryCount: 1, retryAfter: 5 })
  })

  test('updateRepoHandle changes the handle without touching status', async () => {
    await updateRepoHandle(did, 'renamed.test')
    expect(await getRepoHandle(did)).toBe('renamed.test')
    expect(await getRepoStatus(did)).toBe('failed')
  })

  test('removeRepo forgets the repo entirely', async () => {
    await setRepoStatus('did:plc:gone', 'active')
    await removeRepo('did:plc:gone')
    expect(await getRepoStatus('did:plc:gone')).toBeNull()
  })
})

describe('repo queues', () => {
  beforeAll(async () => {
    const past = Math.floor(Date.now() / 1000) - 60
    const future = Math.floor(Date.now() / 1000) + 3600
    await setRepoStatus('did:plc:q-pending', 'pending')
    await setRepoStatus('did:plc:q-active', 'active', undefined, { handle: 'qactive.test' })
    await setRepoStatus('did:plc:q-retry-ready', 'failed', undefined, { retryCount: 1, retryAfter: past })
    await setRepoStatus('did:plc:q-retry-later', 'failed', undefined, { retryCount: 1, retryAfter: future })
    await setRepoStatus('did:plc:q-retry-exhausted', 'failed', undefined, { retryCount: 5, retryAfter: past })
  })

  test('listPendingRepos returns only repos waiting for backfill', async () => {
    const pending = await listPendingRepos()
    expect(pending).toContain('did:plc:q-pending')
    expect(pending).not.toContain('did:plc:q-active')
  })

  test('listActiveRepoDids returns only active repos', async () => {
    const active = await listActiveRepoDids()
    expect(active).toContain('did:plc:q-active')
    expect(active).not.toContain('did:plc:q-pending')
  })

  test('listRetryEligibleRepos excludes repos whose backoff has not elapsed or whose retries are spent', async () => {
    const eligible = await listRetryEligibleRepos(5)
    expect(eligible).toContain('did:plc:q-retry-ready')
    expect(eligible).not.toContain('did:plc:q-retry-later')
    expect(eligible).not.toContain('did:plc:q-retry-exhausted')
  })

  test('listAllRepoStatuses reports every repo with its status', async () => {
    const all = await listAllRepoStatuses()
    expect(all).toContainEqual({ did: 'did:plc:q-pending', status: 'pending' })
    expect(all).toContainEqual({ did: 'did:plc:q-active', status: 'active' })
  })

  test('getRepoStatusCounts rolls repos up by status as numbers', async () => {
    const counts = await getRepoStatusCounts()
    expect(counts.pending).toBeGreaterThanOrEqual(1)
    expect(counts.failed).toBeGreaterThanOrEqual(3)
    expect(typeof counts.active).toBe('number')
  })
})

describe('listReposPaginated', () => {
  beforeAll(async () => {
    await setRepoStatus('did:plc:page-a', 'active', undefined, { handle: 'zed.page.test' })
    await setRepoStatus('did:plc:page-b', 'active', undefined, { handle: 'amy.page.test' })
    await setRepoStatus('did:plc:page-c', 'pending')
    // Distinct, ordered backfill times so the sort is deterministic
    await runSQL(`UPDATE _repos SET backfilled_at = '2026-01-01T00:00:00Z' WHERE did = 'did:plc:page-a'`)
    await runSQL(`UPDATE _repos SET backfilled_at = '2026-02-01T00:00:00Z' WHERE did = 'did:plc:page-b'`)
  })

  test('filters by status and reports the filtered total', async () => {
    const { repos, total } = await listReposPaginated({ status: 'pending' })
    expect(total).toBe(repos.length)
    expect(repos.every((r: any) => r.status === 'pending')).toBe(true)
    expect(repos.map((r: any) => r.did)).toContain('did:plc:page-c')
  })

  test('the q filter matches a substring of either the DID or the handle', async () => {
    const byHandle = await listReposPaginated({ q: 'page.test' })
    expect(byHandle.repos.map((r: any) => r.did).sort()).toEqual(['did:plc:page-a', 'did:plc:page-b'])
    const byDid = await listReposPaginated({ q: 'plc:page-' })
    expect(byDid.total).toBe(3)
  })

  test('most recently backfilled repos come first and never-backfilled ones last', async () => {
    const { repos } = await listReposPaginated({ q: 'plc:page-' })
    expect(repos.map((r: any) => r.did)).toEqual(['did:plc:page-b', 'did:plc:page-a', 'did:plc:page-c'])
  })

  test('limit and offset page through the ordered list while total stays the full count', async () => {
    const page2 = await listReposPaginated({ q: 'plc:page-', limit: 1, offset: 1 })
    expect(page2.repos.map((r: any) => r.did)).toEqual(['did:plc:page-a'])
    expect(page2.total).toBe(3)
  })

  test('each row carries the columns the admin table renders', async () => {
    const { repos } = await listReposPaginated({ q: 'page-b' })
    expect(repos[0]).toEqual(
      expect.objectContaining({ did: 'did:plc:page-b', handle: 'amy.page.test', status: 'active' }),
    )
    expect(repos[0]).toHaveProperty('backfilled_at')
    expect(repos[0]).toHaveProperty('rev')
  })
})

describe('takedowns and account search', () => {
  beforeAll(async () => {
    await setRepoStatus('did:plc:td-yes', 'active', undefined, { handle: 'banned.test' })
    await setRepoStatus('did:plc:td-yes', 'takendown')
    await setRepoStatus('did:plc:td-no', 'active', undefined, { handle: 'fine.test' })
  })

  test('isTakendownDid is true only for takendown repos', async () => {
    expect(await isTakendownDid('did:plc:td-yes')).toBe(true)
    expect(await isTakendownDid('did:plc:td-no')).toBe(false)
    expect(await isTakendownDid('did:plc:never-seen')).toBe(false)
  })

  test('filterTakendownDids returns the subset that is taken down', async () => {
    const set = await filterTakendownDids(['did:plc:td-yes', 'did:plc:td-no', 'did:plc:never-seen'])
    expect([...set]).toEqual(['did:plc:td-yes'])
  })

  test('filterTakendownDids with no input does not hit the database', async () => {
    expect(await filterTakendownDids([])).toEqual(new Set())
  })

  test('searchAccounts matches DID or handle substrings, including takendown accounts', async () => {
    const rows = await searchAccounts('td-')
    expect(rows.map((r: any) => r.did).sort()).toEqual(['did:plc:td-no', 'did:plc:td-yes'])
    expect(rows.find((r: any) => r.did === 'did:plc:td-yes').status).toBe('takendown')
    const byHandle = await searchAccounts('fine')
    expect(byHandle.map((r: any) => r.did)).toEqual(['did:plc:td-no'])
  })

  test('searchAccounts honours the limit', async () => {
    expect(await searchAccounts('td-', 1)).toHaveLength(1)
  })
})

describe('labels', () => {
  const uri = 'at://did:plc:label/app.bsky.feed.post/1'
  const other = 'at://did:plc:label/app.bsky.feed.post/2'

  test('an inserted label is returned for its URI with a normalized shape', async () => {
    await insertLabels([{ src: 'did:plc:mod', uri, val: 'spam' }])
    const labels = await queryLabelsForUris([uri])
    expect(labels.get(uri)).toEqual([expect.objectContaining({ src: 'did:plc:mod', uri, val: 'spam', neg: false })])
    expect(labels.get(uri)![0].cts).toMatch(/^\d{4}-/)
    expect(labels.get(uri)![0]).not.toHaveProperty('exp')
  })

  test('re-applying an identical active label does not duplicate it', async () => {
    await insertLabels([{ src: 'did:plc:mod', uri, val: 'spam' }])
    expect(await getLabelCount('spam')).toBe(1)
  })

  test('a negation hides the label, and the same label can then be applied again', async () => {
    await insertLabels([{ src: 'did:plc:mod', uri, val: 'spam', neg: true }])
    expect((await queryLabelsForUris([uri])).has(uri)).toBe(false)
    await insertLabels([{ src: 'did:plc:mod', uri, val: 'spam' }])
    expect((await queryLabelsForUris([uri])).get(uri)).toHaveLength(1)
    expect(await getLabelCount('spam')).toBe(3) // original, negation, re-application
  })

  test('an expired label is not returned; a future expiry is, with exp included', async () => {
    await insertLabels([
      { src: 'did:plc:mod', uri: other, val: 'stale', exp: '2000-01-01T00:00:00.000Z' },
      { src: 'did:plc:mod', uri: other, val: 'fresh', exp: '2999-01-01T00:00:00.000Z' },
    ])
    const labels = await queryLabelsForUris([other])
    expect(labels.get(other)!.map((l) => l.val)).toEqual(['fresh'])
    expect(labels.get(other)![0].exp).toBe('2999-01-01T00:00:00.000Z')
  })

  test('queryLabelsForUris groups by URI and is empty for an empty input', async () => {
    const labels = await queryLabelsForUris([uri, other, 'at://nothing'])
    expect([...labels.keys()].sort()).toEqual([other, uri].sort())
    expect(await queryLabelsForUris([])).toEqual(new Map())
  })

  test('queryLabelsByDid finds active labels on any record under that DID', async () => {
    const rows = await queryLabelsByDid('did:plc:label')
    const vals = rows.map((r: any) => r.val).sort()
    expect(vals).toContain('spam')
    expect(vals).toContain('fresh')
    expect(vals).not.toContain('stale')
    expect(await queryLabelsByDid('did:plc:unlabelled')).toEqual([])
  })

  test('deleteLabels removes every row with that value and reports how many', async () => {
    expect(await deleteLabels('spam')).toBe(3)
    expect(await getLabelCount('spam')).toBe(0)
    expect((await queryLabelsForUris([uri])).has(uri)).toBe(false)
  })

  test('insertLabels with an empty list is a no-op', async () => {
    await expect(insertLabels([])).resolves.toBeUndefined()
  })
})

describe('preferences', () => {
  const did = 'did:plc:prefs'

  test('a user with no preferences gets an empty object', async () => {
    expect(await getPreferences(did)).toEqual({})
  })

  test('values round-trip through JSON, preserving nested structure', async () => {
    await putPreference(did, 'theme', 'dark')
    await putPreference(did, 'feeds', { pinned: ['a', 'b'], hidden: [] })
    await putPreference(did, 'count', 3)
    expect(await getPreferences(did)).toEqual({ theme: 'dark', feeds: { pinned: ['a', 'b'], hidden: [] }, count: 3 })
  })

  test('putting the same key again replaces the value', async () => {
    await putPreference(did, 'theme', 'light')
    expect((await getPreferences(did)).theme).toBe('light')
  })

  test('preferences are scoped per DID', async () => {
    expect(await getPreferences('did:plc:someone-else')).toEqual({})
  })
})

describe('reports', () => {
  let firstId: number

  beforeAll(async () => {
    await setRepoStatus('did:plc:reporter', 'active', undefined, { handle: 'reporter.test' })
  })

  test('insertReport returns the new id and the report opens', async () => {
    const { id } = await insertReport({
      subjectUri: 'at://did:plc:bad/app.bsky.feed.post/1',
      subjectDid: 'did:plc:bad',
      label: 'spam',
      reason: 'looks like spam',
      reportedBy: 'did:plc:reporter',
    })
    firstId = id
    expect(typeof id).toBe('number')
    expect(await getOpenReportCount()).toBe(1)
  })

  test('queryReports joins the reporter handle and filters by status and label', async () => {
    await insertReport({
      subjectUri: 'at://did:plc:bad/app.bsky.feed.post/2',
      subjectDid: 'did:plc:bad',
      label: 'harassment',
      reportedBy: 'did:plc:anon',
    })
    const all = await queryReports({})
    expect(all.total).toBe(2)
    const spam = await queryReports({ label: 'spam' })
    expect(spam.total).toBe(1)
    expect(spam.reports[0]).toEqual(
      expect.objectContaining({ id: firstId, reason: 'looks like spam', reported_by_handle: 'reporter.test' }),
    )
    // A reporter with no _repos row still shows up, with a null handle
    const har = await queryReports({ label: 'harassment' })
    expect(har.reports[0].reported_by_handle).toBeNull()
    expect(har.reports[0].reason).toBeNull()
  })

  test('limit and offset page the list while total stays the full count', async () => {
    const page = await queryReports({ limit: 1, offset: 1 })
    expect(page.reports).toHaveLength(1)
    expect(page.total).toBe(2)
  })

  test('resolving a report closes it and returns what to act on', async () => {
    const result = await resolveReport(firstId, 'resolved', 'did:plc:admin')
    expect(result).toEqual({ subjectUri: 'at://did:plc:bad/app.bsky.feed.post/1', label: 'spam' })
    expect(await getOpenReportCount()).toBe(1)
    const { reports } = await queryReports({ status: 'resolved' })
    expect(reports[0]).toEqual(expect.objectContaining({ id: firstId, resolved_by: 'did:plc:admin' }))
    expect(reports[0].resolved_at).toMatch(/^\d{4}-/)
  })

  test('a report can only be resolved once — the second attempt returns null', async () => {
    // Admin double-clicks must not re-apply the label action
    expect(await resolveReport(firstId, 'dismissed', 'did:plc:admin')).toBeNull()
    expect((await queryReports({ status: 'resolved' })).total).toBe(1)
  })

  test('resolving an id that does not exist returns null', async () => {
    expect(await resolveReport(999999, 'dismissed', 'did:plc:admin')).toBeNull()
  })
})

describe('introspection', () => {
  test('getDatabaseSize reports a MiB figure on SQLite, with memory fields marked N/A', async () => {
    const size = await getDatabaseSize()
    expect(size.database_size).toMatch(/^\d+\.\d MiB$/)
    expect(size.memory_usage).toBe('N/A')
    expect(size.memory_limit).toBe('N/A')
  })

  test('getSchemaDump lists every table as normalized CREATE statements', async () => {
    const dump = await getSchemaDump()
    expect(dump).toContain(`CREATE TABLE "${PUBLIC_COLLECTION}"`)
    expect(dump).toContain(`CREATE TABLE "${PRIVATE_COLLECTION}"`)
    expect(dump).toContain('CREATE TABLE _repos')
    // Each statement is terminated and columns are re-indented two spaces
    const statements = dump.split('\n\n')
    expect(statements.every((s) => s.endsWith(';'))).toBe(true)
    expect(dump).toMatch(/\n  uri TEXT PRIMARY KEY,\n/)
    expect(dump).not.toContain('sqlite_sequence')
  })
})
