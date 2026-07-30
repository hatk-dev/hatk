import { beforeEach, expect, test, vi } from 'vitest'
import { getRepoStatus, setRepoStatus } from '../src/database/db.ts'
import { backfillEligible, backfillRepo } from '../src/backfill.ts'

vi.mock('../src/database/db.ts', { spy: true })

beforeEach(() => {
  vi.mocked(getRepoStatus).mockReset()
  vi.mocked(setRepoStatus).mockReset()
  vi.mocked(setRepoStatus).mockResolvedValue(undefined)
})

test('the backfill scan skips takendown repos', () => {
  expect(backfillEligible('takendown')).toBe(false)
})

test('the backfill scan skips already-active repos', () => {
  expect(backfillEligible('active')).toBe(false)
})

test('the backfill scan queues new, pending, and failed repos', () => {
  expect(backfillEligible(null)).toBe(true)
  expect(backfillEligible('pending')).toBe(true)
  expect(backfillEligible('failed')).toBe(true)
})

test('backfillRepo refuses to run for a takendown DID', async () => {
  vi.mocked(getRepoStatus).mockResolvedValue('takendown')
  const count = await backfillRepo('did:plc:takendown', new Set(['a.b.c']), 5)
  expect(count).toBe(0)
  expect(setRepoStatus).not.toHaveBeenCalled()
})
