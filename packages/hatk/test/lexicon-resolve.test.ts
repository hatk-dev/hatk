import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resolveLexicon } from '../src/lexicon-resolve.ts'

// `hatk add <nsid>` resolves a lexicon through the registry chain the protocol
// defines: `_lexicon.<authority>` TXT record → DID → PDS → getRecord on
// `com.atproto.lexicon.schema`. Every hop can be missing or malformed, and each
// miss must yield "unresolved" rather than a thrown error, so the CLI can report
// which schema it could not find. All of it goes through a scripted fetch here.

const DOH = 'https://cloudflare-dns.com/dns-query'
const PLC = 'https://plc.directory'

interface Registry {
  /** authority domain → TXT record data strings, as DoH returns them (quoted) */
  txt: Record<string, string[]>
  /** did → PDS endpoint (or null for a DID doc without one) */
  pds: Record<string, string | null>
  /** nsid → lexicon document */
  schemas: Record<string, any>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A fetch that plays the DoH resolver, PLC directory, did:web hosts, and PDSes at once. */
function stubRegistry(reg: Registry) {
  const calls: string[] = []
  const fetchFn = vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push(url)
    const u = new URL(url)

    if (url.startsWith(DOH)) {
      const name = u.searchParams.get('name')!
      const domain = name.replace(/^_lexicon\./, '')
      const records = reg.txt[domain]
      if (!records) return json({ Status: 3 })
      return json({
        Status: 0,
        Answer: [
          // A CNAME in the answer section must be ignored, only TXT counts
          { name, type: 5, data: 'alias.example.' },
          ...records.map((data) => ({ name, type: 16, data })),
        ],
      })
    }

    if (url.startsWith(`${PLC}/`)) {
      const did = decodeURIComponent(u.pathname.slice(1))
      if (!(did in reg.pds)) return json({ message: 'not found' }, 404)
      return json(didDoc(did, reg.pds[did]))
    }

    if (u.pathname === '/.well-known/did.json') {
      const did = `did:web:${u.host}`
      if (!(did in reg.pds)) return json({}, 404)
      return json(didDoc(did, reg.pds[did]))
    }

    if (u.pathname === '/xrpc/com.atproto.repo.getRecord') {
      expect(u.searchParams.get('collection')).toBe('com.atproto.lexicon.schema')
      const nsid = u.searchParams.get('rkey')!
      if (!(nsid in reg.schemas)) return json({ error: 'RecordNotFound' }, 400)
      const schema = reg.schemas[nsid]
      const uri = `at://${u.searchParams.get('repo')}/com.atproto.lexicon.schema/${nsid}`
      // `null` stands in for a PDS that answers 200 with a record but no value
      return json(schema === null ? { uri } : { uri, value: schema })
    }

    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchFn)
  return { fetchFn, calls }
}

function didDoc(did: string, pds: string | null) {
  return {
    id: did,
    service: pds ? [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] : [],
  }
}

function lexicon(id: string, main: any, extra: Record<string, any> = {}) {
  return { lexicon: 1, id, defs: { main, ...extra } }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('resolves a lexicon through DNS, PLC and the PDS getRecord endpoint', async () => {
  const schema = lexicon('xyz.market.listing', {
    type: 'record',
    key: 'tid',
    record: { type: 'object', properties: { title: { type: 'string' } } },
  })
  const { calls } = stubRegistry({
    txt: { 'market.xyz': ['"did=did:plc:market"'] },
    pds: { 'did:plc:market': 'https://pds.market.xyz' },
    schemas: { 'xyz.market.listing': schema },
  })

  const resolved = await resolveLexicon('xyz.market.listing')

  expect(Array.from(resolved.keys())).toEqual(['xyz.market.listing'])
  expect(resolved.get('xyz.market.listing')).toEqual(schema)
  // The authority for xyz.market.* is market.xyz, and the TXT lives under _lexicon.
  expect(calls[0]).toContain(`name=${encodeURIComponent('_lexicon.market.xyz')}`)
  expect(calls[0]).toContain('type=TXT')
  expect(calls[1]).toBe(`${PLC}/did:plc:market`)
  expect(calls[2]).toBe(
    'https://pds.market.xyz/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Amarket&collection=com.atproto.lexicon.schema&rkey=xyz.market.listing',
  )
})

test('follows ref and union refs into other lexicons, once each', async () => {
  const post = lexicon('xyz.market.post', {
    type: 'record',
    record: {
      type: 'object',
      properties: {
        // #local refs must not trigger a fetch; lex:-prefixed ones are normalized
        author: { type: 'ref', ref: 'lex:xyz.market.actor#profile' },
        self: { type: 'ref', ref: '#facet' },
        embed: { type: 'union', refs: ['xyz.market.image', 'xyz.market.actor'] },
      },
    },
  })
  const actor = lexicon('xyz.market.actor', { type: 'object', properties: {} }, { profile: { type: 'object' } })
  const image = lexicon('xyz.market.image', {
    type: 'object',
    properties: { by: { type: 'ref', ref: 'xyz.market.actor' } },
  })
  const { calls } = stubRegistry({
    txt: { 'market.xyz': ['"did=did:plc:market"'] },
    pds: { 'did:plc:market': 'https://pds.market.xyz' },
    schemas: { 'xyz.market.post': post, 'xyz.market.actor': actor, 'xyz.market.image': image },
  })

  const resolved = await resolveLexicon('xyz.market.post')

  expect(Array.from(resolved.keys()).sort()).toEqual(['xyz.market.actor', 'xyz.market.image', 'xyz.market.post'])
  const fetched = calls.filter((c) => c.includes('getRecord')).map((c) => new URL(c).searchParams.get('rkey'))
  expect(fetched.sort()).toEqual(['xyz.market.actor', 'xyz.market.image', 'xyz.market.post'])
})

test('serves built-in core schemas without touching the network, and follows their refs', async () => {
  const { fetchFn } = stubRegistry({ txt: {}, pds: {}, schemas: {} })

  // dev.hatk.createReport unions over com.atproto.repo.strongRef, also built in
  const resolved = await resolveLexicon('dev.hatk.createReport')

  expect(resolved.has('dev.hatk.createReport')).toBe(true)
  expect(resolved.has('com.atproto.repo.strongRef')).toBe(true)
  expect(resolved.get('com.atproto.repo.strongRef')?.id).toBe('com.atproto.repo.strongRef')
  expect(fetchFn).not.toHaveBeenCalled()
})

test('resolves a did:web authority from its well-known DID document', async () => {
  const schema = lexicon('com.example.thing', { type: 'object', properties: {} })
  const { calls } = stubRegistry({
    txt: { 'example.com': ['"did=did:web:id.example.com"'] },
    pds: { 'did:web:id.example.com': 'https://pds.example.com' },
    schemas: { 'com.example.thing': schema },
  })

  const resolved = await resolveLexicon('com.example.thing')
  expect(resolved.get('com.example.thing')).toEqual(schema)
  expect(calls).toContain('https://id.example.com/.well-known/did.json')
})

test('skips TXT records that are not a valid did= entry and uses the first that is', async () => {
  const schema = lexicon('com.example.thing', { type: 'object', properties: {} })
  stubRegistry({
    txt: {
      'example.com': ['"v=spf1 -all"', '"did=not a did"', '"did=did:plc:good"'],
    },
    pds: { 'did:plc:good': 'https://pds.example.com' },
    schemas: { 'com.example.thing': schema },
  })
  expect((await resolveLexicon('com.example.thing')).size).toBe(1)
})

test('returns an empty map when the authority has no _lexicon TXT record', async () => {
  const { calls } = stubRegistry({ txt: {}, pds: {}, schemas: {} })
  const resolved = await resolveLexicon('com.nowhere.thing')
  expect(resolved.size).toBe(0)
  expect(calls).toHaveLength(1)
})

test('returns an empty map when the TXT record names a DID method it cannot resolve', async () => {
  // did:key is a valid DID syntactically but has no document to fetch a PDS from
  const { calls } = stubRegistry({ txt: { 'example.com': ['"did=did:key:z6Mk"'] }, pds: {}, schemas: {} })
  expect((await resolveLexicon('com.example.thing')).size).toBe(0)
  expect(calls).toHaveLength(1)
})

test('returns an empty map when the DID document is missing or has no PDS service', async () => {
  stubRegistry({
    txt: { 'example.com': ['"did=did:plc:gone"'], 'other.com': ['"did=did:plc:nopds"'] },
    pds: { 'did:plc:nopds': null },
    schemas: {},
  })
  expect((await resolveLexicon('com.example.thing')).size).toBe(0)
  expect((await resolveLexicon('com.other.thing')).size).toBe(0)
})

test('returns an empty map when the PDS has no schema record for the nsid', async () => {
  stubRegistry({
    txt: { 'example.com': ['"did=did:plc:ok"'] },
    pds: { 'did:plc:ok': 'https://pds.example.com' },
    schemas: {},
  })
  expect((await resolveLexicon('com.example.missing')).size).toBe(0)
})

test('a resolvable root still resolves when one of its refs cannot be found', async () => {
  const root = lexicon('com.example.root', {
    type: 'object',
    properties: { x: { type: 'ref', ref: 'com.example.missing' } },
  })
  stubRegistry({
    txt: { 'example.com': ['"did=did:plc:ok"'] },
    pds: { 'did:plc:ok': 'https://pds.example.com' },
    schemas: { 'com.example.root': root },
  })
  const resolved = await resolveLexicon('com.example.root')
  expect(Array.from(resolved.keys())).toEqual(['com.example.root'])
})

test('a DoH resolver error or malformed answer is treated as no record', async () => {
  const fetchFn = vi.fn(async (url: string) => {
    if (url.startsWith(DOH)) return new Response('upstream down', { status: 503 })
    throw new Error('should not get past DNS')
  })
  vi.stubGlobal('fetch', fetchFn)
  expect((await resolveLexicon('com.example.thing')).size).toBe(0)

  const noAnswer = vi.fn(async () => json({ Status: 0 }))
  vi.stubGlobal('fetch', noAnswer)
  expect((await resolveLexicon('com.example.thing')).size).toBe(0)

  const network = vi.fn(async () => {
    throw new TypeError('fetch failed')
  })
  vi.stubGlobal('fetch', network)
  expect((await resolveLexicon('com.example.thing')).size).toBe(0)
})

test('a network failure while fetching the DID document resolves to nothing rather than throwing', async () => {
  const fetchFn = vi.fn(async (url: string) => {
    if (url.startsWith(DOH)) return json({ Answer: [{ type: 16, data: '"did=did:plc:flaky"' }] })
    throw new TypeError('fetch failed')
  })
  vi.stubGlobal('fetch', fetchFn)
  expect((await resolveLexicon('com.example.thing')).size).toBe(0)
})

test('a getRecord reply with no value is treated as unresolved', async () => {
  stubRegistry({
    txt: { 'example.com': ['"did=did:plc:ok"'] },
    pds: { 'did:plc:ok': 'https://pds.example.com' },
    schemas: { 'com.example.empty': null },
  })
  expect((await resolveLexicon('com.example.empty')).size).toBe(0)
})

test('malformed refs are ignored rather than fetched', async () => {
  // A non-string union member or a ref with fewer than three NSID segments
  // cannot name a lexicon; the walk skips them and still resolves the root.
  const root = lexicon('com.example.root', {
    type: 'object',
    properties: {
      a: { type: 'union', refs: [42, 'lex:ab', '#local'] },
      b: { type: 'ref', ref: 'short' },
    },
  })
  const { calls } = stubRegistry({
    txt: { 'example.com': ['"did=did:plc:ok"'] },
    pds: { 'did:plc:ok': 'https://pds.example.com' },
    schemas: { 'com.example.root': root },
  })
  const resolved = await resolveLexicon('com.example.root')
  expect(Array.from(resolved.keys())).toEqual(['com.example.root'])
  expect(calls.filter((c) => c.includes('getRecord'))).toHaveLength(1)
})
