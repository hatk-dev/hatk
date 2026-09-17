/**
 * src/cli.ts is a script, not a module: it reads process.argv at import time and
 * dispatches on it with top-level await, and it exports nothing. So the only way
 * to test it is to re-execute it — set argv, reset the module registry, import it
 * again, and capture what it wrote to the console and where it tried to exit.
 *
 * Every test file using this must mock `node:child_process` itself (vi.mock is
 * per-file), because most commands end in execSync or spawn.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

/** Thrown in place of process.exit so a command's exit path is observable. */
export class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

export interface CliRun {
  /** Lines passed to console.log, one entry per call, args joined by a space. */
  out: string[]
  /** Lines passed to console.error. */
  err: string[]
  /** The first code passed to process.exit, or null if the command ran to completion. */
  exit: number | null
  /** Every code passed to process.exit, in order. */
  exits: number[]
  /** A non-exit error that escaped the command (e.g. a rejected spawn). */
  thrown: Error | null
}

export interface RunCliOptions {
  /**
   * By default process.exit throws, which is what stops a command mid-flight the
   * way a real exit would. Set false for the handful of paths that call exit from
   * a detached callback (a child-process 'close' listener), where throwing would
   * escape as an uncaught exception instead of unwinding the command.
   */
  throwOnExit?: boolean
}

/** Run `hatk <argv>` in-process against the current working directory. */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<CliRun> {
  const out: string[] = []
  const err: string[] = []
  const originalArgv = process.argv
  process.argv = ['node', '/fake/dist/cli.js', ...argv]

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')))
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const exits: number[] = []
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0)
    if (options.throwOnExit !== false) throw new ExitError(code ?? 0)
    return undefined
  }) as never)

  const run: CliRun = { out, err, exit: null, exits, thrown: null }
  try {
    vi.resetModules()
    await import('../src/cli.ts')
  } catch (e) {
    if (!(e instanceof ExitError)) run.thrown = e as Error
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
    warnSpy.mockRestore()
    exitSpy.mockRestore()
    process.argv = originalArgv
    run.exit = exits.length > 0 ? exits[0] : null
  }
  return run
}

/** All console output from a run, for loose "did it mention X" assertions. */
export function allOutput(run: CliRun): string {
  return [...run.out, ...run.err].join('\n')
}

/** Create a scratch project directory and chdir into it. Returns a cleanup fn. */
export function useTempProject(): { dir: string; cleanup: () => void } {
  const previous = process.cwd()
  // realpath: on macOS mkdtemp hands back /var/... while cwd reports /private/var/...
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hatk-cli-')))
  process.chdir(dir)
  return {
    dir,
    cleanup: () => {
      process.chdir(previous)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
