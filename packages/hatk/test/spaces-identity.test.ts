import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const pdsFor = vi.fn()
vi.mock('../src/backfill.ts', () => ({ pdsFor: (...args: unknown[]) => pdsFor(...args) }))

const { atprotoSigningKey, clearSpaceIdentityCache, configureSpaceIdentity, repoEndpoint, spaceHostEndpoint } =
  await import('../src/spaces/identity.ts')

const AUTHORITY = 'did:plc:authority'
let fetchMock: ReturnType<typeof vi.fn>

function didDoc(services: { id: string; serviceEndpoint: string }[]) {
  return async () => Response.json({ id: AUTHORITY, service: services })
}

beforeEach(() => {
  clearSpaceIdentityCache()
  configureSpaceIdentity('https://plc.test')
  pdsFor.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a dedicated space host entry is preferred', async () => {
  fetchMock.mockImplementation(
    didDoc([
      { id: '#atproto_pds', serviceEndpoint: 'https://pds.test' },
      { id: '#atproto_space_host', serviceEndpoint: 'https://spaces.test' },
    ]),
  )
  expect(await spaceHostEndpoint(AUTHORITY)).toBe('https://spaces.test')
})

test('an authority publishing no space host is reached at its PDS', async () => {
  // Which is every community host built on the reference implementation: the
  // fragment names the audience, not the address.
  fetchMock.mockImplementation(didDoc([{ id: '#atproto_pds', serviceEndpoint: 'https://pds.test' }]))
  expect(await spaceHostEndpoint(AUTHORITY)).toBe('https://pds.test')
})

test('the DID document is fetched from the configured directory', async () => {
  fetchMock.mockImplementation(didDoc([{ id: '#atproto_pds', serviceEndpoint: 'https://pds.test' }]))
  await spaceHostEndpoint(AUTHORITY)
  expect(fetchMock).toHaveBeenCalledWith(`https://plc.test/${AUTHORITY}`)
})

test('a did:web authority is resolved from its own domain', async () => {
  fetchMock.mockImplementation(didDoc([{ id: '#atproto_pds', serviceEndpoint: 'https://host.test' }]))
  await spaceHostEndpoint('did:web:host.test')
  expect(fetchMock).toHaveBeenCalledWith('https://host.test/.well-known/did.json')
})

test('a did:web with a port resolves through the path form', async () => {
  fetchMock.mockImplementation(didDoc([{ id: '#atproto_pds', serviceEndpoint: 'http://localhost:4000' }]))
  await spaceHostEndpoint('did:web:localhost%3A4000')
  expect(fetchMock).toHaveBeenCalledWith('https://localhost/4000/.well-known/did.json')
})

test('a document is fetched once and reused', async () => {
  fetchMock.mockImplementation(didDoc([{ id: '#atproto_pds', serviceEndpoint: 'https://pds.test' }]))
  await spaceHostEndpoint(AUTHORITY)
  await spaceHostEndpoint(AUTHORITY)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('an authority with no usable service entry is an error', async () => {
  fetchMock.mockImplementation(didDoc([{ id: '#something_else', serviceEndpoint: 'https://nope.test' }]))
  await expect(spaceHostEndpoint(AUTHORITY)).rejects.toThrow('No space host or PDS endpoint')
})

test('an unresolvable authority is an error, not a silent default', async () => {
  fetchMock.mockImplementation(async () => new Response('nope', { status: 404 }))
  await expect(spaceHostEndpoint(AUTHORITY)).rejects.toThrow(AUTHORITY)
})

test('a directory that cannot be reached is an error', async () => {
  fetchMock.mockImplementation(async () => {
    throw new Error('offline')
  })
  await expect(spaceHostEndpoint(AUTHORITY)).rejects.toThrow('No space host or PDS endpoint')
})

test('a writer repo is resolved the way every other repo is', async () => {
  // Records stay with their writer, on the writer's own server, so this is the
  // same question backfill already answers for a public repo.
  pdsFor.mockResolvedValue('https://alice.test')
  expect(await repoEndpoint('did:plc:alice')).toBe('https://alice.test')
  expect(pdsFor).toHaveBeenCalledWith('did:plc:alice')
})

// --- Signing keys ---

/** A DID document carrying verification methods rather than services. */
function keyDoc(methods: { id: string; publicKeyMultibase?: string }[]) {
  return async () =>
    Response.json({
      id: AUTHORITY,
      verificationMethod: methods.map((m) => ({ ...m, type: 'Multikey', controller: AUTHORITY })),
    })
}

// A real secp256k1 key, multicodec-prefixed and base58btc-encoded — the shape
// a did:plc document actually publishes.
const SECP_KEY = 'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'

test('the atproto signing key is read from the DID document', async () => {
  fetchMock.mockImplementation(keyDoc([{ id: '#atproto', publicKeyMultibase: SECP_KEY }]))
  const key = await atprotoSigningKey(AUTHORITY)
  expect(key?.curve).toBe('secp256k1')
  expect(key?.bytes).toHaveLength(33)
})

test('a dedicated space-signing key is preferred over the account key', async () => {
  fetchMock.mockImplementation(
    keyDoc([
      { id: '#atproto', publicKeyMultibase: SECP_KEY },
      { id: '#atproto_space', publicKeyMultibase: SECP_KEY },
    ]),
  )
  expect((await atprotoSigningKey(AUTHORITY))?.curve).toBe('secp256k1')
})

test('a document with no usable key answers null rather than guessing', async () => {
  fetchMock.mockImplementation(keyDoc([{ id: '#something-else', publicKeyMultibase: SECP_KEY }]))
  expect(await atprotoSigningKey(AUTHORITY)).toBeNull()
})

test('a verification method with no key material answers null', async () => {
  fetchMock.mockImplementation(keyDoc([{ id: '#atproto' }]))
  expect(await atprotoSigningKey(AUTHORITY)).toBeNull()
})

test('an unparseable key answers null rather than throwing', async () => {
  // A malformed document must fail the notice, not the process.
  fetchMock.mockImplementation(keyDoc([{ id: '#atproto', publicKeyMultibase: 'not-multibase' }]))
  expect(await atprotoSigningKey(AUTHORITY)).toBeNull()
})

test('an unresolvable DID has no key', async () => {
  fetchMock.mockImplementation(async () => new Response('nope', { status: 404 }))
  expect(await atprotoSigningKey(AUTHORITY)).toBeNull()
})
