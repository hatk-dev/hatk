import { afterEach, describe, expect, test, vi } from 'vitest'
import { clearDescribeCache, describeMethods, negotiateScope } from '../src/oauth/service-describe.ts'
import type { OAuthConfig } from '../src/config.ts'

// A PDS is asked for an optional feature's scopes only when it serves that
// feature. Asking every server would put a permission on the consent screen
// that most of them cannot honor, and a strict authorization server is within
// its rights to reject the request outright.

const PDS = 'https://pds.example.com'
const SPACE_SCOPE = 'space:social.grain.gallery?manage=create'

const config: OAuthConfig = {
  issuer: 'https://example.app',
  scopes: ['atproto', 'repo:social.grain.gallery'],
  clients: [],
  conditionalScopes: [{ whenMethod: 'com.atproto.simplespace.createSpace', scopes: [SPACE_SCOPE] }],
}

const BASE = 'atproto repo:social.grain.gallery'

function stubDescribe(methods: string[] | Error | number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(`${PDS}/xrpc/community.lexicon.service.describe`)
      if (methods instanceof Error) throw methods
      if (typeof methods === 'number') return new Response('nope', { status: methods })
      return new Response(
        JSON.stringify({
          roles: ['pds'],
          methods: methods.map((value) => ({
            $type: 'community.lexicon.service.describe#nsid',
            value,
          })),
        }),
        { status: 200 },
      )
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearDescribeCache()
})

describe('negotiateScope', () => {
  test('adds the scopes when the PDS serves the method', async () => {
    stubDescribe(['com.atproto.repo.createRecord', 'com.atproto.simplespace.createSpace'])

    expect(await negotiateScope(config, BASE, PDS, false)).toBe(`${BASE} ${SPACE_SCOPE}`)
  })

  test('leaves the scope alone when it does not', async () => {
    stubDescribe(['com.atproto.repo.createRecord'])

    expect(await negotiateScope(config, BASE, PDS, false)).toBe(BASE)
  })

  test('leaves the scope alone when the PDS answers no describe', async () => {
    // Every PDS predating the method, bsky.social included.
    stubDescribe(404)

    expect(await negotiateScope(config, BASE, PDS, false)).toBe(BASE)
  })

  test('an unreachable PDS does not fail the login', async () => {
    stubDescribe(new TypeError('fetch failed'))

    expect(await negotiateScope(config, BASE, PDS, false)).toBe(BASE)
  })

  test('loopback clients are left alone', async () => {
    // Their client_id encodes the scope they may request and the token exchange
    // rebuilds it from config, so a negotiated request would not match.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expect(await negotiateScope(config, BASE, PDS, true)).toBe(BASE)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('no conditional scopes means no probe at all', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expect(await negotiateScope({ ...config, conditionalScopes: [] }, BASE, PDS, false)).toBe(BASE)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('describeMethods', () => {
  test('caches per endpoint', async () => {
    stubDescribe(['com.atproto.simplespace.createSpace'])

    await describeMethods(PDS)
    await describeMethods(PDS)

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})

// A server can serve the feature and not serve describe — the reference spaces
// build of @atproto/pds does exactly that. Its silence used to deny it scopes it
// could honor, so the methods that matter are asked about directly instead.
describe('describeMethods without a describe endpoint', () => {
  /**
   * A server that answers `unknown` for anything it does not route and `known`
   * for anything it does, with no describe at all.
   */
  function stubServer(known: Record<string, [number, string]>, unknown: [number, string]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const nsid = String(url).split('/xrpc/')[1] ?? ''
        if (nsid === 'community.lexicon.service.describe') {
          return new Response('nope', { status: 404 })
        }
        const [status, error] = known[nsid] ?? unknown
        return new Response(JSON.stringify({ error }), { status })
      }),
    )
  }

  test('a method answered differently from a missing one counts as served', async () => {
    // The alpha PDS's shape: 400 for a method it has, 401 for one it does not.
    stubServer({ 'com.atproto.simplespace.createSpace': [400, 'InvalidRequest'] }, [401, 'AuthMissing'])

    const methods = await describeMethods(PDS, ['com.atproto.simplespace.createSpace'])

    expect(methods.has('com.atproto.simplespace.createSpace')).toBe(true)
  })

  test('a server that answers identically for everything claims nothing', async () => {
    // bsky.social's shape: 401 AuthMissing whether the method exists or not, so
    // there is nothing to tell them apart and nothing may be inferred.
    stubServer({}, [401, 'AuthMissing'])

    const methods = await describeMethods(PDS, ['com.atproto.simplespace.createSpace'])

    expect(methods.size).toBe(0)
  })

  test('no candidates means no probing', async () => {
    stubServer({ 'com.atproto.simplespace.createSpace': [400, 'InvalidRequest'] }, [401, 'AuthMissing'])

    const methods = await describeMethods(PDS)

    expect(methods.size).toBe(0)
    // Only describe was asked; a caller that named nothing gets no requests spent.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  test('the negotiated scope picks up a conditional set this way', async () => {
    stubServer({ 'com.atproto.simplespace.createSpace': [400, 'InvalidRequest'] }, [401, 'AuthMissing'])

    expect(await negotiateScope(config, BASE, PDS, false)).toBe(`${BASE} ${SPACE_SCOPE}`)
  })
})
