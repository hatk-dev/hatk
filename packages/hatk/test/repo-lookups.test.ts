import { beforeAll, expect, test } from 'vitest'
import { querySQL } from '../src/database/index.ts'
import { resolveHandleToDid, setRepoStatus, updateRepoHandle } from '../src/database/db.ts'
import { setupFixtureDatabase } from './fixture.ts'

/**
 * `resolveHandleToDid` runs on every feed request carrying an `actor` handle, and
 * `_repos` grows with the network. A plain functional test passes whether or not
 * the lookup is indexed, so these assert the access path too — a full SCAN here
 * is the regression worth catching.
 */

async function queryPlan(sql: string): Promise<string> {
  const rows = (await querySQL(`EXPLAIN QUERY PLAN ${sql}`)) as Array<{ detail: string }>
  return rows.map((r) => r.detail).join(' | ')
}

beforeAll(async () => {
  await setupFixtureDatabase()
  await setRepoStatus('did:plc:alice', 'active', undefined, { handle: 'alice.example.com' })
  await setRepoStatus('did:plc:bob', 'active', undefined, { handle: 'bob.example.com' })
  // A repo still awaiting backfill has no handle yet — these rows sit in the index as NULLs
  await setRepoStatus('did:plc:carol', 'pending')
})

test('resolveHandleToDid finds the DID behind a handle', async () => {
  expect(await resolveHandleToDid('alice.example.com')).toBe('did:plc:alice')
  expect(await resolveHandleToDid('bob.example.com')).toBe('did:plc:bob')
})

test('resolveHandleToDid returns null for an unknown handle', async () => {
  expect(await resolveHandleToDid('nobody.example.com')).toBeNull()
})

test('resolveHandleToDid passes a DID straight through', async () => {
  expect(await resolveHandleToDid('did:plc:alice')).toBe('did:plc:alice')
})

test('handle lookups use an index rather than scanning _repos', async () => {
  const plan = await queryPlan(`SELECT did FROM _repos WHERE handle = 'alice.example.com' LIMIT 1`)
  expect(plan).toContain('idx_repos_handle')
  expect(plan).not.toContain('SCAN _repos')
})

test('repo status rollups use an index rather than scanning _repos', async () => {
  const plan = await queryPlan(`SELECT status, COUNT(*) FROM _repos GROUP BY status`)
  expect(plan).toContain('idx_repos_status')
})

test('a handle can move between repos without tripping a uniqueness constraint', async () => {
  // Handle changes are not atomic across repos: bob can claim alice's old handle
  // before alice's row is updated, so the index must tolerate duplicates.
  await updateRepoHandle('did:plc:bob', 'alice.example.com')
  const rows = (await querySQL(`SELECT did FROM _repos WHERE handle = 'alice.example.com'`)) as Array<{ did: string }>
  expect(rows.map((r) => r.did).sort()).toEqual(['did:plc:alice', 'did:plc:bob'])

  await updateRepoHandle('did:plc:bob', 'bob.example.com')
})
