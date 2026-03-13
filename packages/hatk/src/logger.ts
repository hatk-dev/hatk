/**
 * Unstructured debug log — use sparingly for human-readable dev output.
 * Prefer {@link emit} for anything that should be queryable in production.
 * Disabled when `DEBUG=0`.
 */
export function log(...args: unknown[]): void {
  if (process.env.DEBUG === '0') return
  console.log(...args)
}

/**
 * Emit a structured wide event as a single JSON line to stdout.
 *
 * Each call produces one canonical log line with a timestamp, module, operation,
 * and arbitrary key-value fields — designed for columnar search and aggregation,
 * not string grep. Pack as much context as possible into `fields` (request IDs,
 * durations, status codes, user DIDs, counts) so a single event tells the full
 * story. See https://loggingsucks.com for the philosophy behind this approach.
 *
 * Disabled when `DEBUG=0`.
 *
 * @param module - Subsystem emitting the event (e.g. "server", "indexer", "backfill")
 * @param op - Operation name (e.g. "request", "commit", "memory")
 * @param fields - High-cardinality key-value context — include everything relevant
 */
export function emit(module: string, op: string, fields: Record<string, unknown>): void {
  if (process.env.DEBUG === '0') return
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    module,
    op,
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) entry[k] = v
  }
  process.stdout.write(JSON.stringify(entry) + '\n')
}

/**
 * Start a millisecond timer. Call the returned function to get elapsed ms.
 * Use with {@link emit} to add `duration_ms` to wide events.
 *
 * @example
 * const elapsed = timer()
 * await doWork()
 * emit('server', 'request', { path, status_code, duration_ms: elapsed() })
 */
export function timer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}
