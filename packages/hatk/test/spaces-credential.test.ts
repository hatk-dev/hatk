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

const inTwoHours = () => Math.floor(Date.now() / 1000) + 7200

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetSpaceCredentials()
  pdsXrpc.mockReset()
  spaceHostEndpoint.mockReset()
  spaceHostEndpoint.mockResolvedValue(AUTHORITY_HOST)
  pdsXrpc.mockResolvedValue({ token: 'delegation-token' })
  fetchMock = vi.fn(async () => Response.json({ credential: credentialJwt(inTwoHours()) }))
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

test('the exchange carries the delegation as a bearer token and proves a key', async () => {
  await mintSpaceCredential(oauth as any, SPACE, READER)
  const init = fetchMock.mock.calls[0][1] as RequestInit
  const headers = init.headers as Record<string, string>
  expect(headers.Authorization).toBe('Bearer delegation-token')
  expect(headers.DPoP).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
  expect(JSON.parse(init.body as string)).toMatchObject({ space: SPACE, dpopJkt: expect.any(String) })
})

test('the exchange proof carries no ath', async () => {
  // A delegation token is an authorization grant, not an access token, so
  // there is nothing to hash yet and a server that checks refuses a proof
  // that includes one.
  await mintSpaceCredential(oauth as any, SPACE, READER)
  const init = fetchMock.mock.calls[0][1] as RequestInit
  const proof = (init.headers as Record<string, string>).DPoP
  const payload = JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString())
  expect(payload.ath).toBeUndefined()
  expect(payload.htm).toBe('POST')
})

test('reads present the credential DPoP-bound with an ath', async () => {
  // One credential reads a whole space and is shown to every writer host in
  // it. As a bearer token, a host given one to serve its own repo could replay
  // it against all the others.
  const credential = await mintSpaceCredential(oauth as any, SPACE, READER)
  fetchMock.mockImplementationOnce(async () => Response.json({ records: [] }))
  await credential.fetch('https://writer.test/xrpc/com.atproto.space.listRecords')

  const [, init] = fetchMock.mock.calls[1]
  const headers = (init as RequestInit).headers as Headers
  expect(headers.get('Authorization')).toMatch(/^DPoP /)
  const payload = JSON.parse(Buffer.from(headers.get('DPoP')!.split('.')[1], 'base64url').toString())
  expect(payload.ath).toEqual(expect.any(String))
  expect(payload.htm).toBe('GET')
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
