import { beforeEach, expect, test, vi } from 'vitest'
import { setCursor } from '../src/database/db.ts'
import { checkpointCursor, noteSeq, resumeCursor, _resetCursorStateForTests } from '../src/indexer.ts'

vi.mock('../src/database/db.ts', { spy: true })

beforeEach(() => {
  vi.mocked(setCursor).mockReset()
  vi.mocked(setCursor).mockResolvedValue(undefined)
  _resetCursorStateForTests()
})

test('checkpointCursor persists the latest seq seen on the firehose', async () => {
  noteSeq(42)
  await checkpointCursor()
  expect(setCursor).toHaveBeenCalledWith('relay', '42')
})

test('checkpointCursor skips the write when the seq has not advanced', async () => {
  noteSeq(42)
  await checkpointCursor()
  vi.mocked(setCursor).mockClear()
  await checkpointCursor()
  expect(setCursor).not.toHaveBeenCalled()
})

test('checkpointCursor does nothing before any seq has been seen', async () => {
  await checkpointCursor()
  expect(setCursor).not.toHaveBeenCalled()
})

test('checkpointCursor retries a seq whose write failed', async () => {
  noteSeq(42)
  vi.mocked(setCursor).mockRejectedValueOnce(new Error('db busy'))
  await checkpointCursor()
  vi.mocked(setCursor).mockClear()
  await checkpointCursor()
  expect(setCursor).toHaveBeenCalledWith('relay', '42')
})

test('resumeCursor prefers the live seq over the boot-time cursor', () => {
  expect(resumeCursor(99, '5')).toBe('99')
})

test('resumeCursor falls back to the boot-time cursor before any seq is seen', () => {
  expect(resumeCursor(null, '5')).toBe('5')
  expect(resumeCursor(null, undefined)).toBeUndefined()
})
