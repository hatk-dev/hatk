import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

const mintSpaceCredential = vi.fn()

vi.mock('../src/spaces/credential.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/spaces/credential.ts')>('../src/spaces/credential.ts')
  return { ...actual, mintSpaceCredential: (...a: unknown[]) => mintSpaceCredential(...a) }
})

const { forgetViewerSpaces, readableSpacesFor, resetViewerSpaces, viewerCredential } =
  await import('../src/spaces/viewer.ts')
const { SpaceCredentialError } = await import('../src/spaces/credential.ts')
const { putSpaceWatch } = await import('../src/spaces/store.ts')
const { runSQL } = await import('../src/database/db.ts')
const { SPACE_AUTHORITY, SPACE_TYPE, SPACE_URI, setupFixtureDatabase } = await import('./fixture.ts')

const OTHER_SPACE = `at://did:plc:second/space/${SPACE_TYPE}/self`
const MEMBER = { did: 'did:plc:member' }
const STRANGER = { did: 'did:plc:stranger' }
const oauth = { issuer: 'https://appview.test', scopes: ['atproto'], clients: [] } as any

const credential = (space: string, did: string, expiresAt = Date.now() + 3600_000) => ({
  space,
  readerDid: did,
  expiresAt,
  fetch: vi.fn(),
})

beforeAll(async () => {
  await setupFixtureDatabase()
})

beforeEach(async () => {
  resetViewerSpaces()
  mintSpaceCredential.mockReset()
  await runSQL('DELETE FROM _space_watch')
  await putSpaceWatch({ space: SPACE_URI, authority: SPACE_AUTHORITY, spaceType: SPACE_TYPE })
  await putSpaceWatch({ space: OTHER_SPACE, authority: 'did:plc:second', spaceType: SPACE_TYPE })
})

afterEach(() => {
  vi.useRealTimers()
})

test('a signed-out visitor is shown no space at all', async () => {
  // Not a policy choice: obtaining a credential begins with a delegation token
  // from the reader's own PDS, so there is no anonymous read path into a space.
  expect(await readableSpacesFor(oauth, null)).toEqual([])
  expect(mintSpaceCredential).not.toHaveBeenCalled()
})

test('an instance without OAuth shows no space', async () => {
  expect(await readableSpacesFor(null, MEMBER)).toEqual([])
})

test('a viewer is shown exactly the spaces the authority mints for them', async () => {
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) => {
    if (space !== SPACE_URI) throw new SpaceCredentialError(403, 'UserNotAuthorized', 'no')
    return credential(space, did)
  })
  expect(await readableSpacesFor(oauth, MEMBER)).toEqual([SPACE_URI])
})

test('a stranger is shown nothing, and the refusal is not an error', async () => {
  mintSpaceCredential.mockRejectedValue(new SpaceCredentialError(403, 'UserNotAuthorized', 'no'))
  expect(await readableSpacesFor(oauth, STRANGER)).toEqual([])
})

test('an unreachable authority denies rather than widening', async () => {
  mintSpaceCredential.mockRejectedValue(new Error('offline'))
  expect(await readableSpacesFor(oauth, MEMBER)).toEqual([])
})

test('a deleted space is a no for everyone without failing the request', async () => {
  mintSpaceCredential.mockRejectedValue(new SpaceCredentialError(400, 'SpaceDeleted', 'gone'))
  expect(await readableSpacesFor(oauth, MEMBER)).toEqual([])
})

test('the answer is cached rather than re-asked on every request', async () => {
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) => credential(space, did))
  await readableSpacesFor(oauth, MEMBER)
  await readableSpacesFor(oauth, MEMBER)
  expect(mintSpaceCredential).toHaveBeenCalledTimes(2) // one per watched space, once
})

test('each viewer is answered for separately', async () => {
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) => {
    if (did === STRANGER.did) throw new SpaceCredentialError(403, 'UserNotAuthorized', 'no')
    return credential(space, did)
  })
  expect((await readableSpacesFor(oauth, MEMBER)).sort()).toEqual([OTHER_SPACE, SPACE_URI].sort())
  expect(await readableSpacesFor(oauth, STRANGER)).toEqual([])
})

test('the cached answer is checked again once it ages out', async () => {
  vi.useFakeTimers()
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) => credential(space, did))
  await readableSpacesFor(oauth, MEMBER)
  mintSpaceCredential.mockClear()

  vi.setSystemTime(Date.now() + 6 * 60 * 1000)
  await readableSpacesFor(oauth, MEMBER)
  expect(mintSpaceCredential).toHaveBeenCalled()
})

test('forgetting a viewer forces the next request to ask again', async () => {
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) => credential(space, did))
  await readableSpacesFor(oauth, MEMBER)
  mintSpaceCredential.mockClear()
  forgetViewerSpaces(MEMBER.did)
  await readableSpacesFor(oauth, MEMBER)
  expect(mintSpaceCredential).toHaveBeenCalled()
})

test('an instance following no space asks nothing', async () => {
  await runSQL('DELETE FROM _space_watch')
  expect(await readableSpacesFor(oauth, MEMBER)).toEqual([])
  expect(mintSpaceCredential).not.toHaveBeenCalled()
})

// --- Credentials for the reads the index cannot serve ---

test('the credential minted while answering is reused rather than minted twice', async () => {
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) => credential(space, did))
  await readableSpacesFor(oauth, MEMBER)
  mintSpaceCredential.mockClear()

  const cred = await viewerCredential(oauth, MEMBER, SPACE_URI)
  expect(cred?.space).toBe(SPACE_URI)
  expect(mintSpaceCredential).not.toHaveBeenCalled()
})

test('a viewer who may not read the space gets no credential', async () => {
  mintSpaceCredential.mockRejectedValue(new SpaceCredentialError(403, 'UserNotAuthorized', 'no'))
  expect(await viewerCredential(oauth, STRANGER, SPACE_URI)).toBeNull()
})

test('a credential that expired inside the cached answer is minted again', async () => {
  // The answer to "may they read it" outlives the token that proved it.
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) =>
    credential(space, did, Date.now() - 1000),
  )
  await readableSpacesFor(oauth, MEMBER)
  mintSpaceCredential.mockClear()
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) => credential(space, did))

  const cred = await viewerCredential(oauth, MEMBER, SPACE_URI)
  expect(cred).not.toBeNull()
  expect(mintSpaceCredential).toHaveBeenCalledTimes(1)
})

test('a space not covered by the cached answer is asked about on demand', async () => {
  mintSpaceCredential.mockRejectedValue(new SpaceCredentialError(403, 'UserNotAuthorized', 'no'))
  await readableSpacesFor(oauth, MEMBER)
  mintSpaceCredential.mockReset()
  mintSpaceCredential.mockImplementation(async (_o: unknown, space: string, did: string) => credential(space, did))

  const unwatched = `at://did:plc:third/space/${SPACE_TYPE}/self`
  expect(await viewerCredential(oauth, MEMBER, unwatched)).not.toBeNull()
})

test('no viewer and no oauth means no credential', async () => {
  expect(await viewerCredential(oauth, null, SPACE_URI)).toBeNull()
  expect(await viewerCredential(null, MEMBER, SPACE_URI)).toBeNull()
})
