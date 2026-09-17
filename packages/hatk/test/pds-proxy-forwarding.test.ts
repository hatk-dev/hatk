import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ProxyError,
  ScopeMissingProxyError,
  pdsApplyWrites,
  pdsCreateRecord,
  pdsDeleteRecord,
  pdsPutRecord,
  pdsUploadBlob,
  pdsXrpc,
} from '../src/pds-proxy.ts'
import { initOAuth } from '../src/oauth/server.ts'
import { OAUTH_DDL, getSession, storeSession } from '../src/oauth/db.ts'
import { parseJwt, base64UrlEncode, sha256 } from '../src/oauth/crypto.ts'
import { insertRecord, querySQL, runSQL } from '../src/database/db.ts'
import { storeLexicons } from '../src/database/schema.ts'
import { PUBLIC_COLLECTION, fixtureLexicons, setupFixtureDatabase } from './fixture.ts'

// Every write a user makes goes through here to their PDS, with our session
// on their behalf. What matters is what reaches the PDS (method, headers,
// body, proof), what the caller gets back, and that the local index reflects
// a write the PDS accepted — the app reads its own writes from here.

const ISSUER = 'https://example.app'
const PDS = 'https://pds.example.com'
const AUTH = 'https://auth.example.com'
const TOKEN = `${AUTH}/tok`
const DID = 'did:plc:alice'
const viewer = { did: DID }

const config = {
  issuer: ISSUER,
  scopes: ['atproto'],
  clients: [{ client_id: `${ISSUER}/oauth-client-metadata.json`, client_name: 'test', scope: 'atproto' }],
} as any

interface Call {
  url: string
  init?: RequestInit
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const headersOf = (call: Call) => call.init?.headers as Record<string, string>
const proofOf = (call: Call) => parseJwt(headersOf(call).DPoP).payload
const jsonBodyOf = (call: Call) => JSON.parse(String(call.init?.body))

/**
 * Answer every PDS call with `handler` (n counts PDS calls only); the token
 * endpoint mints `at-new` unless `tokenResponse` says otherwise.
 */
function stubPds(
  handler: (url: string, init: RequestInit | undefined, n: number) => Response,
  tokenResponse: () => Response = () => json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
) {
  const calls: Call[] = []
  let n = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === TOKEN) return tokenResponse()
      return handler(url, init, ++n)
    }),
  )
  return calls
}

const pdsCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith(PDS))

const record = { $type: PUBLIC_COLLECTION, text: 'hello' }
const created = { uri: `at://${DID}/${PUBLIC_COLLECTION}/self`, cid: 'bafy-created' }

beforeAll(async () => {
  await setupFixtureDatabase()
  storeLexicons(fixtureLexicons())
  for (const stmt of OAUTH_DDL.split(';')) {
    if (stmt.trim()) await runSQL(stmt)
  }
  await initOAuth(config, 'http://plc.test', 'ws://relay.test')
})

beforeEach(async () => {
  await runSQL(`DELETE FROM "${PUBLIC_COLLECTION}"`)
  await runSQL('DELETE FROM _oauth_sessions')
  await storeSession(DID, {
    pdsEndpoint: PDS,
    pdsAuthServer: AUTH,
    pdsTokenEndpoint: TOKEN,
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    dpopJkt: 'jkt',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pdsXrpc', () => {
  test('a query is a GET with the params in the URL and no body', async () => {
    const calls = stubPds(() => json({ repos: [] }))

    const result = await pdsXrpc(config, viewer, 'com.atproto.space.listRepos', {
      params: { limit: 10, cursor: undefined, tags: ['a', 'b'], deep: true },
    })

    expect(result).toEqual({ repos: [] })
    const [call] = pdsCalls(calls)
    const url = new URL(call.url)
    expect(url.origin + url.pathname).toBe(`${PDS}/xrpc/com.atproto.space.listRepos`)
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.get('deep')).toBe('true')
    // Undefined is dropped; an array repeats the key.
    expect(url.searchParams.has('cursor')).toBe(false)
    expect(url.searchParams.getAll('tags')).toEqual(['a', 'b'])
    expect(call.init?.method).toBe('GET')
    expect(call.init?.body).toBeUndefined()
    // No content-type without a body: some servers try to parse the nothing.
    expect(headersOf(call)['Content-Type']).toBeUndefined()
  })

  test('the request carries the session token and a proof bound to it', async () => {
    const calls = stubPds(() => json({}))

    await pdsXrpc(config, viewer, 'com.atproto.space.listRepos', { params: { x: '1' } })

    const [call] = pdsCalls(calls)
    expect(headersOf(call).Authorization).toBe('DPoP at-old')
    const proof = proofOf(call)
    expect(proof.htm).toBe('GET')
    // htu is the URL without its query.
    expect(proof.htu).toBe(`${PDS}/xrpc/com.atproto.space.listRepos`)
    expect(proof.ath).toBe(base64UrlEncode(await sha256('at-old')))
  })

  test('a procedure is a POST with a JSON body', async () => {
    const calls = stubPds(() => json({ ok: true }))

    await pdsXrpc(config, viewer, 'com.atproto.space.createSpace', { method: 'POST', body: { name: 'x' } })

    const [call] = pdsCalls(calls)
    expect(call.init?.method).toBe('POST')
    expect(headersOf(call)['Content-Type']).toBe('application/json')
    expect(jsonBodyOf(call)).toEqual({ name: 'x' })
    expect(proofOf(call).htm).toBe('POST')
  })

  test('a refusal is a ProxyError with the PDS status and error name', async () => {
    stubPds(() => json({ error: 'NotFound', message: 'no such space' }, 404))

    await expect(pdsXrpc(config, viewer, 'com.atproto.space.getSpace')).rejects.toMatchObject({
      status: 404,
      message: 'NotFound',
    })
  })

  test('a refusal with no error name is described by the method', async () => {
    stubPds(() => new Response('not json', { status: 500 }))

    await expect(pdsXrpc(config, viewer, 'com.atproto.space.getSpace')).rejects.toMatchObject({
      status: 500,
      message: 'com.atproto.space.getSpace failed',
    })
  })

  test('a user with no PDS session is refused before any request', async () => {
    const calls = stubPds(() => json({}))

    await expect(pdsXrpc(config, { did: 'did:plc:stranger' }, 'x.y.z')).rejects.toMatchObject({
      status: 401,
      message: 'No PDS session for user',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('token refresh on the way through', () => {
  test('an expired token is refreshed once and the call replayed with the new one', async () => {
    const calls = stubPds((_url, init, n) =>
      n === 1 ? json({ error: 'ExpiredToken' }, 401) : json({ token: (init!.headers as any).Authorization }),
    )

    const result = await pdsXrpc(config, viewer, 'com.atproto.space.listRepos')

    expect(result).toEqual({ token: 'DPoP at-new' })
    expect(calls.map((c) => c.url)).toEqual([
      `${PDS}/xrpc/com.atproto.space.listRepos`,
      TOKEN,
      `${PDS}/xrpc/com.atproto.space.listRepos`,
    ])
    // The proof for the replay hashes the new token, not the old.
    expect(proofOf(pdsCalls(calls)[1]).ath).toBe(base64UrlEncode(await sha256('at-new')))
    expect((await getSession(DID)).access_token).toBe('at-new')
  })

  test('a nonce challenge after the refresh is still answered', async () => {
    const calls = stubPds((_url, _init, n) => {
      if (n === 1) return json({ error: 'InvalidToken' }, 401)
      if (n === 2) return json({ error: 'use_dpop_nonce' }, 401, { 'DPoP-Nonce': 'n-2' })
      return json({ fine: true })
    })

    expect(await pdsXrpc(config, viewer, 'com.atproto.space.listRepos')).toEqual({ fine: true })
    const pds = pdsCalls(calls)
    expect(pds).toHaveLength(3)
    expect(proofOf(pds[2]).nonce).toBe('n-2')
  })

  test('a PDS that names a missing scope ends the session and says so', async () => {
    // Re-authorizing is the only fix; a stale grant must not linger.
    stubPds(() => json({ error: 'ScopeMissingError' }, 403))

    await expect(pdsXrpc(config, viewer, 'com.atproto.space.listRepos')).rejects.toBeInstanceOf(ScopeMissingProxyError)
    expect(await getSession(DID)).toBeNull()
  })

  test('a token refused again straight after minting is read as a scope problem', async () => {
    stubPds(() => json({ error: 'InvalidToken' }, 401))

    await expect(pdsXrpc(config, viewer, 'com.atproto.space.listRepos')).rejects.toMatchObject({
      status: 401,
      message: 'ScopeMissingError',
    })
    expect(await getSession(DID)).toBeNull()
  })

  test('a refresh the auth server refuses surfaces the original refusal', async () => {
    const calls = stubPds(
      () => json({ error: 'ExpiredToken' }, 401),
      () => json({ error: 'invalid_grant' }, 400),
    )

    await expect(pdsXrpc(config, viewer, 'com.atproto.space.listRepos')).rejects.toMatchObject({
      status: 401,
      message: 'ExpiredToken',
    })
    // No replay without a new token, and the failed refresh already dropped the session.
    expect(pdsCalls(calls)).toHaveLength(1)
    expect(await getSession(DID)).toBeNull()
  })
})

describe('pdsCreateRecord', () => {
  test('forwards the record as the viewer and indexes what the PDS returns', async () => {
    const calls = stubPds(() => json(created))

    const result = await pdsCreateRecord(config, viewer, { collection: PUBLIC_COLLECTION, record, rkey: 'self' })

    expect(result).toEqual(created)
    const [call] = pdsCalls(calls)
    expect(call.url).toBe(`${PDS}/xrpc/com.atproto.repo.createRecord`)
    expect(jsonBodyOf(call)).toEqual({ repo: DID, collection: PUBLIC_COLLECTION, rkey: 'self', record })

    const rows = (await querySQL(`SELECT uri, cid, did, text FROM "${PUBLIC_COLLECTION}"`)) as any[]
    expect(rows).toEqual([{ uri: created.uri, cid: created.cid, did: DID, text: 'hello' }])
  })

  test('an invalid record is refused locally before the PDS sees it', async () => {
    const calls = stubPds(() => json(created))

    await expect(
      pdsCreateRecord(config, viewer, { collection: PUBLIC_COLLECTION, record: { $type: PUBLIC_COLLECTION } }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^InvalidRecord: /) })
    expect(calls).toHaveLength(0)
  })

  test('a PDS refusal is passed through and nothing is indexed', async () => {
    stubPds(() => json({ error: 'InvalidSwap' }, 400))

    await expect(pdsCreateRecord(config, viewer, { collection: PUBLIC_COLLECTION, record })).rejects.toMatchObject({
      status: 400,
      message: 'InvalidSwap',
    })
    expect(await querySQL(`SELECT 1 FROM "${PUBLIC_COLLECTION}"`)).toHaveLength(0)
  })

  test('a local index failure does not fail the write the PDS accepted', async () => {
    // The PDS is the source of truth; the firehose will bring the row later.
    stubPds(() => json({ uri: created.uri, cid: created.cid }))
    const collection = 'app.bsky.feed.post'
    storeLexicons(
      new Map([
        [
          collection,
          {
            lexicon: 1,
            id: collection,
            defs: { main: { type: 'record', key: 'tid', record: { type: 'object', properties: {} } } },
          },
        ],
      ]),
    )

    // No table exists for this collection, so insertRecord cannot succeed.
    await expect(pdsCreateRecord(config, viewer, { collection, record: { $type: collection } })).resolves.toEqual(
      created,
    )
  })
})

describe('pdsPutRecord', () => {
  test('forwards to putRecord and replaces the local row', async () => {
    await insertRecord(PUBLIC_COLLECTION, created.uri, 'bafy-old', DID, { ...record, text: 'old' })
    const calls = stubPds(() => json(created))

    await pdsPutRecord(config, viewer, { collection: PUBLIC_COLLECTION, rkey: 'self', record })

    const [call] = pdsCalls(calls)
    expect(call.url).toBe(`${PDS}/xrpc/com.atproto.repo.putRecord`)
    expect(jsonBodyOf(call)).toEqual({ repo: DID, collection: PUBLIC_COLLECTION, rkey: 'self', record })
    const rows = (await querySQL(`SELECT cid, text FROM "${PUBLIC_COLLECTION}"`)) as any[]
    expect(rows).toEqual([{ cid: created.cid, text: 'hello' }])
  })

  test('an invalid record is refused locally', async () => {
    const calls = stubPds(() => json(created))
    await expect(
      pdsPutRecord(config, viewer, {
        collection: PUBLIC_COLLECTION,
        rkey: 'self',
        record: { $type: PUBLIC_COLLECTION },
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })

  test('a PDS refusal is passed through', async () => {
    stubPds(() => json({}, 502))
    await expect(
      pdsPutRecord(config, viewer, { collection: PUBLIC_COLLECTION, rkey: 'self', record }),
    ).rejects.toMatchObject({ status: 502, message: 'PDS write failed' })
  })
})

describe('pdsDeleteRecord', () => {
  test('forwards to deleteRecord and drops the local row', async () => {
    await insertRecord(PUBLIC_COLLECTION, created.uri, created.cid, DID, record)
    const calls = stubPds(() => json({}))

    await pdsDeleteRecord(config, viewer, { collection: PUBLIC_COLLECTION, rkey: 'self' })

    const [call] = pdsCalls(calls)
    expect(call.url).toBe(`${PDS}/xrpc/com.atproto.repo.deleteRecord`)
    expect(jsonBodyOf(call)).toEqual({ repo: DID, collection: PUBLIC_COLLECTION, rkey: 'self' })
    expect(await querySQL(`SELECT 1 FROM "${PUBLIC_COLLECTION}"`)).toHaveLength(0)
  })

  test('a PDS refusal keeps the local row', async () => {
    await insertRecord(PUBLIC_COLLECTION, created.uri, created.cid, DID, record)
    stubPds(() => json({ error: 'RecordNotFound' }, 400))

    await expect(
      pdsDeleteRecord(config, viewer, { collection: PUBLIC_COLLECTION, rkey: 'self' }),
    ).rejects.toMatchObject({ status: 400, message: 'RecordNotFound' })
    expect(await querySQL(`SELECT 1 FROM "${PUBLIC_COLLECTION}"`)).toHaveLength(1)
  })
})

describe('pdsApplyWrites', () => {
  const uriOf = (rkey: string) => `at://${DID}/${PUBLIC_COLLECTION}/${rkey}`

  test('maps hatk write types to atproto ones and indexes each result by kind', async () => {
    await insertRecord(PUBLIC_COLLECTION, uriOf('upd'), 'bafy-upd-old', DID, { ...record, text: 'before' })
    await insertRecord(PUBLIC_COLLECTION, uriOf('del'), 'bafy-del', DID, record)
    const calls = stubPds(() =>
      json({
        results: [
          { $type: 'com.atproto.repo.applyWrites#createResult', uri: uriOf('new'), cid: 'bafy-new' },
          { $type: 'com.atproto.repo.applyWrites#updateResult', uri: uriOf('upd'), cid: 'bafy-upd-new' },
          { $type: 'com.atproto.repo.applyWrites#deleteResult' },
        ],
      }),
    )

    await pdsApplyWrites(config, viewer, {
      writes: [
        { $type: 'dev.hatk.applyWrites#create', collection: PUBLIC_COLLECTION, rkey: 'new', value: record },
        {
          $type: 'dev.hatk.applyWrites#update',
          collection: PUBLIC_COLLECTION,
          rkey: 'upd',
          value: { ...record, text: 'after' },
        },
        { $type: 'dev.hatk.applyWrites#delete', collection: PUBLIC_COLLECTION, rkey: 'del' },
      ],
    })

    const [call] = pdsCalls(calls)
    expect(call.url).toBe(`${PDS}/xrpc/com.atproto.repo.applyWrites`)
    const body = jsonBodyOf(call)
    expect(body.repo).toBe(DID)
    expect(body.writes.map((w: any) => w.$type)).toEqual([
      'com.atproto.repo.applyWrites#create',
      'com.atproto.repo.applyWrites#update',
      'com.atproto.repo.applyWrites#delete',
    ])

    const rows = (await querySQL(`SELECT uri, cid, text FROM "${PUBLIC_COLLECTION}" ORDER BY uri`)) as any[]
    expect(rows).toEqual([
      { uri: uriOf('new'), cid: 'bafy-new', text: 'hello' },
      { uri: uriOf('upd'), cid: 'bafy-upd-new', text: 'after' },
    ])
  })

  test('atproto-spelled write types pass through unchanged', async () => {
    const calls = stubPds(() => json({ results: [] }))

    await pdsApplyWrites(config, viewer, {
      writes: [{ $type: 'com.atproto.repo.applyWrites#create', collection: PUBLIC_COLLECTION, value: record }],
    })

    expect(jsonBodyOf(pdsCalls(calls)[0]).writes[0].$type).toBe('com.atproto.repo.applyWrites#create')
  })

  test('one invalid record refuses the whole batch before the PDS sees it', async () => {
    const calls = stubPds(() => json({ results: [] }))

    await expect(
      pdsApplyWrites(config, viewer, {
        writes: [
          { $type: 'dev.hatk.applyWrites#create', collection: PUBLIC_COLLECTION, value: record },
          { $type: 'dev.hatk.applyWrites#create', collection: PUBLIC_COLLECTION, value: { $type: PUBLIC_COLLECTION } },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^InvalidRecord/) })
    expect(calls).toHaveLength(0)
  })

  test('a PDS refusal is passed through', async () => {
    stubPds(() => json({ error: 'InvalidSwap' }, 400))
    await expect(
      pdsApplyWrites(config, viewer, {
        writes: [{ $type: 'dev.hatk.applyWrites#delete', collection: PUBLIC_COLLECTION, rkey: 'x' }],
      }),
    ).rejects.toMatchObject({ status: 400, message: 'InvalidSwap' })
  })

  test('a result without a uri is not indexed', async () => {
    stubPds(() => json({ results: [{ $type: 'com.atproto.repo.applyWrites#createResult' }] }))

    await pdsApplyWrites(config, viewer, {
      writes: [{ $type: 'dev.hatk.applyWrites#create', collection: PUBLIC_COLLECTION, value: record }],
    })

    expect(await querySQL(`SELECT 1 FROM "${PUBLIC_COLLECTION}"`)).toHaveLength(0)
  })
})

describe('pdsUploadBlob', () => {
  test('streams the bytes with their content type and length', async () => {
    const blob = { $type: 'blob', ref: { $link: 'bafy-blob' }, mimeType: 'image/png', size: 3 }
    const calls = stubPds(() => json({ blob }))
    const bytes = new Uint8Array([1, 2, 3])

    expect(await pdsUploadBlob(config, viewer, bytes, 'image/png')).toEqual({ blob })

    const [call] = pdsCalls(calls)
    expect(call.url).toBe(`${PDS}/xrpc/com.atproto.repo.uploadBlob`)
    expect(call.init?.method).toBe('POST')
    expect(headersOf(call)['Content-Type']).toBe('image/png')
    expect(headersOf(call)['Content-Length']).toBe('3')
    expect(headersOf(call).Authorization).toBe('DPoP at-old')
    expect(new Uint8Array(call.init?.body as Buffer)).toEqual(bytes)
    expect(proofOf(call).htu).toBe(`${PDS}/xrpc/com.atproto.repo.uploadBlob`)
  })

  test('a refused upload is a ProxyError', async () => {
    stubPds(() => json({ error: 'BlobTooLarge' }, 413))
    await expect(pdsUploadBlob(config, viewer, new Uint8Array(1), 'image/png')).rejects.toMatchObject({
      status: 413,
      message: 'BlobTooLarge',
    })
  })

  test('an upload also goes through the token refresh path', async () => {
    const calls = stubPds((_url, _init, n) => (n === 1 ? json({ error: 'ExpiredToken' }, 401) : json({ blob: {} })))

    await pdsUploadBlob(config, viewer, new Uint8Array(1), 'image/png')

    expect(calls.map((c) => c.url)).toContain(TOKEN)
    expect(headersOf(pdsCalls(calls)[1]).Authorization).toBe('DPoP at-new')
  })

  test('no session means no upload', async () => {
    await expect(
      pdsUploadBlob(config, { did: 'did:plc:nobody' }, new Uint8Array(1), 'image/png'),
    ).rejects.toBeInstanceOf(ProxyError)
  })
})
