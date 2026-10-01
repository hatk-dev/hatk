import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const pdsXrpc = vi.fn()
const spaceHostEndpoint = vi.fn()

vi.mock('../src/pds-proxy.ts', () => ({
  pdsXrpc: (...args: unknown[]) => pdsXrpc(...args),
  ProxyError: class ProxyError extends Error {},
}))
vi.mock('../src/spaces/identity.ts', () => ({
  spaceHostEndpoint: (...args: unknown[]) => spaceHostEndpoint(...args),
  repoEndpoint: vi.fn(),
  configureSpaceIdentity: vi.fn(),
  clearSpaceIdentityCache: vi.fn(),
}))

const {
  SpaceCredentialError,
  forgetSpaceCredential,
  getSpaceCredential,
  isNotAuthorized,
  isSpaceGone,
  mintSpaceCredential,
  resetSpaceCredentials,
} = await import('../src/spaces/credential.ts')
const { parseMultibaseKey, verifySignature } = await import('../src/spaces/verify.ts')

const SPACE = 'at://did:plc:authority/space/test.hatk.board/self'
const READER = 'did:plc:reader'
const OTHER_READER = 'did:plc:other'
const AUTHORITY_HOST = 'https://authority.test'
const oauth = { issuer: 'https://appview.test', scopes: ['atproto'], clients: [] }

/** A credential JWT whose only load-bearing part is its expiry. */
function credentialJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `header.${payload}.signature`
}

const inTenMinutes = () => Math.floor(Date.now() / 1000) + 600

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetSpaceCredentials()
  pdsXrpc.mockReset()
  spaceHostEndpoint.mockReset()
  spaceHostEndpoint.mockResolvedValue(AUTHORITY_HOST)
  pdsXrpc.mockResolvedValue({ token: 'delegation-token' })
  fetchMock = vi.fn(async () => Response.json({ credential: credentialJwt(inTenMinutes()) }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('mints by trading a delegation token from the reader own PDS', async () => {
  const credential = await mintSpaceCredential(oauth as any, SPACE, READER)

  expect(pdsXrpc).toHaveBeenCalledWith(oauth, { did: READER }, 'com.atproto.space.getDelegationToken', {
    params: { space: SPACE },
  })
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe(`${AUTHORITY_HOST}/xrpc/com.atproto.space.getSpaceCredential`)
  expect((init as RequestInit).method).toBe('POST')
  expect(credential.readerDid).toBe(READER)
  expect(credential.space).toBe(SPACE)
})

/** The did:key a signature names, and whether it signed `base` over these headers. */
function checkSignature(headers: Record<string, string>, base: string, keyDid: string): boolean {
  const sig = headers.Signature.match(/^atproto-space=:(.+):$/)![1]
  return verifySignature(
    parseMultibaseKey(keyDid.slice('did:key:'.length)),
    new Uint8Array(Buffer.from(sig, 'base64')),
    new TextEncoder().encode(base),
  )
}

function exchangeKey(): string {
  const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
  return headers['Signature-Input'].match(/keyid="([^"]+)"/)![1]
}

test('the exchange carries the delegation as a bearer token, signed by a fresh key', async () => {
  await mintSpaceCredential(oauth as any, SPACE, READER)
  const init = fetchMock.mock.calls[0][1] as RequestInit
  const headers = init.headers as Record<string, string>
  expect(headers.Authorization).toBe('Bearer delegation-token')
  const keyDid = exchangeKey()
  expect(keyDid).toMatch(/^did:key:zDn/)
  expect(headers['Signature-Input']).toBe(`atproto-space=("authorization");keyid="${keyDid}"`)
  const base = [
    '"authorization": Bearer delegation-token',
    `"@signature-params": ("authorization");keyid="${keyDid}"`,
  ].join('\n')
  expect(checkSignature(headers, base, keyDid)).toBe(true)
  expect(JSON.parse(init.body as string)).toEqual({ space: SPACE })
})

test('each credential is bound to a key of its own', async () => {
  await mintSpaceCredential(oauth as any, SPACE, READER)
  const first = exchangeKey()
  fetchMock.mockClear()
  await mintSpaceCredential(oauth as any, SPACE, READER)
  expect(exchangeKey()).not.toBe(first)
})

test('a read is signed for the repo it names, with the exchange key', async () => {
  // One credential reads a whole space and is shown to every writer host in
  // it. Signed for one account, it cannot be replayed at another.
  const jwt = credentialJwt(inTenMinutes())
  fetchMock.mockImplementationOnce(async () => Response.json({ credential: jwt }))
  const credential = await mintSpaceCredential(oauth as any, SPACE, READER)
  const keyDid = exchangeKey()
  fetchMock.mockImplementationOnce(async () => Response.json({ records: [] }))
  await credential.fetch(`https://writer.test/xrpc/com.atproto.space.listRecords?space=x&repo=${OTHER_READER}`)

  const headers = Object.fromEntries(((fetchMock.mock.calls[1][1] as RequestInit).headers as Headers).entries())
  expect(headers.authorization).toBe(`Atproto-Space ${jwt}`)
  expect(headers['atproto-space-audience']).toBe(OTHER_READER)
  expect(headers['signature-input']).toBe('atproto-space=("authorization" "atproto-space-audience")')
  const base = [
    `"authorization": Atproto-Space ${jwt}`,
    `"atproto-space-audience": ${OTHER_READER}`,
    '"@signature-params": ("authorization" "atproto-space-audience")',
  ].join('\n')
  expect(checkSignature({ Signature: headers.signature }, base, keyDid)).toBe(true)
})

test('a read that names no repo is signed for the authority', async () => {
  const credential = await mintSpaceCredential(oauth as any, SPACE, READER)
  fetchMock.mockImplementationOnce(async () => Response.json({ repos: [] }))
  await credential.fetch(`${AUTHORITY_HOST}/xrpc/com.atproto.space.listRepos?space=x`)
  const headers = (fetchMock.mock.calls[1][1] as RequestInit).headers as Headers
  expect(headers.get('Atproto-Space-Audience')).toBe('did:plc:authority')
})

test('a refusal names what the authority said', async () => {
  fetchMock.mockImplementation(async () =>
    Response.json({ error: 'UserNotAuthorized', message: 'nope' }, { status: 403 }),
  )
  const err = await mintSpaceCredential(oauth as any, SPACE, READER).catch((e) => e)
  expect(err).toBeInstanceOf(SpaceCredentialError)
  expect(isNotAuthorized(err)).toBe(true)
  expect(isSpaceGone(err)).toBe(false)
})

test('a deleted space is distinguished from a refused reader', async () => {
  fetchMock.mockImplementation(async () => Response.json({ error: 'SpaceDeleted' }, { status: 400 }))
  const err = await mintSpaceCredential(oauth as any, SPACE, READER).catch((e) => e)
  expect(isSpaceGone(err)).toBe(true)
  expect(isNotAuthorized(err)).toBe(false)
})

test('a 200 with no credential is still a failure', async () => {
  fetchMock.mockImplementation(async () => Response.json({}))
  await expect(mintSpaceCredential(oauth as any, SPACE, READER)).rejects.toThrow(SpaceCredentialError)
})

test('an upstream error is labelled as one', async () => {
  fetchMock.mockImplementation(async () => new Response('gateway', { status: 502 }))
  const err = await mintSpaceCredential(oauth as any, SPACE, READER).catch((e) => e)
  expect(err.code).toBe('UpstreamFailure')
})

test('a PDS that will not mint a delegation stops the attempt there', async () => {
  pdsXrpc.mockRejectedValue(Object.assign(new Error('no scope'), { status: 403 }))
  const err = await mintSpaceCredential(oauth as any, SPACE, READER).catch((e) => e)
  expect(err.code).toBe('DelegationFailed')
  expect(fetchMock).not.toHaveBeenCalled()
})

test('a PDS that answers without a token is a delegation failure', async () => {
  pdsXrpc.mockResolvedValue({})
  const err = await mintSpaceCredential(oauth as any, SPACE, READER).catch((e) => e)
  expect(err.code).toBe('DelegationFailed')
})

test('something that is not a space ref is refused before any network call', async () => {
  const err = await mintSpaceCredential(oauth as any, 'at://did:plc:x/app.bsky.feed.post/1', READER).catch((e) => e)
  expect(err).toBeInstanceOf(SpaceCredentialError)
  expect(pdsXrpc).not.toHaveBeenCalled()
})

test('candidates are tried in order and the first that works is kept', async () => {
  pdsXrpc.mockImplementation(async (_config: unknown, viewer: { did: string }) => {
    if (viewer.did === READER) throw Object.assign(new Error('ejected'), { status: 403 })
    return { token: 'delegation-token' }
  })
  const credential = await getSpaceCredential(oauth as any, SPACE, [READER, OTHER_READER])
  expect(credential.readerDid).toBe(OTHER_READER)
})

test('a deleted space stops the walk rather than trying everyone', async () => {
  // No other reader would fare better, and walking the whole session table to
  // learn that costs a round trip per person signed in.
  fetchMock.mockImplementation(async () => Response.json({ error: 'SpaceNotFound' }, { status: 404 }))
  await expect(getSpaceCredential(oauth as any, SPACE, [READER, OTHER_READER])).rejects.toThrow()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('with no candidate able to read, the failure says so', async () => {
  const err = await getSpaceCredential(oauth as any, SPACE, []).catch((e) => e)
  expect(err.code).toBe('NoReader')
})

test('a fresh credential is reused rather than re-minted', async () => {
  await getSpaceCredential(oauth as any, SPACE, [READER])
  await getSpaceCredential(oauth as any, SPACE, [READER])
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('refresh mints again even when one is cached', async () => {
  await getSpaceCredential(oauth as any, SPACE, [READER])
  await getSpaceCredential(oauth as any, SPACE, [READER], { refresh: true })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('a credential close to expiry is re-minted rather than raced', async () => {
  fetchMock.mockImplementation(async () =>
    Response.json({ credential: credentialJwt(Math.floor(Date.now() / 1000) + 60) }),
  )
  await getSpaceCredential(oauth as any, SPACE, [READER])
  await getSpaceCredential(oauth as any, SPACE, [READER])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('forgetting a credential forces the next read to mint', async () => {
  await getSpaceCredential(oauth as any, SPACE, [READER])
  forgetSpaceCredential(SPACE)
  await getSpaceCredential(oauth as any, SPACE, [READER])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('a credential with an unreadable expiry is used but not held long', async () => {
  fetchMock.mockImplementation(async () => Response.json({ credential: 'not.a.jwt' }))
  const credential = await mintSpaceCredential(oauth as any, SPACE, READER)
  expect(credential.expiresAt).toBeGreaterThan(Date.now())
  expect(credential.expiresAt).toBeLessThan(Date.now() + 11 * 60 * 1000)
})
