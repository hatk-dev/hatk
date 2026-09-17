/**
 * `hatk generate` is the surface every project touches on day one, and its two
 * failure modes are both silent: scaffolding into the wrong path, and emitting a
 * hatk.generated.ts that does not type-check. These tests run the real CLI in a
 * throwaway project directory and read back what it wrote.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allOutput, runCli, useTempProject } from './cli-harness.ts'

// The generators shell out to `npx hatk generate types` after writing a lexicon;
// nothing here may actually spawn a process.
const { execSyncMock, spawnMock } = vi.hoisted(() => ({ execSyncMock: vi.fn(), spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execSync: execSyncMock, spawn: spawnMock }))

let project: ReturnType<typeof useTempProject>

beforeEach(() => {
  project = useTempProject()
  execSyncMock.mockReset()
  spawnMock.mockReset()
})

afterEach(() => {
  project.cleanup()
})

/** Write a lexicon JSON file into the project's lexicons/ tree. */
function writeLexicon(nsid: string, lexicon: unknown): void {
  const parts = nsid.split('.')
  const dir = join('lexicons', ...parts.slice(0, -1))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${parts.at(-1)}.json`), JSON.stringify(lexicon))
}

function recordLexicon(nsid: string, props: Record<string, unknown> = {}) {
  return {
    lexicon: 1,
    id: nsid,
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: { type: 'object', required: ['createdAt'], properties: { createdAt: { type: 'string' }, ...props } },
      },
    },
  }
}

// --- dispatch ------------------------------------------------------------

describe('command dispatch', () => {
  test('prints usage and fails when no command is given', async () => {
    const run = await runCli([])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Usage: hatk <command> [options]')
  })

  test('prints usage and fails for an unrecognized command', async () => {
    // Exiting non-zero matters: a typo'd command in a CI script must fail the job.
    const run = await runCli(['groobify'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Usage: hatk <command> [options]')
  })

  test('usage lists every command the CLI actually dispatches on', async () => {
    const run = await runCli([])
    const usage = allOutput(run)
    for (const cmd of [
      'start',
      'dev',
      'seed',
      'reset',
      'check',
      'format',
      'test',
      'build',
      'generate',
      'destroy',
      'resolve',
    ]) {
      expect(usage).toContain(cmd)
    }
  })

  test('`hatk new` points at the vp template instead of silently doing nothing', async () => {
    const run = await runCli(['new', 'my-app'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('vp create github:hatk-dev/hatk-template-starter')
  })
})

// --- generate <lexicon> --------------------------------------------------

describe('generate <lexicon type>', () => {
  test('writes a record lexicon at the path its NSID implies', async () => {
    const run = await runCli(['generate', 'record', 'com.example.widget'])

    expect(run.exit).toBeNull()
    const written = JSON.parse(readFileSync('lexicons/com/example/widget.json', 'utf-8'))
    expect(written.id).toBe('com.example.widget')
    expect(written.defs.main.type).toBe('record')
    expect(written.defs.main.key).toBe('tid')
    expect(written.defs.main.record.required).toEqual(['createdAt'])
    expect(allOutput(run)).toContain('Created lexicons/com/example/widget.json')
  })

  test('regenerates types after scaffolding a lexicon', async () => {
    // Without this the new lexicon exists but nothing is typed against it yet.
    await runCli(['generate', 'record', 'com.example.widget'])
    expect(execSyncMock).toHaveBeenCalledWith('npx hatk generate types', expect.anything())
  })

  test('writes a query lexicon with params and a JSON output schema', async () => {
    await runCli(['generate', 'query', 'com.example.getWidgets'])
    const written = JSON.parse(readFileSync('lexicons/com/example/getWidgets.json', 'utf-8'))
    expect(written.defs.main.type).toBe('query')
    expect(written.defs.main.parameters.type).toBe('params')
    expect(written.defs.main.output.encoding).toBe('application/json')
  })

  test('writes a procedure lexicon with both an input and an output', async () => {
    await runCli(['generate', 'procedure', 'com.example.putWidget'])
    const written = JSON.parse(readFileSync('lexicons/com/example/putWidget.json', 'utf-8'))
    expect(written.defs.main.type).toBe('procedure')
    expect(written.defs.main.input.encoding).toBe('application/json')
    expect(written.defs.main.output.encoding).toBe('application/json')
  })

  test('rejects a name that is not an NSID', async () => {
    // A bare name would scaffold lexicons/widget.json, which loadLexicons skips.
    const run = await runCli(['generate', 'record', 'widget'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Usage: hatk generate record <nsid>')
    expect(existsSync('lexicons')).toBe(false)
  })

  test('rejects a missing NSID', async () => {
    const run = await runCli(['generate', 'query'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Usage: hatk generate query <nsid>')
  })

  test('refuses to clobber an existing lexicon', async () => {
    writeLexicon('com.example.widget', { lexicon: 1, id: 'com.example.widget', defs: { hand: 'written' } })
    const run = await runCli(['generate', 'record', 'com.example.widget'])

    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('already exists')
    // The original is still intact.
    expect(JSON.parse(readFileSync('lexicons/com/example/widget.json', 'utf-8')).defs.hand).toBe('written')
  })
})

// --- generate <handler> --------------------------------------------------

describe('generate <handler type>', () => {
  test('scaffolds a feed into server/ with the name substituted', async () => {
    const run = await runCli(['generate', 'feed', 'trending'])

    expect(run.exit).toBeNull()
    const src = readFileSync('server/trending.ts', 'utf-8')
    expect(src).toContain('defineFeed')
    // {{Name}} is the capitalized form used for the human-facing label.
    expect(src).toContain(`label: 'Trending'`)
    expect(src).not.toContain('{{')
  })

  test('scaffolds a matching test file for a feed', async () => {
    const run = await runCli(['generate', 'feed', 'trending'])
    expect(existsSync('test/server/trending.test.ts')).toBe(true)
    expect(allOutput(run)).toContain('Created test/server/trending.test.ts')
  })

  test('names an xrpc handler after the NSID leaf, not the whole NSID', async () => {
    // server/com.example.getWidgets.ts would be a legal filename but an ugly one.
    await runCli(['generate', 'xrpc', 'com.example.getWidgets'])
    expect(existsSync('server/getWidgets.ts')).toBe(true)
    expect(existsSync('test/server/getWidgets.test.ts')).toBe(true)
    // The handler still registers the full NSID.
    expect(readFileSync('server/getWidgets.ts', 'utf-8')).toContain('com.example.getWidgets')
  })

  test.each(['label', 'og', 'hook', 'setup'])('scaffolds a %s with no test file', async (type) => {
    // Only feeds and xrpc handlers ship test templates today.
    await runCli(['generate', type, 'thing'])
    expect(existsSync(`server/thing.ts`)).toBe(true)
    expect(existsSync('test/server/thing.test.ts')).toBe(false)
  })

  test('leaves an existing test file alone when regenerating', async () => {
    await runCli(['generate', 'feed', 'trending'])
    writeFileSync('test/server/trending.test.ts', '// my edits')
    // Removing just the handler and regenerating must not wipe the test.
    const { unlinkSync } = await import('node:fs')
    unlinkSync('server/trending.ts')
    await runCli(['generate', 'feed', 'trending'])

    expect(readFileSync('test/server/trending.test.ts', 'utf-8')).toBe('// my edits')
  })

  test('refuses to clobber an existing handler', async () => {
    mkdirSync('server', { recursive: true })
    writeFileSync('server/trending.ts', '// mine')
    const run = await runCli(['generate', 'feed', 'trending'])

    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('server/trending.ts already exists')
    expect(readFileSync('server/trending.ts', 'utf-8')).toBe('// mine')
  })

  test('lists the valid types when the type is unknown', async () => {
    const run = await runCli(['generate', 'nonsense', 'thing'])
    expect(run.exit).toBe(1)
    const usage = allOutput(run)
    expect(usage).toContain('Usage: hatk generate')
    for (const t of ['feed', 'xrpc', 'label', 'og', 'hook', 'setup', 'record', 'query', 'procedure', 'types']) {
      expect(usage).toContain(t)
    }
  })

  test('rejects a handler type with no name', async () => {
    const run = await runCli(['generate', 'feed'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Usage: hatk generate')
  })
})

// --- generate types ------------------------------------------------------

describe('generate types', () => {
  test('fails when there is no lexicons directory', async () => {
    const run = await runCli(['generate', 'types'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Lexicons directory not found')
  })

  test('fails when the lexicons directory holds nothing usable', async () => {
    mkdirSync('lexicons', { recursive: true })
    writeFileSync('lexicons/notes.json', JSON.stringify({ hello: 'world' }))
    const run = await runCli(['generate', 'types'])

    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('No lexicons found')
  })

  test('emits a record type, a registry entry and the client subset', async () => {
    writeLexicon('com.example.widget', recordLexicon('com.example.widget', { name: { type: 'string' } }))
    const run = await runCli(['generate', 'types'])

    expect(run.exit).toBeNull()
    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).toContain(`export type Widget = Prettify<LexRecord<typeof widgetLex, Registry>>`)
    expect(generated).toContain(`'com.example.widget': typeof widgetLex`)
    expect(generated).toContain(`export type RecordRegistry = {`)
    expect(generated).toContain(`'com.example.widget': Widget`)
    // The whole lexicon is inlined so types resolve without reading JSON at runtime.
    expect(generated).toContain(`const widgetLex = {"lexicon":1,"id":"com.example.widget"`)

    const client = readFileSync('hatk.generated.client.ts', 'utf-8')
    expect(client).toContain(`export type { XrpcSchema } from './hatk.generated.ts'`)
    expect(client).toContain('Widget')
    // The client bundle must not re-export server-only modules.
    expect(client).not.toContain('@hatk/hatk/feeds')
    expect(client).not.toContain('defineSetup')
  })

  test('the client sends an array parameter as a repeated key', async () => {
    // XRPC carries a list as `?dids=a&dids=b`. Joined with commas by
    // `String(v)` it arrives as one string, and a handler typed against the
    // lexicon's `string[]` spreads the characters of a DID.
    writeLexicon('com.example.getActors', {
      lexicon: 1,
      id: 'com.example.getActors',
      defs: {
        main: {
          type: 'query',
          parameters: {
            type: 'params',
            required: ['dids'],
            properties: { dids: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' } },
          },
          output: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
        },
      },
    })

    const run = await runCli(['generate', 'types'])
    expect(run.exit).toBeNull()

    const client = readFileSync('hatk.generated.client.ts', 'utf-8')
    expect(client).toContain('if (Array.isArray(v)) for (const item of v) params.append(k, String(item))')
    // A scalar still takes the last value rather than repeating.
    expect(client).toContain('else params.set(k, String(v))')
    expect(client).not.toContain('if (v != null) params.set(k, String(v))')
  })

  test('reports what it generated', async () => {
    writeLexicon('com.example.widget', recordLexicon('com.example.widget'))
    const run = await runCli(['generate', 'types'])
    expect(allOutput(run)).toContain('Generated ./hatk.generated.ts with 1 types: Widget')
    expect(allOutput(run)).toContain('Generated ./hatk.generated.client.ts (client-safe subset)')
  })

  test('disambiguates lexicons that share a leaf name', async () => {
    // Two `profile` records in different namespaces would otherwise both want to
    // be `export type Profile`, which does not compile.
    writeLexicon('app.bsky.actor.profile', recordLexicon('app.bsky.actor.profile'))
    writeLexicon('com.example.profile', recordLexicon('com.example.profile'))
    await runCli(['generate', 'types'])

    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).toContain('export type BskyActorProfile =')
    expect(generated).toContain('export type ExampleProfile =')
    expect(generated).not.toMatch(/export type Profile\b/)
  })

  test('registers procedures on the client so callXrpc POSTs them', async () => {
    writeLexicon('com.example.putWidget', {
      lexicon: 1,
      id: 'com.example.putWidget',
      defs: {
        main: {
          type: 'procedure',
          input: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
          output: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
        },
      },
    })
    await runCli(['generate', 'types'])

    const client = readFileSync('hatk.generated.client.ts', 'utf-8')
    expect(client).toContain(`const _procedures = new Set(['com.example.putWidget'])`)
    expect(client).toContain(`method: 'POST'`)
    expect(client).not.toContain('_blobInputs')
    // Queries still go out as GET with a query string.
    expect(readFileSync('hatk.generated.ts', 'utf-8')).toContain('export type PutWidget =')
  })

  test('routes a blob-input procedure through a raw POST, not JSON', async () => {
    // An `encoding: '*/*'` input is a binary upload; JSON.stringify would corrupt it.
    writeLexicon('com.example.uploadThing', {
      lexicon: 1,
      id: 'com.example.uploadThing',
      defs: {
        main: {
          type: 'procedure',
          input: { encoding: '*/*' },
          output: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
        },
      },
    })
    await runCli(['generate', 'types'])

    const client = readFileSync('hatk.generated.client.ts', 'utf-8')
    expect(client).toContain(`const _blobInputs = new Set(['com.example.uploadThing'])`)
    expect(client).toContain('blob instanceof Blob')
    expect(client).not.toContain('_procedures')
  })

  test('emits basic CRUD types when a project has queries but no records', async () => {
    writeLexicon('com.example.getWidgets', {
      lexicon: 1,
      id: 'com.example.getWidgets',
      defs: {
        main: {
          type: 'query',
          parameters: { type: 'params', properties: {} },
          output: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
        },
      },
    })
    await runCli(['generate', 'types'])

    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).toContain('export type RecordRegistry = {}')
    expect(generated).toContain('export type CreateRecord = LexProcedure<typeof createRecordLex, Registry>')
    expect(generated).toContain(`'com.example.getWidgets': GetWidgets`)
  })

  test('imports LexDef only when a lexicon actually has named object defs', async () => {
    writeLexicon('com.example.widget', recordLexicon('com.example.widget'))
    await runCli(['generate', 'types'])
    expect(readFileSync('hatk.generated.ts', 'utf-8')).not.toContain('LexDef')

    writeLexicon('com.example.defs', {
      lexicon: 1,
      id: 'com.example.defs',
      defs: { widgetBadge: { type: 'object', properties: { color: { type: 'string' } } } },
    })
    await runCli(['generate', 'types'])

    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).toContain('LexDef')
    expect(generated).toContain(`export type WidgetBadge = Prettify<LexDef<typeof defsLex, 'widgetBadge', Registry>>`)
  })

  test('emits a views helper for a view def that references its own record', async () => {
    // views.widgetView({...}) is how a feed gets excess-property checking on the
    // object literals it hydrates.
    writeLexicon('com.example.widget', {
      lexicon: 1,
      id: 'com.example.widget',
      defs: {
        main: {
          type: 'record',
          key: 'tid',
          record: { type: 'object', required: [], properties: { name: { type: 'string' } } },
        },
        widgetView: {
          type: 'object',
          properties: { uri: { type: 'string' }, record: { type: 'ref', ref: '#main' } },
        },
      },
    })
    await runCli(['generate', 'types'])

    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).toContain('export const views = {')
    expect(generated).toContain('widgetView: (v: WidgetView): WidgetView => v,')
  })

  test('links a view in a separate defs lexicon back to its record by naming convention', async () => {
    writeLexicon('com.example.widget', recordLexicon('com.example.widget'))
    writeLexicon('com.example.defs', {
      lexicon: 1,
      id: 'com.example.defs',
      defs: {
        widgetView: { type: 'object', properties: { uri: { type: 'string' } } },
      },
    })
    await runCli(['generate', 'types'])

    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).toContain('widgetView: (v: WidgetView): WidgetView => v,')
  })

  test('prefixes a def name that collides with a record type name', async () => {
    // Both want to be `Widget`; the def has to yield.
    writeLexicon('com.example.widget', recordLexicon('com.example.widget'))
    writeLexicon('com.example.defs', {
      lexicon: 1,
      id: 'com.example.defs',
      defs: { widget: { type: 'object', properties: { color: { type: 'string' } } } },
    })
    await runCli(['generate', 'types'])

    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).toContain('export type DefsWidget =')
    expect(generated.match(/export type Widget = /g) ?? []).toHaveLength(1)
  })

  test('links a view to a record in another namespace through an explicit ref', async () => {
    // A shared `app.bsky.*` view can front a record that lives elsewhere; the
    // generator has to follow the ref rather than guess from the name.
    writeLexicon('com.other.gadget', recordLexicon('com.other.gadget'))
    writeLexicon('com.example.defs', {
      lexicon: 1,
      id: 'com.example.defs',
      defs: {
        shinyView: {
          type: 'object',
          properties: { uri: { type: 'string' }, subject: { type: 'ref', ref: 'com.other.gadget' } },
        },
      },
    })
    await runCli(['generate', 'types'])

    expect(readFileSync('hatk.generated.ts', 'utf-8')).toContain('shinyView: (v: ShinyView): ShinyView => v,')
  })

  test('still emits a helper for a view tied to no record at all', async () => {
    // A standalone view is a reusable shape; it deserves the same excess-property
    // checking even though nothing indexes it.
    writeLexicon('com.example.defs', {
      lexicon: 1,
      id: 'com.example.defs',
      defs: {
        bannerView: { type: 'object', properties: { title: { type: 'string' }, image: { type: 'string' } } },
      },
    })
    await runCli(['generate', 'types'])

    expect(readFileSync('hatk.generated.ts', 'utf-8')).toContain('bannerView: (v: BannerView): BannerView => v,')
  })

  test('does not emit a generic wrapper for the built-in CRUD procedures', async () => {
    // dev.hatk.createRecord gets a hand-written type keyed off RecordRegistry;
    // emitting the generic LexProcedure form too would shadow it.
    writeLexicon('com.example.widget', recordLexicon('com.example.widget'))
    writeLexicon('dev.hatk.createRecord', {
      lexicon: 1,
      id: 'dev.hatk.createRecord',
      defs: {
        main: {
          type: 'procedure',
          input: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
          output: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
        },
      },
    })
    await runCli(['generate', 'types'])

    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).not.toContain('export type CreateRecord = Prettify<LexProcedure')
    expect(generated).toContain('export type CreateRecord = {')
    expect(generated).toContain(`  input: { [K in keyof RecordRegistry]: { collection: K; record: RecordRegistry[K]`)
    // ...and the client subset does not re-export the shadowed name either.
    expect(readFileSync('hatk.generated.client.ts', 'utf-8')).toContain('CreateRecord')
  })

  test('keeps defs-only lexicons in the registry so cross-lexicon refs resolve', async () => {
    writeLexicon('com.example.defs', {
      lexicon: 1,
      id: 'com.example.defs',
      defs: { badge: { type: 'object', properties: { color: { type: 'string' } } } },
    })
    writeLexicon('com.example.widget', recordLexicon('com.example.widget'))
    await runCli(['generate', 'types'])

    const generated = readFileSync('hatk.generated.ts', 'utf-8')
    expect(generated).toContain(`'com.example.defs': typeof defsLex`)
    // ...but a defs-only lexicon has no main type to export.
    expect(generated).not.toContain('export type Defs =')
  })
})

// --- destroy -------------------------------------------------------------

describe('destroy', () => {
  test('removes a generated handler and its test file', async () => {
    await runCli(['generate', 'feed', 'trending'])
    const run = await runCli(['destroy', 'feed', 'trending'])

    expect(run.exit).toBeNull()
    expect(existsSync('server/trending.ts')).toBe(false)
    expect(existsSync('test/server/trending.test.ts')).toBe(false)
    expect(allOutput(run)).toContain('Removed server/trending.ts')
    expect(allOutput(run)).toContain('Removed test/server/trending.test.ts')
  })

  test('resolves an xrpc handler by its NSID leaf, matching generate', async () => {
    await runCli(['generate', 'xrpc', 'com.example.getWidgets'])
    const run = await runCli(['destroy', 'xrpc', 'com.example.getWidgets'])

    expect(run.exit).toBeNull()
    expect(existsSync('server/getWidgets.ts')).toBe(false)
  })

  test('removes a plain .js handler too', async () => {
    mkdirSync('server', { recursive: true })
    writeFileSync('server/legacy.js', 'export default {}')
    const run = await runCli(['destroy', 'hook', 'legacy'])

    expect(run.exit).toBeNull()
    expect(existsSync('server/legacy.js')).toBe(false)
  })

  test('warns that destroying a label leaves applied labels behind', async () => {
    // The file is code; the labels it applied are rows in someone's database.
    await runCli(['generate', 'label', 'spam'])
    const run = await runCli(['destroy', 'label', 'spam'])
    expect(allOutput(run)).toContain('existing applied labels for "spam" remain in the database')
  })

  test('fails when nothing matches', async () => {
    const run = await runCli(['destroy', 'feed', 'ghost'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('No file found for feed "ghost"')
  })

  test('lists destroyable types when the type is unknown', async () => {
    const run = await runCli(['destroy', 'lexicon', 'com.example.widget'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Usage: hatk destroy <feed|xrpc|label|og|hook|setup> <name>')
  })

  test('rejects a type with no name', async () => {
    const run = await runCli(['destroy', 'feed'])
    expect(run.exit).toBe(1)
    expect(allOutput(run)).toContain('Usage: hatk destroy')
  })
})
