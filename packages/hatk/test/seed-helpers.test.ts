/**
 * `seed()` is the only hatk helper that writes to a PDS, and it runs
 * unattended during `hatk dev`. The things worth pinning down are the ones that
 * fail silently or destructively: reusing an existing account instead of
 * aborting, rejecting a record before it reaches the network, and picking the
 * right content type for a blob upload. No PDS is contacted here — fetch is
 * stubbed and every request is inspected.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seed, type Session } from '../src/seed.ts'

let root: string
let lexiconsDir: string
const SESSION: Session = { did: 'did:plc:alice', accessJwt: 'jwt-token', handle: 'alice.test' }

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hatk-seed-')))
  lexiconsDir = join(root, 'lexicons')
  mkdirSync(join(lexiconsDir, 'xyz/statusphere'), { recursive: true })
  writeFileSync(
    join(lexiconsDir, 'xyz/statusphere/status.json'),
    JSON.stringify({
      lexicon: 1,
      id: 'xyz.statusphere.status',
      defs: {
        main: {
          type: 'record',
          key: 'tid',
          record: {
            type: 'object',
            required: ['status', 'createdAt'],
            properties: {
              status: { type: 'string', maxLength: 32 },
              createdAt: { type: 'string', format: 'datetime' },
            },
          },
        },
      },
    }),
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

interface Call {
  url: string
  method?: string
  headers: Record<string, string>
  body: any
}

/** Stub fetch with a per-endpoint responder and record every request. */
function stubFetch(responder: (url: string, init: any) => Response | Promise<Response>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any = {}) => {
      calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body })
      return responder(url, init)
    }),
  )
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A responder that succeeds at both account creation and session creation. */
function happyAuth(url: string): Response {
  if (url.endsWith('createAccount')) return json({ ok: true })
  if (url.endsWith('createSession')) return json({ did: 'did:plc:alice', accessJwt: 'jwt-token' })
  return json({}, 404)
}

function makeSeed(opts: Record<string, unknown> = {}) {
  return seed({ lexicons: lexiconsDir, ...opts })
}

// --- target selection ----------------------------------------------------

describe('target PDS', () => {
  test('defaults to the local dev PDS', async () => {
    const calls = stubFetch(happyAuth)
    await makeSeed().createAccount('alice.test')
    expect(calls[0].url).toBe('http://localhost:2583/xrpc/com.atproto.server.createAccount')
  })

  test('honours PDS_URL from the environment', async () => {
    vi.stubEnv('PDS_URL', 'https://pds.example.test')
    const calls = stubFetch(happyAuth)
    await makeSeed().createAccount('alice.test')
    expect(calls[0].url).toBe('https://pds.example.test/xrpc/com.atproto.server.createAccount')
  })

  test('an explicit option beats the environment', async () => {
    vi.stubEnv('PDS_URL', 'https://pds.example.test')
    const calls = stubFetch(happyAuth)
    await makeSeed({ pds: 'https://explicit.test' }).createAccount('alice.test')
    expect(calls[0].url).toBe('https://explicit.test/xrpc/com.atproto.server.createAccount')
  })

  test('takes the account password from SEED_PASSWORD', async () => {
    vi.stubEnv('SEED_PASSWORD', 'hunter2')
    const calls = stubFetch(happyAuth)
    await makeSeed().createAccount('alice.test')
    expect(JSON.parse(calls[0].body).password).toBe('hunter2')
    expect(JSON.parse(calls[1].body).password).toBe('hunter2')
  })
})

// --- createAccount -------------------------------------------------------

describe('createAccount', () => {
  test('creates the account then logs in, returning the session with its handle', async () => {
    const calls = stubFetch(happyAuth)
    const session = await makeSeed().createAccount('alice.test')

    expect(session).toEqual({ did: 'did:plc:alice', accessJwt: 'jwt-token', handle: 'alice.test' })
    expect(calls.map((c) => c.url.split('/xrpc/')[1])).toEqual([
      'com.atproto.server.createAccount',
      'com.atproto.server.createSession',
    ])
    const created = JSON.parse(calls[0].body)
    expect(created.handle).toBe('alice.test')
    // A synthesized invalid-TLD email keeps seed accounts from colliding with real ones.
    expect(created.email).toBe('alice@test.invalid')
  })

  test('reuses an account that already exists', async () => {
    // Re-running `hatk dev` must not fail just because the account survived.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    stubFetch((url) => {
      if (url.endsWith('createAccount')) return new Response('Handle already taken', { status: 400 })
      return json({ did: 'did:plc:alice', accessJwt: 'jwt-token' })
    })

    const session = await makeSeed().createAccount('alice.test')

    expect(session.did).toBe('did:plc:alice')
    expect(log.mock.calls.flat()).toContain('[seed] account exists: alice.test')
  })

  test('throws on a real account-creation failure', async () => {
    // "Invalid email" is a bug in the seed script, not an idempotent re-run.
    stubFetch(() => new Response('Invalid email address', { status: 400 }))
    await expect(makeSeed().createAccount('alice.test')).rejects.toThrow(
      'Failed to create account alice.test: Invalid email address',
    )
  })

  test('throws when the password does not match an existing account', async () => {
    stubFetch((url) => {
      if (url.endsWith('createAccount')) return new Response('Handle already taken', { status: 400 })
      return new Response('Invalid identifier or password', { status: 401 })
    })

    await expect(makeSeed().createAccount('alice.test')).rejects.toThrow(
      'Failed to create session for alice.test: Invalid identifier or password',
    )
  })
})

// --- createRecord --------------------------------------------------------

describe('createRecord', () => {
  const validRecord = { status: '\u{1F44D}', createdAt: '2026-01-01T00:00:00.000Z' }

  test('puts a validated record at the requested rkey with $type stamped in', async () => {
    const calls = stubFetch(() =>
      json({
        uri: 'at://did:plc:alice/xyz.statusphere.status/status1',
        cid: 'bafy',
        commit: { cid: 'bafy', rev: '1' },
        validationStatus: 'valid',
      }),
    )

    const result = await makeSeed().createRecord(SESSION, 'xyz.statusphere.status', validRecord, { rkey: 'status1' })

    expect(result.uri).toBe('at://did:plc:alice/xyz.statusphere.status/status1')
    const body = JSON.parse(calls[0].body)
    expect(calls[0].url).toBe('http://localhost:2583/xrpc/com.atproto.repo.putRecord')
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-token')
    expect(body).toEqual({
      repo: 'did:plc:alice',
      collection: 'xyz.statusphere.status',
      rkey: 'status1',
      record: { $type: 'xyz.statusphere.status', ...validRecord },
    })
  })

  test('rejects a record missing a required field before any request goes out', async () => {
    // Catching this locally is the point: the PDS would accept it and the
    // indexer would reject it later, far from the seed script.
    const calls = stubFetch(() => json({}))
    await expect(
      makeSeed().createRecord(SESSION, 'xyz.statusphere.status', { status: 'hi' } as any, { rkey: 'status1' }),
    ).rejects.toThrow(/validation error in xyz\.statusphere\.status/)
    expect(calls).toHaveLength(0)
  })

  test('rejects a record whose field violates the lexicon constraints', async () => {
    const calls = stubFetch(() => json({}))
    await expect(
      makeSeed().createRecord(
        SESSION,
        'xyz.statusphere.status',
        { status: 'x'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' } as any,
        { rkey: 'status1' },
      ),
    ).rejects.toThrow(/validation error/)
    expect(calls).toHaveLength(0)
  })

  test('rejects a collection with no lexicon at all', async () => {
    const calls = stubFetch(() => json({}))
    await expect(makeSeed().createRecord(SESSION, 'com.unknown.thing', { a: 1 } as any, { rkey: 'r' })).rejects.toThrow(
      /\[seed\] validation error in com\.unknown\.thing/,
    )
    expect(calls).toHaveLength(0)
  })

  test('reports which account and collection a PDS rejection came from', async () => {
    stubFetch(() => new Response('Repo not found', { status: 400 }))
    await expect(
      makeSeed().createRecord(SESSION, 'xyz.statusphere.status', validRecord, { rkey: 'status1' }),
    ).rejects.toThrow('[seed] [alice.test] failed to create xyz.statusphere.status: Repo not found')
  })
})

// --- uploadBlob ----------------------------------------------------------

describe('uploadBlob', () => {
  const blobRef = { $type: 'blob', ref: { $link: 'bafyblob' }, mimeType: 'image/png', size: 4 }

  test('uploads the file bytes and returns the blob ref', async () => {
    const file = join(root, 'avatar.png')
    writeFileSync(file, Buffer.from([1, 2, 3, 4]))
    const calls = stubFetch(() => json({ blob: blobRef }))

    const result = await makeSeed().uploadBlob(SESSION, file)

    expect(result).toEqual(blobRef)
    expect(calls[0].url).toBe('http://localhost:2583/xrpc/com.atproto.repo.uploadBlob')
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-token')
    expect(Buffer.from(calls[0].body)).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  test.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['mp3', 'audio/mpeg'],
    ['mp4', 'video/mp4'],
  ])('sends a .%s file as %s', async (ext, mime) => {
    // The PDS stores whatever Content-Type it is handed, so an octet-stream
    // avatar renders as a download link forever after.
    const file = join(root, `asset.${ext}`)
    writeFileSync(file, 'x')
    const calls = stubFetch(() => json({ blob: blobRef }))

    await makeSeed().uploadBlob(SESSION, file)

    expect(calls[0].headers['Content-Type']).toBe(mime)
  })

  test('falls back to application/octet-stream for an unknown extension', async () => {
    const file = join(root, 'data.bin')
    writeFileSync(file, 'x')
    const calls = stubFetch(() => json({ blob: blobRef }))

    await makeSeed().uploadBlob(SESSION, file)

    expect(calls[0].headers['Content-Type']).toBe('application/octet-stream')
  })

  test('matches the extension case-insensitively', async () => {
    const file = join(root, 'PHOTO.JPG')
    writeFileSync(file, 'x')
    const calls = stubFetch(() => json({ blob: blobRef }))

    await makeSeed().uploadBlob(SESSION, file)

    expect(calls[0].headers['Content-Type']).toBe('image/jpeg')
  })

  test('reports the path when the PDS refuses the blob', async () => {
    const file = join(root, 'huge.png')
    writeFileSync(file, 'x')
    stubFetch(() => new Response('BlobTooLarge', { status: 400 }))

    await expect(makeSeed().uploadBlob(SESSION, file)).rejects.toThrow(
      `[seed] failed to upload blob ${file}: BlobTooLarge`,
    )
  })

  test('fails loudly when the file is missing', async () => {
    stubFetch(() => json({ blob: blobRef }))
    await expect(makeSeed().uploadBlob(SESSION, join(root, 'ghost.png'))).rejects.toThrow(/ENOENT/)
  })
})
