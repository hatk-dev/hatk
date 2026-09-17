import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig, loadConfig, relayHttpUrl } from '../src/config.ts'

// `loadConfig` is the single place defaults, the config file, and environment
// overrides are reconciled, and every subsystem reads the result. Paths in the
// file are relative to the file (not to cwd), env wins over file, and a missing
// or broken file must fail loudly rather than boot on defaults.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hatk-config-'))

const ENV_KEYS = [
  'RELAY',
  'RELAYS',
  'JETSTREAM_URL',
  'DID_PLC_URL',
  'PORT',
  'DATABASE_ENGINE',
  'DATABASE',
  'BACKFILL_REPOS',
  'BACKFILL_FULL_NETWORK',
  'BACKFILL_PARALLELISM',
  'BACKFILL_FETCH_TIMEOUT',
  'BACKFILL_MAX_RETRIES',
  'FTS_REBUILD_INTERVAL',
  'CDN_URL',
  'CDN_KEY',
  'CDN_SALT',
  'ADMINS',
  'OAUTH_ISSUER',
]
const savedEnv: Record<string, string | undefined> = {}

let counter = 0
/** Write a config module into a fresh subdirectory so relative paths are unambiguous. */
function writeConfig(source: string, name = 'hatk.config.mjs'): string {
  const dir = path.join(tmp, `p${counter++}`)
  fs.mkdirSync(dir)
  const file = path.join(dir, name)
  fs.writeFileSync(file, source)
  return file
}

function exitThrows() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as any)
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('defineConfig returns its input unchanged (it exists for type inference)', () => {
  const input = { relay: 'ws://x', port: 1 }
  expect(defineConfig(input)).toBe(input)
})

test('relayHttpUrl swaps ws/wss for http/https and leaves other schemes alone', () => {
  expect(relayHttpUrl('ws://localhost:2583')).toBe('http://localhost:2583')
  expect(relayHttpUrl('wss://bsky.network')).toBe('https://bsky.network')
  expect(relayHttpUrl('https://already.http')).toBe('https://already.http')
})

test('an empty config file yields the documented defaults', async () => {
  const file = writeConfig(`export default {}`)
  const config = await loadConfig(file)

  expect(config).toMatchObject({
    relay: 'ws://localhost:2583',
    relays: [],
    jetstream: null,
    plc: 'https://plc.directory',
    port: 3000,
    databaseEngine: 'sqlite',
    database: ':memory:',
    collections: [],
    privateCollections: [],
    backfill: { fullNetwork: false, parallelism: 3, fetchTimeout: 300, maxRetries: 5 },
    ftsRebuildInterval: 5000,
    cdn: null,
    oauth: null,
    push: null,
    admins: [],
  })
  expect(config.backfill.signalCollections).toBeUndefined()
  expect(config.backfill.repos).toBeUndefined()
  // publicDir defaults to ./public next to the config file
  expect(config.publicDir).toBe(path.join(path.dirname(file), 'public'))
})

test('a file with no default export is treated as an empty config', async () => {
  const file = writeConfig(`export const notDefault = { port: 9 }`)
  expect((await loadConfig(file)).port).toBe(3000)
})

test('file values are honoured and relative paths resolve against the config file', async () => {
  const file = writeConfig(`
    export default {
      relay: 'wss://relay.test',
      relays: ['wss://pds-a.test', 'wss://pds-b.test'],
      plc: 'https://plc.test',
      port: 4100,
      databaseEngine: 'duckdb',
      database: './data/app.db',
      publicDir: '../static',
      collections: ['a.b.c'],
      privateCollections: ['a.b.secret'],
      backfill: { signalCollections: ['a.b.c'], repos: ['did:plc:one'], fullNetwork: true, parallelism: 8, fetchTimeout: 30, maxRetries: 2 },
      ftsRebuildInterval: 100,
      cdn: { url: 'https://cdn.test', key: 'aa', salt: 'bb' },
      push: { apns: { keyFile: 'k.p8', keyId: 'K', teamId: 'T', bundleId: 'b' } },
      admins: ['did:plc:admin'],
      jetstream: { url: 'wss://jetstream.test' },
    }
  `)
  const dir = path.dirname(file)
  const config = await loadConfig(file)

  expect(config.relay).toBe('wss://relay.test')
  expect(config.relays).toEqual(['wss://pds-a.test', 'wss://pds-b.test'])
  expect(config.plc).toBe('https://plc.test')
  expect(config.port).toBe(4100)
  expect(config.databaseEngine).toBe('duckdb')
  expect(config.database).toBe(path.join(dir, 'data', 'app.db'))
  expect(config.publicDir).toBe(path.resolve(dir, '../static'))
  expect(config.collections).toEqual(['a.b.c'])
  expect(config.privateCollections).toEqual(['a.b.secret'])
  expect(config.backfill).toEqual({
    signalCollections: ['a.b.c'],
    repos: ['did:plc:one'],
    fullNetwork: true,
    parallelism: 8,
    fetchTimeout: 30,
    maxRetries: 2,
  })
  expect(config.ftsRebuildInterval).toBe(100)
  expect(config.cdn).toEqual({ url: 'https://cdn.test', key: 'aa', salt: 'bb' })
  expect(config.push).toEqual({ apns: { keyFile: 'k.p8', keyId: 'K', teamId: 'T', bundleId: 'b' } })
  expect(config.admins).toEqual(['did:plc:admin'])
  expect(config.jetstream).toEqual({ url: 'wss://jetstream.test' })
})

test('publicDir: null disables static serving instead of resolving to ./public', async () => {
  const file = writeConfig(`export default { publicDir: null }`)
  expect((await loadConfig(file)).publicDir).toBeNull()
})

test('a config file written in TypeScript loads too', async () => {
  const file = writeConfig(`const port: number = 4242\nexport default { port }`, 'hatk.config.ts')
  expect((await loadConfig(file)).port).toBe(4242)
})

test('environment variables override file values', async () => {
  const file = writeConfig(`
    export default {
      relay: 'wss://file.test', relays: ['wss://file-a.test'], plc: 'https://file-plc', port: 1111,
      databaseEngine: 'sqlite', database: './file.db', ftsRebuildInterval: 1,
      backfill: { repos: ['did:plc:file'], fullNetwork: true, parallelism: 1, fetchTimeout: 1, maxRetries: 1 },
      cdn: { url: 'https://file-cdn', key: 'f', salt: 'f' }, admins: ['did:plc:file'],
    }
  `)
  Object.assign(process.env, {
    RELAY: 'wss://env.test',
    RELAYS: ' wss://env-a.test , wss://env-b.test ,, ',
    JETSTREAM_URL: 'wss://env-jetstream.test',
    DID_PLC_URL: 'https://env-plc',
    PORT: '2222',
    DATABASE_ENGINE: 'duckdb',
    DATABASE: 'env.db',
    BACKFILL_REPOS: 'did:plc:e1, did:plc:e2',
    BACKFILL_FULL_NETWORK: 'false',
    BACKFILL_PARALLELISM: '12',
    BACKFILL_FETCH_TIMEOUT: '45',
    BACKFILL_MAX_RETRIES: '9',
    FTS_REBUILD_INTERVAL: '77',
    CDN_URL: 'https://env-cdn',
    CDN_KEY: 'ek',
    CDN_SALT: 'es',
    ADMINS: 'did:plc:e1, did:plc:e2',
  })
  const config = await loadConfig(file)

  expect(config.relay).toBe('wss://env.test')
  // whitespace trimmed and empty entries dropped
  expect(config.relays).toEqual(['wss://env-a.test', 'wss://env-b.test'])
  expect(config.jetstream).toEqual({ url: 'wss://env-jetstream.test' })
  expect(config.plc).toBe('https://env-plc')
  expect(config.port).toBe(2222)
  expect(config.databaseEngine).toBe('duckdb')
  expect(config.database).toBe(path.join(path.dirname(file), 'env.db'))
  expect(config.backfill).toEqual({
    signalCollections: undefined,
    repos: ['did:plc:e1', 'did:plc:e2'],
    fullNetwork: false, // the env string 'false' beats the file's true
    parallelism: 12,
    fetchTimeout: 45,
    maxRetries: 9,
  })
  expect(config.ftsRebuildInterval).toBe(77)
  expect(config.cdn).toEqual({ url: 'https://env-cdn', key: 'ek', salt: 'es' })
  expect(config.admins).toEqual(['did:plc:e1', 'did:plc:e2'])
})

test('a partial CDN env (no salt) falls back to the file rather than a half-built CDN', async () => {
  const file = writeConfig(`export default { cdn: { url: 'https://file-cdn', key: 'f', salt: 'f' } }`)
  process.env.CDN_URL = 'https://env-cdn'
  process.env.CDN_KEY = 'ek'
  expect((await loadConfig(file)).cdn).toEqual({ url: 'https://file-cdn', key: 'f', salt: 'f' })
})

test('a non-numeric PORT falls through to the file value', async () => {
  const file = writeConfig(`export default { port: 5150 }`)
  process.env.PORT = 'not-a-port'
  expect((await loadConfig(file)).port).toBe(5150)
})

test('oauth is null unless configured, and gets defaults when it is', async () => {
  const withoutOauth = writeConfig(`export default {}`)
  expect((await loadConfig(withoutOauth)).oauth).toBeNull()

  const clients = [{ client_id: 'https://app.test/client-metadata.json', client_name: 'App', redirect_uris: [] }]
  const minimal = writeConfig(`export default { port: 8080, oauth: { clients: ${JSON.stringify(clients)} } }`)
  expect((await loadConfig(minimal)).oauth).toEqual({
    issuer: 'http://127.0.0.1:8080', // derived from the resolved port
    scopes: ['atproto'],
    clients,
    conditionalScopes: [],
  })
})

test('oauth issuer comes from OAUTH_ISSUER, then the file, then the port', async () => {
  const file = writeConfig(`
    export default { oauth: { issuer: 'https://file.test', scopes: ['atproto', 'transition:generic'], clients: [],
      conditionalScopes: [{ whenMethod: 'x.y.z', scopes: ['extra'] }] } }
  `)
  const fromFile = await loadConfig(file)
  expect(fromFile.oauth?.issuer).toBe('https://file.test')
  expect(fromFile.oauth?.scopes).toEqual(['atproto', 'transition:generic'])
  expect(fromFile.oauth?.conditionalScopes).toEqual([{ whenMethod: 'x.y.z', scopes: ['extra'] }])

  process.env.OAUTH_ISSUER = 'https://env.test'
  expect((await loadConfig(file)).oauth?.issuer).toBe('https://env.test')
})

test('a missing config file exits the process with an explanation', async () => {
  const exit = exitThrows()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const missing = path.join(tmp, 'does-not-exist', 'hatk.config.ts')

  await expect(loadConfig(missing)).rejects.toThrow('exit 1')
  expect(exit).toHaveBeenCalledWith(1)
  expect(error.mock.calls.flat().join('\n')).toContain('Config file not found')
})

test('a config file that throws on import exits with the error message', async () => {
  const exit = exitThrows()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const file = writeConfig(`throw new Error('boom in config')`)

  await expect(loadConfig(file)).rejects.toThrow('exit 1')
  expect(exit).toHaveBeenCalledWith(1)
  expect(error.mock.calls.flat().join('\n')).toContain('boom in config')

  // A thrown non-Error (no .message) is printed as-is rather than as "undefined"
  const stringy = writeConfig(`throw 'plain string failure'`)
  await expect(loadConfig(stringy)).rejects.toThrow('exit 1')
  expect(error.mock.calls.flat().join('\n')).toContain('plain string failure')
})

test('an oauth block with no clients still enables oauth with an empty client list', async () => {
  // The type requires clients, but a JS config file can omit them; that must
  // not crash the metadata endpoints that iterate the list.
  const file = writeConfig(`export default { oauth: {} }`)
  expect((await loadConfig(file)).oauth).toEqual({
    issuer: 'http://127.0.0.1:3000',
    scopes: ['atproto'],
    clients: [],
    conditionalScopes: [],
  })
})
