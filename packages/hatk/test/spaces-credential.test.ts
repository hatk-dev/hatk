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
  mintPublicSpaceCredential,
  mintSpaceCredential,
  publicSpaceCredential,
  readerSpaceCredential,
  forgetReaderSpaceCredential,
  resetSpaceCredentials,
} = await import('../src/spaces/credential.ts')
const { verifyCredentialSig } = await import('@atproto/space')

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

/** The body the exchange sent. */
function exchangeBody(call = 0): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string)
}

test('the exchange names the key to bind and carries the delegation in the body', async () => {
  await mintSpaceCredential(oauth as any, SPACE, READER)
  const init = fetchMock.mock.calls[0][1] as RequestInit
  const body = exchangeBody()
  expect(body).toEqual({
    space: SPACE,
    credentialKid: expect.stringMatching(/^did:key:zDn/),
    delegationToken: 'delegation-token',
  })
  // Not signed and not bearer-authed: the token is in the body.
  const headers = new Headers(init.headers)
  expect(headers.get('authorization')).toBeNull()
  expect(headers.get('signature')).toBeNull()
})

test('each credential is bound to a key of its own', async () => {
  await mintSpaceCredential(oauth as any, SPACE, READER)
  const first = exchangeBody().credentialKid
  fetchMock.mockClear()
  await mintSpaceCredential(oauth as any, SPACE, READER)
  expect(exchangeBody().credentialKid).not.toBe(first)
})

test('a read presents the credential signed for the repo it names, with the bound key', async () => {
  // One credential reads a whole space and is shown to every writer host in
  // it. Signed for one account, it cannot be replayed at another.
  const jwt = credentialJwt(inTenMinutes())
  fetchMock.mockImplementationOnce(async () => Response.json({ credential: jwt }))
  const credential = await mintSpaceCredential(oauth as any, SPACE, READER)
  const keyDid = exchangeBody().credentialKid as `did:key:${string}`
  fetchMock.mockImplementationOnce(async () => Response.json({ records: [] }))
  await credential.fetch(`https://writer.test/xrpc/com.atproto.space.listRecords?space=x&repo=${OTHER_READER}`)

  const headers = Object.fromEntries(((fetchMock.mock.calls[1][1] as RequestInit).headers as Headers).entries())
  expect(headers.authorization).toBe(`Atproto-Space-Credential ${jwt}`)
  expect(headers['atproto-space-audience']).toBe(OTHER_READER)
  expect(headers['signature-input']).toBe(
    'atproto-space-credential=("authorization" "atproto-space-audience");tag="atproto-space-credential"',
  )
  // Checked by the reference verifier, so the bytes are what a host accepts.
  await expect(verifyCredentialSig(headers, keyDid)).resolves.toBeUndefined()
})

test('a read that names no repo is signed for the authority', async () => {
  const credential = await mintSpaceCredential(oauth as any, SPACE, READER)
  fetchMock.mockImplementationOnce(async () => Response.json({ repos: [] }))
  await credential.fetch(`${AUTHORITY_HOST}/xrpc/com.atproto.space.listRepos?space=x`)
  const headers = (fetchMock.mock.calls[1][1] as RequestInit).headers as Headers
  expect(headers.get('Atproto-Space-Audience')).toBe('did:plc:authority')
})

// --- Public spaces ---

test('a public credential is asked for with no delegation at all', async () => {
  const credential = await mintPublicSpaceCredential(SPACE)
  expect(pdsXrpc).not.toHaveBeenCalled()
  expect(exchangeBody()).toEqual({ space: SPACE, credentialKid: expect.stringMatching(/^did:key:zDn/) })
  expect(credential.readerDid).toBeNull()
})

test('a space that is not public says so, rather than that it is gone', async () => {
  // An authority answers SpaceNotFound for a space it will not disclose.
  fetchMock.mockImplementation(async () => Response.json({ error: 'SpaceNotFound' }, { status: 400 }))
  const err = await mintPublicSpaceCredential(SPACE).catch((e) => e)
  expect(err.code).toBe('NotPublic')
  expect(isSpaceGone(err)).toBe(false)
  expect(isNotAuthorized(err)).toBe(true)
})

test('a deleted space is deleted for a public reader too', async () => {
  fetchMock.mockImplementation(async () => Response.json({ error: 'SpaceDeleted' }, { status: 400 }))
  expect(isSpaceGone(await mintPublicSpaceCredential(SPACE).catch((e) => e))).toBe(true)
})

test('a public credential is reused until close to expiry', async () => {
  await publicSpaceCredential(SPACE)
  await publicSpaceCredential(SPACE)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await publicSpaceCredential(SPACE, { refresh: true })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('with no session able to read it, a public space is read as the public', async () => {
  pdsXrpc.mockRejectedValue(Object.assign(new Error('ejected'), { status: 403 }))
  const credential = await getSpaceCredential(oauth as any, SPACE, [READER])
  expect(credential.readerDid).toBeNull()
})

test('a space neither a session nor the public can read reports the session refusal', async () => {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
    JSON.parse(init.body as string).delegationToken
      ? Response.json({ error: 'UserNotAuthorized' }, { status: 403 })
      : Response.json({ error: 'SpaceNotFound' }, { status: 400 }),
  )
  const err = await getSpaceCredential(oauth as any, SPACE, [READER]).catch((e) => e)
  expect(err.code).toBe('UserNotAuthorized')
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

test('with no candidate able to read and no public access, the failure says so', async () => {
  fetchMock.mockImplementation(async () => Response.json({ error: 'SpaceNotFound' }, { status: 400 }))
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

// --- Per reader ---

test('a reader credential is minted as that reader and reused for them', async () => {
  const first = await readerSpaceCredential(oauth as any, READER, SPACE)
  expect(first.readerDid).toBe(READER)
  await readerSpaceCredential(oauth as any, READER, SPACE)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('another reader of the same space gets their own', async () => {
  // A read made for a viewer has to be made as that viewer; the index's cache
  // holds whichever session works, which is not an answer about this one.
  await readerSpaceCredential(oauth as any, READER, SPACE)
  const other = await readerSpaceCredential(oauth as any, OTHER_READER, SPACE)
  expect(other.readerDid).toBe(OTHER_READER)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('a refused reader gets the authority status, and is asked again next time', async () => {
  fetchMock.mockImplementationOnce(async () => Response.json({ error: 'UserNotAuthorized' }, { status: 403 }))
  const err = await readerSpaceCredential(oauth as any, READER, SPACE).catch((e) => e)
  expect(err).toBeInstanceOf(SpaceCredentialError)
  expect(err.status).toBe(403)
  expect(isNotAuthorized(err)).toBe(true)
  await expect(readerSpaceCredential(oauth as any, READER, SPACE)).resolves.toBeDefined()
})

test('refresh mints a reader credential anew', async () => {
  await readerSpaceCredential(oauth as any, READER, SPACE)
  await readerSpaceCredential(oauth as any, READER, SPACE, { refresh: true })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('forgetting a reader credential makes their next read mint', async () => {
  await readerSpaceCredential(oauth as any, READER, SPACE)
  await readerSpaceCredential(oauth as any, OTHER_READER, SPACE)
  forgetReaderSpaceCredential(READER, SPACE)
  await readerSpaceCredential(oauth as any, READER, SPACE)
  await readerSpaceCredential(oauth as any, OTHER_READER, SPACE)
  expect(fetchMock).toHaveBeenCalledTimes(3)
})
