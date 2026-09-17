/**
 * The wide-event stream is the only thing hatk puts on stdout, and a log line
 * reader parses every line as JSON — so what `emit` writes, and what `DEBUG=0`
 * suppresses, is a contract rather than a convenience.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { emit, log, timer } from '../src/logger.ts'

const originalDebug = process.env.DEBUG

afterEach(() => {
  if (originalDebug === undefined) delete process.env.DEBUG
  else process.env.DEBUG = originalDebug
  vi.restoreAllMocks()
})

/** Capture what the logger writes without letting it reach the reporter's stdout. */
function captureStdout(): string[] {
  const lines: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    lines.push(String(chunk))
    return true
  })
  return lines
}

test('emit writes exactly one JSON line carrying module, op and a timestamp', () => {
  delete process.env.DEBUG
  const lines = captureStdout()

  emit('indexer', 'flush', { batch_size: 3 })

  expect(lines).toHaveLength(1)
  expect(lines[0].endsWith('\n')).toBe(true)
  // One line, one object: a reader splits on newlines and parses each.
  expect(lines[0].trimEnd()).not.toContain('\n')
  const entry = JSON.parse(lines[0])
  expect(entry.module).toBe('indexer')
  expect(entry.op).toBe('flush')
  expect(entry.batch_size).toBe(3)
  expect(Date.parse(entry.ts)).not.toBeNaN()
})

test('emit drops undefined fields so an event has no empty columns', () => {
  delete process.env.DEBUG
  const lines = captureStdout()

  // Callers pass optional context unconditionally (`error`, `cursor_error`);
  // carrying the undefined ones through would add null columns to every row.
  emit('indexer', 'flush', { error: undefined, cursor_error: undefined, kept: null })

  const entry = JSON.parse(lines[0])
  expect('error' in entry).toBe(false)
  expect('cursor_error' in entry).toBe(false)
  // null is a value a caller meant to send, unlike undefined.
  expect('kept' in entry).toBe(true)
  expect(entry.kept).toBeNull()
})

test('emit writes nothing when DEBUG=0', () => {
  process.env.DEBUG = '0'
  const lines = captureStdout()
  emit('indexer', 'flush', { batch_size: 3 })
  expect(lines).toEqual([])
})

test('log writes nothing when DEBUG=0', () => {
  process.env.DEBUG = '0'
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  log('[indexer] Connecting...')
  expect(spy).not.toHaveBeenCalled()
})

test('log passes its arguments through when debug output is on', () => {
  delete process.env.DEBUG
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  log('[indexer]', 'Connected', 7)
  expect(spy).toHaveBeenCalledWith('[indexer]', 'Connected', 7)
})

test('a quieter DEBUG value than 0 still logs', () => {
  // Only the exact string '0' silences output — '' or 'false' must not, or a
  // half-set env var would silently take production's telemetry away.
  process.env.DEBUG = 'false'
  const lines = captureStdout()
  emit('indexer', 'flush', {})
  expect(lines).toHaveLength(1)
})

test('timer reports whole elapsed milliseconds', async () => {
  const elapsed = timer()
  await new Promise((r) => setTimeout(r, 12))
  const ms = elapsed()
  expect(Number.isInteger(ms)).toBe(true)
  expect(ms).toBeGreaterThanOrEqual(10)
})
