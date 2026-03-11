export function log(...args: unknown[]): void {
  if (process.env.DEBUG === '0') return
  console.log(...args)
}

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

export function timer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}
