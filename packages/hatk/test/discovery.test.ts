import { afterEach, describe, expect, test, vi } from 'vitest'

// Handle resolution asks DNS first. Nothing resolves unless a test says so,
// and no test reaches a real resolver.
const dns = vi.hoisted(() => ({
  resolveTxt: vi.fn(async (): Promise<string[][]> => {
    throw new Error('ENOTFOUND')
  }),
}))
vi.mock('node:dns/promises', () => dns)
import {
  discoverAuthServer,
  fetchAuthServerMetadata,
  fetchProtectedResourceMetadata,
  getPdsEndpoint,
  resolveDid,
  resolveHandle,
} from '../src/oauth/discovery.ts'

// Discovery is three hops of unauthenticated fetches — DID document, protected
// resource metadata, auth server metadata — and a login can only go as far as
// the first one that answers wrongly. These pin which URL each hop asks and
// what each refuses to accept.

const PLC = 'https://plc.test'
const PDS = 'https://pds.example.com'
const AUTH = 'https://auth.example.com'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Route each URL to a canned response and record what was asked. */
function stubRoutes(routes: Record<string, Response | (() => Response)>) {
  const seen: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      seen.push(url)
      const hit = routes[url]
      if (!hit) return new Response('not stubbed: ' + url, { status: 599 })
      return typeof hit === 'function' ? hit() : hit
    }),
  )
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveDid', () => {
  test('a did:plc is looked up at the PLC directory', async () => {
    const doc = { id: 'did:plc:abc' }
    const seen = stubRoutes({ [`${PLC}/did:plc:abc`]: json(doc) })

    expect(await resolveDid('did:plc:abc', PLC)).toEqual(doc)
    expect(seen).toEqual([`${PLC}/did:plc:abc`])
  })

  test('a did:web is fetched from the domain it names, never the PLC', async () => {
    const doc = { id: 'did:web:alice.example' }
    const seen = stubRoutes({ 'https://alice.example/.well-known/did.json': json(doc) })

    expect(await resolveDid('did:web:alice.example', PLC)).toEqual(doc)
    expect(seen.some((u) => u.startsWith(PLC))).toBe(false)
  })

  test('a PLC miss is an error naming the status', async () => {
    stubRoutes({ [`${PLC}/did:plc:gone`]: json({ message: 'not found' }, 404) })

    await expect(resolveDid('did:plc:gone', PLC)).rejects.toThrow(/PLC resolution failed: 404/)
  })

  test('a did:web miss is an error naming the status', async () => {
    stubRoutes({ 'https://nope.example/.well-known/did.json': new Response('', { status: 500 }) })

    await expect(resolveDid('did:web:nope.example', PLC)).rejects.toThrow(/did:web resolution failed: 500/)
  })
})

describe('getPdsEndpoint', () => {
  test('finds the PDS by the conventional service id', () => {
    const doc = { service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] }
    expect(getPdsEndpoint(doc)).toBe(PDS)
  })

  test('falls back to the service type when the id is unconventional', () => {
    // Some DID documents name the service differently but type it correctly.
    const doc = { service: [{ id: '#pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] }
    expect(getPdsEndpoint(doc)).toBe(PDS)
  })

  test('ignores unrelated services', () => {
    const doc = { service: [{ id: '#atproto_labeler', type: 'AtprotoLabeler', serviceEndpoint: 'https://mod' }] }
    expect(getPdsEndpoint(doc)).toBeNull()
  })

  test('a document with no services yields null rather than throwing', () => {
    expect(getPdsEndpoint({})).toBeNull()
  })
})

describe('protected resource and auth server metadata', () => {
  test('the protected resource document is read from the PDS well-known path', async () => {
    const seen = stubRoutes({
      [`${PDS}/.well-known/oauth-protected-resource`]: json({ authorization_servers: [AUTH] }),
    })

    expect(await fetchProtectedResourceMetadata(PDS)).toEqual({ authorization_servers: [AUTH] })
    expect(seen).toEqual([`${PDS}/.well-known/oauth-protected-resource`])
  })

  test('a PDS without the document fails loudly', async () => {
    stubRoutes({ [`${PDS}/.well-known/oauth-protected-resource`]: new Response('', { status: 404 }) })

    await expect(fetchProtectedResourceMetadata(PDS)).rejects.toThrow(/Protected resource metadata failed: 404/)
  })

  test('auth server metadata is read from its well-known path', async () => {
    const meta = { issuer: AUTH, authorization_endpoint: `${AUTH}/a`, token_endpoint: `${AUTH}/t` }
    const seen = stubRoutes({ [`${AUTH}/.well-known/oauth-authorization-server`]: json(meta) })

    expect(await fetchAuthServerMetadata(AUTH)).toEqual(meta)
    expect(seen).toEqual([`${AUTH}/.well-known/oauth-authorization-server`])
  })

  test('an auth server that refuses the metadata request fails loudly', async () => {
    stubRoutes({ [`${AUTH}/.well-known/oauth-authorization-server`]: new Response('', { status: 503 }) })

    await expect(fetchAuthServerMetadata(AUTH)).rejects.toThrow(/Auth server metadata failed: 503/)
  })
})

describe('discoverAuthServer', () => {
  const didDoc = { service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] }
  const meta = { issuer: AUTH, authorization_endpoint: `${AUTH}/a`, token_endpoint: `${AUTH}/t` }

  test('walks DID document, protected resource, and auth server metadata in order', async () => {
    const seen = stubRoutes({
      [`${PLC}/did:plc:abc`]: json(didDoc),
      [`${PDS}/.well-known/oauth-protected-resource`]: json({ authorization_servers: [AUTH] }),
      [`${AUTH}/.well-known/oauth-authorization-server`]: json(meta),
    })

    const result = await discoverAuthServer('did:plc:abc', PLC)

    expect(result).toEqual({ pdsEndpoint: PDS, authServerEndpoint: AUTH, authServerMetadata: meta })
    // The order matters: each hop's URL comes from the previous answer.
    expect(seen).toEqual([
      `${PLC}/did:plc:abc`,
      `${PDS}/.well-known/oauth-protected-resource`,
      `${AUTH}/.well-known/oauth-authorization-server`,
    ])
  })

  test('a DID document without a PDS stops before asking anything else', async () => {
    const seen = stubRoutes({ [`${PLC}/did:plc:nopds`]: json({ service: [] }) })

    await expect(discoverAuthServer('did:plc:nopds', PLC)).rejects.toThrow(/No PDS endpoint in DID document/)
    expect(seen).toHaveLength(1)
  })

  test('a PDS that names no authorization server is an error, not undefined', async () => {
    stubRoutes({
      [`${PLC}/did:plc:abc`]: json(didDoc),
      [`${PDS}/.well-known/oauth-protected-resource`]: json({ authorization_servers: [] }),
    })

    await expect(discoverAuthServer('did:plc:abc', PLC)).rejects.toThrow(/No auth server for PDS/)
  })
})

describe('resolveHandle', () => {
  const answer = () => json({ did: 'did:plc:resolved' })
  const path = '/xrpc/com.atproto.identity.resolveHandle?handle=alice.test'
  const wellKnown = 'https://alice.test/.well-known/atproto-did'

  afterEach(() => {
    dns.resolveTxt.mockReset()
    dns.resolveTxt.mockImplementation(async () => {
      throw new Error('ENOTFOUND')
    })
  })

  test('a DNS TXT record answers first, and nothing else is asked', async () => {
    dns.resolveTxt.mockResolvedValueOnce([['did=did:plc:fromdns']])
    const seen = stubRoutes({})

    expect(await resolveHandle('alice.test', 'wss://bsky.network')).toBe('did:plc:fromdns')
    expect(dns.resolveTxt).toHaveBeenCalledWith('_atproto.alice.test')
    expect(seen).toEqual([])
  })

  test('the well-known document answers when DNS has nothing', async () => {
    // A handle on any PDS resolves this way — including one on another host
    // than the relay this instance tails.
    const seen = stubRoutes({ [wellKnown]: new Response('did:plc:fromwellknown\n', { status: 200 }) })

    expect(await resolveHandle('alice.test', 'wss://host.example')).toBe('did:plc:fromwellknown')
    expect(seen).toEqual([wellKnown])
  })

  test('a well-known body that is not a DID is ignored', async () => {
    const seen = stubRoutes({
      [wellKnown]: new Response('<html>parked</html>', { status: 200 }),
      [`https://bsky.social${path}`]: answer,
    })

    expect(await resolveHandle('alice.test', 'wss://bsky.network')).toBe('did:plc:resolved')
    expect(seen).toEqual([wellKnown, `https://bsky.social${path}`])
  })

  test('with neither, the local dev PDS is asked when the relay is the localhost one', async () => {
    const seen = stubRoutes({ [`http://localhost:2583${path}`]: answer })

    expect(await resolveHandle('alice.test', 'ws://localhost:2583')).toBe('did:plc:resolved')
    expect(seen).toEqual([wellKnown, `http://localhost:2583${path}`])
  })

  test('with neither, bsky.social is asked for the public relay', async () => {
    const seen = stubRoutes({ [`https://bsky.social${path}`]: answer })

    expect(await resolveHandle('alice.test', 'wss://bsky.network')).toBe('did:plc:resolved')
    expect(seen).toEqual([wellKnown, `https://bsky.social${path}`])
  })

  test('with neither and no relay configured, bsky.social is the default', async () => {
    const seen = stubRoutes({ [`https://bsky.social${path}`]: answer })

    expect(await resolveHandle('alice.test')).toBe('did:plc:resolved')
    expect(seen).toEqual([wellKnown, `https://bsky.social${path}`])
  })

  test('with neither, a self-hosted relay is asked over HTTP at the same host', async () => {
    const seen = stubRoutes({ [`https://pds.preview.example${path}`]: answer })

    expect(await resolveHandle('alice.test', 'wss://pds.preview.example')).toBe('did:plc:resolved')
    expect(seen).toEqual([wellKnown, `https://pds.preview.example${path}`])
  })

  test('the handle is URL-encoded on the PDS fallback', async () => {
    const seen = stubRoutes({})
    await resolveHandle('a b&c', 'wss://bsky.network').catch(() => {})

    expect(seen.at(-1)).toContain('handle=a%20b%26c')
  })

  test('an unresolvable handle is an error naming the status', async () => {
    stubRoutes({ [`https://bsky.social${path}`]: json({ error: 'InvalidRequest' }, 400) })

    await expect(resolveHandle('alice.test', 'wss://bsky.network')).rejects.toThrow(/resolveHandle failed: 400/)
  })
})
