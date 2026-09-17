/**
 * The run/build/check half of the CLI. Every one of these commands ends in a
 * child process, so `node:child_process` is mocked wholesale — the behavior
 * under test is *which* command line the CLI builds, which files it decides to
 * delete, and what exit code it propagates. Nothing here spawns or serves.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allOutput, runCli, useTempProject } from './cli-harness.ts'

const { execSyncMock, spawnMock, resolveLexiconMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  resolveLexiconMock: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execSync: execSyncMock, spawn: spawnMock }))
vi.mock('../src/lexicon-resolve.ts', () => ({ resolveLexicon: resolveLexiconMock }))

let project: ReturnType<typeof useTempProject>
let originalDebug: string | undefined

/** A stand-in for a spawned child that closes on the next tick. */
function fakeChild(opts: { code?: number | null; signal?: string | null } = {}) {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
  child.kill = vi.fn()
  setImmediate(() => child.emit('close', opts.code ?? 0, opts.signal ?? null))
  return child
}

beforeEach(() => {
  project = useTempProject()
  originalDebug = process.env.DEBUG
  execSyncMock.mockReset()
  spawnMock.mockReset().mockImplementation(() => fakeChild())
  resolveLexiconMock.mockReset()
})

afterEach(() => {
  project.cleanup()
  // `hatk test` sets DEBUG=0 on the real process env; don't let that leak.
  if (originalDebug === undefined) delete process.env.DEBUG
  else process.env.DEBUG = originalDebug
  vi.unstubAllGlobals()
})

/** The command strings passed to execSync, in order. */
function execCalls(): string[] {
  return execSyncMock.mock.calls.map((c) => c[0] as string)
}

function writeConfig(body: string): void {
  writeFileSync('hatk.config.ts', body)
}

// --- dev / start ---------------------------------------------------------

describe('dev', () => {
  test('runs the hatk server directly when there is no Vite project', async () => {
    const run = await runCli(['dev'])

    expect(run.exit).toBeNull()
    const [cmd, args, opts] = spawnMock.mock.calls[0]
    expect(cmd).toBe('npx')
    expect(args[0]).toBe('tsx')
    expect(args[1]).toMatch(/main\.js$/)
    expect(args[2]).toBe('hatk.config.ts')
    // DEV_MODE keeps main.ts from restarting the process after backfill.
    expect(opts.env.DEV_MODE).toBe('1')
  })

  test('defers to `vite dev` when a vite.config.ts exists', async () => {
    // In a Vite project the plugin boots hatk; running both would double-bind the port.
    writeFileSync('vite.config.ts', 'export default {}')
    await runCli(['dev'])

    expect(spawnMock.mock.calls[0][0]).toBe('npx')
    expect(spawnMock.mock.calls[0][1]).toEqual(['vite', 'dev'])
  })

  test('also recognizes a vite.config.js project', async () => {
    writeFileSync('vite.config.js', 'export default {}')
    await runCli(['dev'])
    expect(spawnMock.mock.calls[0][1]).toEqual(['vite', 'dev'])
  })

  test('runs the seed script before starting', async () => {
    writeFileSync('vite.config.ts', 'export default {}')
    mkdirSync('seeds', { recursive: true })
    writeFileSync('seeds/seed.ts', '// seed')
    await runCli(['dev'])

    expect(execCalls()[0]).toMatch(/^npx tsx .*seeds\/seed\.ts$/)
  })
})

describe('start', () => {
  test('runs main.js under tsx without DEV_MODE', async () => {
    const run = await runCli(['start'])

    expect(run.exit).toBeNull()
    const [cmd, args, opts] = spawnMock.mock.calls[0]
    expect(cmd).toBe('npx')
    expect(args[1]).toMatch(/main\.js$/)
    // Production must restart after backfill to reclaim memory, so DEV_MODE stays unset.
    expect(opts.env.DEV_MODE).toBeUndefined()
  })

  test('surfaces a non-zero exit from the child', async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 1 }))
    const run = await runCli(['start'])
    expect(run.thrown?.message).toBe('Process exited with code 1')
  })

  test('exits cleanly when the child is interrupted', async () => {
    // Ctrl-C is a normal way to stop `hatk start`; it must not look like a crash.
    // The exit happens inside the child's 'close' listener, so it is recorded
    // rather than thrown (see RunCliOptions.throwOnExit).
    spawnMock.mockImplementation(() => fakeChild({ code: null, signal: 'SIGINT' }))
    const run = await runCli(['start'], { throwOnExit: false })
    expect(run.exits).toEqual([0])
    expect(run.thrown).toBeNull()
  })

  test('exits cleanly when the child is terminated', async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: null, signal: 'SIGTERM' }))
    const run = await runCli(['start'], { throwOnExit: false })
    expect(run.exits).toEqual([0])
  })

  test('forwards SIGINT to the child and unhooks its listeners afterwards', async () => {
    // A leaked listener per spawn would eventually trip Node's max-listeners warning.
    const child = fakeChild()
    spawnMock.mockImplementation(() => child)
    const registered: Array<(sig: string) => void> = []
    const onSpy = vi.spyOn(process, 'on').mockImplementation(function (this: any, event: string, fn: any) {
      if (event === 'SIGINT') registered.push(fn)
      return this
    } as never)
    const before = process.listenerCount('SIGINT')

    await runCli(['start'])
    onSpy.mockRestore()

    registered[0]('SIGINT')
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})

// --- PDS bootstrap -------------------------------------------------------

describe('seed', () => {
  test('does nothing when the project has neither a PDS nor a seed script', async () => {
    const run = await runCli(['seed'])
    expect(run.exit).toBeNull()
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  test('runs seeds/seed.ts through tsx', async () => {
    mkdirSync('seeds', { recursive: true })
    writeFileSync('seeds/seed.ts', '// seed')
    await runCli(['seed'])

    expect(execCalls()[0]).toMatch(/^npx tsx .*seeds\/seed\.ts$/)
  })

  test('skips docker when the local PDS already answers its health check', async () => {
    writeFileSync('docker-compose.yml', 'services: {}')
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const run = await runCli(['seed'])

    expect(run.exit).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:2583/xrpc/_health')
    expect(execCalls()).not.toContain('docker compose up -d')
  })

  test('brings the PDS up and waits for health when it is not running', async () => {
    writeFileSync('docker-compose.yml', 'services: {}')
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        if (call === 1) throw new Error('ECONNREFUSED')
        return new Response('ok', { status: 200 })
      }),
    )

    const run = await runCli(['seed'])

    expect(run.exit).toBeNull()
    expect(execCalls()).toContain('docker compose up -d')
    expect(allOutput(run)).toContain('[dev] PDS ready')
  })
})

// --- format / build ------------------------------------------------------

describe('format', () => {
  test('runs oxfmt over the project', async () => {
    const run = await runCli(['format'])
    expect(run.exit).toBeNull()
    expect(execCalls()).toEqual(['npx oxfmt .'])
  })

  test('accepts the `fmt` alias', async () => {
    await runCli(['fmt'])
    expect(execCalls()).toEqual(['npx oxfmt .'])
  })

  test('suggests installing oxfmt instead of failing when it is missing', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('command not found: oxfmt')
    })
    const run = await runCli(['format'])

    expect(run.exit).toBeNull()
    expect(allOutput(run)).toContain('npm install -D oxfmt')
  })
})

describe('build', () => {
  test('says there is nothing to build for an API-only project', async () => {
    const run = await runCli(['build'])
    expect(run.exit).toBeNull()
    expect(execSyncMock).not.toHaveBeenCalled()
    expect(allOutput(run)).toContain('No frontend to build (API-only hatk)')
  })

  test('runs `vite build` for a SvelteKit project', async () => {
    writeFileSync('svelte.config.js', 'export default {}')
    mkdirSync('src', { recursive: true })
    writeFileSync('src/app.html', '<html></html>')
    await runCli(['build'])

    expect(execCalls()).toEqual(['npx vite build'])
  })

  test('does not build on svelte.config.js alone', async () => {
    // A svelte.config.js with no src/app.html is not a SvelteKit app.
    writeFileSync('svelte.config.js', 'export default {}')
    const run = await runCli(['build'])
    expect(allOutput(run)).toContain('No frontend to build')
  })
})

// --- reset ---------------------------------------------------------------

describe('reset', () => {
  test('deletes the database and every sidecar journal file', async () => {
    // Leaving a -wal behind resurrects committed rows the reset was meant to drop.
    writeConfig(`export default { database: './db/app.db' }\n`)
    mkdirSync('db', { recursive: true })
    for (const suffix of ['', '.wal', '-shm', '-wal']) writeFileSync(`db/app.db${suffix}`, 'x')

    const run = await runCli(['reset'])

    expect(run.exit).toBeNull()
    for (const suffix of ['', '.wal', '-shm', '-wal']) {
      expect(existsSync(join('db', `app.db${suffix}`))).toBe(false)
    }
    expect(allOutput(run)).toContain('[reset] done')
  })

  test('tolerates a database that was never created', async () => {
    writeConfig(`export default { database: './db/app.db' }\n`)
    const run = await runCli(['reset'])
    expect(run.exit).toBeNull()
    expect(allOutput(run)).not.toContain('deleted')
  })

  test('has nothing to delete for an in-memory database', async () => {
    writeConfig(`export default {}\n`)
    const run = await runCli(['reset'])
    expect(run.exit).toBeNull()
    expect(allOutput(run)).toContain('[reset] done')
  })

  test('tears the PDS volumes down when the project ships a compose file', async () => {
    writeConfig(`export default {}\n`)
    writeFileSync('docker-compose.yml', 'services: {}')
    const run = await runCli(['reset'])

    expect(execCalls()).toEqual(['docker compose down -v'])
    expect(allOutput(run)).toContain('[reset] resetting PDS...')
  })

  test('fails with guidance when there is no config file', async () => {
    const run = await runCli(['reset'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Config file not found')
  })
})

// --- check ---------------------------------------------------------------

describe('check', () => {
  test('lints and passes for a bare project', async () => {
    const run = await runCli(['check'])
    expect(run.exit).toBeNull()
    expect(execCalls()).toEqual(['npx oxlint .'])
  })

  test('fails the whole run when the linter fails', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('lint errors')
    })
    const run = await runCli(['check'])
    expect(run.exit).toBe(1)
  })

  test('validates lexicons and reports each error against its NSID', async () => {
    mkdirSync('lexicons/com/example', { recursive: true })
    writeFileSync(
      'lexicons/com/example/broken.json',
      JSON.stringify({ lexicon: 1, id: 'com.example.broken', defs: { main: { type: 'notAThing' } } }),
    )
    const run = await runCli(['check'])

    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('[check] lexicons...')
    expect(allOutput(run)).toContain('com.example.broken')
  })

  test('passes a valid lexicon through', async () => {
    mkdirSync('lexicons/com/example', { recursive: true })
    writeFileSync(
      'lexicons/com/example/widget.json',
      JSON.stringify({
        lexicon: 1,
        id: 'com.example.widget',
        defs: {
          main: {
            type: 'record',
            key: 'tid',
            record: {
              type: 'object',
              required: ['createdAt'],
              properties: { createdAt: { type: 'string', format: 'datetime' } },
            },
          },
        },
      }),
    )
    const run = await runCli(['check'])

    expect(run.exit).toBeNull()
    expect(execCalls()).toEqual(['npx oxlint .'])
  })

  test('type-checks server code when tsconfig.server.json is present', async () => {
    writeFileSync('tsconfig.server.json', '{}')
    await runCli(['check'])
    expect(execCalls()).toEqual(['npx tsc --noEmit -p tsconfig.server.json', 'npx oxlint .'])
  })

  test('fails when server type-checking fails but still runs the linter', async () => {
    // Reporting only the first failure would hide lint errors for a whole cycle.
    writeFileSync('tsconfig.server.json', '{}')
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('tsc failed')
    })
    const run = await runCli(['check'])

    expect(run.exit).toBe(1)
    expect(execCalls()).toHaveLength(2)
  })

  test('runs svelte-check for a SvelteKit project', async () => {
    writeFileSync('svelte.config.js', 'export default {}')
    mkdirSync('src', { recursive: true })
    writeFileSync('src/app.html', '<html></html>')
    await runCli(['check'])

    expect(execCalls()[0]).toContain('svelte-kit sync')
    expect(execCalls()[0]).toContain('svelte-check')
  })

  test('fails when svelte-check fails but still lints', async () => {
    writeFileSync('svelte.config.js', 'export default {}')
    mkdirSync('src', { recursive: true })
    writeFileSync('src/app.html', '<html></html>')
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('svelte-check found errors')
    })
    const run = await runCli(['check'])

    expect(run.exit).toBe(1)
    expect(execCalls()).toHaveLength(2)
  })
})

// --- test ----------------------------------------------------------------

describe('test', () => {
  beforeEach(() => {
    writeFileSync('vite.config.ts', 'export default {}')
  })

  test('refuses to run without a vite.config.ts to configure the projects', async () => {
    const { rmSync } = await import('node:fs')
    rmSync('vite.config.ts')
    const run = await runCli(['test'])

    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('No vite.config.ts found')
  })

  test('runs only the unit project for --unit', async () => {
    const run = await runCli(['test', '--unit'])
    expect(run.exit).toBeNull()
    expect(execCalls()).toEqual(['npx vitest run --project unit '])
  })

  test('runs every suite that exists when no flag is given', async () => {
    mkdirSync('test/integration', { recursive: true })
    writeFileSync('test/integration/pds.test.ts', '')
    mkdirSync('test/browser', { recursive: true })
    writeFileSync('test/browser/home.spec.ts', '')

    await runCli(['test'])

    expect(execCalls()).toEqual([
      'npx vitest run --project unit ',
      'npx vitest run --project integration ',
      'npx playwright test ',
    ])
  })

  test('skips integration and browser suites that have no test files', async () => {
    // An empty test/integration directory should not fail the run on a missing project.
    mkdirSync('test/integration', { recursive: true })
    mkdirSync('test/browser', { recursive: true })
    writeFileSync('test/integration/README.md', 'todo')

    await runCli(['test'])

    expect(execCalls()).toEqual(['npx vitest run --project unit '])
  })

  test('runs only playwright for --browser', async () => {
    mkdirSync('test/browser', { recursive: true })
    writeFileSync('test/browser/home.test.ts', '')
    await runCli(['test', '--browser'])

    expect(execCalls()).toEqual(['npx playwright test '])
  })

  test('runs only the integration project for --integration', async () => {
    mkdirSync('test/integration', { recursive: true })
    writeFileSync('test/integration/pds.test.ts', '')
    await runCli(['test', '--integration'])

    expect(execCalls()).toEqual(['npx vitest run --project integration '])
  })

  test('passes unrecognized arguments through to the runner', async () => {
    // `hatk test --unit -t oauth` has to reach vitest's own filter.
    await runCli(['test', '--unit', '-t', 'oauth'])
    expect(execCalls()).toEqual(['npx vitest run --project unit -t oauth'])
  })

  test('silences debug logging unless --verbose is passed', async () => {
    await runCli(['test', '--unit'])
    expect(process.env.DEBUG).toBe('0')
  })

  test('leaves debug logging on for --verbose', async () => {
    delete process.env.DEBUG
    await runCli(['test', '--unit', '--verbose'])
    expect(process.env.DEBUG).toBeUndefined()
    // --verbose is consumed by the CLI, not forwarded to vitest.
    expect(execCalls()).toEqual(['npx vitest run --project unit '])
  })

  test('treats an interrupted run as a clean exit', async () => {
    // 130 is SIGINT; Ctrl-C out of watch mode is not a test failure.
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('interrupted'), { status: 130 })
    })
    const run = await runCli(['test', '--unit'])
    expect(run.exit).toBe(0)
  })

  test('treats an interrupted integration run as a clean exit', async () => {
    mkdirSync('test/integration', { recursive: true })
    writeFileSync('test/integration/pds.test.ts', '')
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('interrupted'), { status: 130 })
    })
    const run = await runCli(['test', '--integration'])
    expect(run.exit).toBe(0)
  })

  test('propagates an integration failure', async () => {
    mkdirSync('test/integration', { recursive: true })
    writeFileSync('test/integration/pds.test.ts', '')
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('failed'), { status: 3 })
    })
    const run = await runCli(['test', '--integration'])
    expect(run.exit).toBe(3)
  })

  test('treats an interrupted browser run as a clean exit', async () => {
    mkdirSync('test/browser', { recursive: true })
    writeFileSync('test/browser/home.spec.ts', '')
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('interrupted'), { status: 130 })
    })
    const run = await runCli(['test', '--browser'])
    expect(run.exit).toBe(0)
  })

  test('propagates a browser failure', async () => {
    mkdirSync('test/browser', { recursive: true })
    writeFileSync('test/browser/home.spec.ts', '')
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('failed'), { status: 4 })
    })
    const run = await runCli(['test', '--browser'])
    expect(run.exit).toBe(4)
  })

  test('propagates the runner exit code on failure', async () => {
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('tests failed'), { status: 2 })
    })
    const run = await runCli(['test', '--unit'])
    expect(run.exit).toBe(2)
  })

  test('defaults to exit 1 when the failure carries no status', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    const run = await runCli(['test', '--unit'])
    expect(run.exit).toBe(1)
  })
})

// --- resolve -------------------------------------------------------------

describe('resolve', () => {
  test('requires an NSID', async () => {
    const run = await runCli(['resolve'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Usage: hatk resolve <nsid>')
  })

  test('fails when the registry returns nothing', async () => {
    resolveLexiconMock.mockResolvedValue(new Map())
    const run = await runCli(['resolve', 'com.example.widget'])

    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Could not resolve com.example.widget')
  })

  test('writes every resolved lexicon, including transitive refs, then regenerates types', async () => {
    resolveLexiconMock.mockResolvedValue(
      new Map([
        ['com.example.widget', { lexicon: 1, id: 'com.example.widget', defs: {} }],
        ['com.example.defs', { lexicon: 1, id: 'com.example.defs', defs: {} }],
      ]),
    )
    const run = await runCli(['resolve', 'com.example.widget'])

    expect(run.exit).toBeNull()
    expect(resolveLexiconMock).toHaveBeenCalledWith('com.example.widget')
    expect(JSON.parse(readFileSync('lexicons/com/example/widget.json', 'utf-8')).id).toBe('com.example.widget')
    expect(JSON.parse(readFileSync('lexicons/com/example/defs.json', 'utf-8')).id).toBe('com.example.defs')
    expect(allOutput(run)).toContain('Resolved 2 lexicon(s)')
    expect(execCalls()).toEqual(['npx hatk generate types'])
  })
})
