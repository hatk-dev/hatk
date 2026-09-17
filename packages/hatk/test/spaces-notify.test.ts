import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

const atprotoSigningKey = vi.fn()
vi.mock('../src/spaces/identity.ts', () => ({
  atprotoSigningKey: (...a: unknown[]) => atprotoSigningKey(...a),
  spaceHostEndpoint: vi.fn(),
  repoEndpoint: vi.fn(),
  configureSpaceIdentity: vi.fn(),
  clearSpaceIdentityCache: vi.fn(),
}))

const { NoticeError, clearPendingNotices, parseWriteNotice, scheduleNoticeSync, verifyNotice } =
  await import('../src/spaces/notify.ts')

const AUTHORITY = 'did:plc:authority'
const SPACE = `at://${AUTHORITY}/space/test.hatk.board/self`
const WRITER = 'did:plc:writer'
const SERVICE_ID = 'did:web:appview.test#atproto_space_syncer'
const LXM = 'com.atproto.space.notifyWrite'

const b64url = (input: string | Uint8Array) =>
  Buffer.from(typeof input === 'string' ? new TextEncoder().encode(input) : input).toString('base64url')

let signingKey: Uint8Array

/** A service-auth JWT signed the way an authority forwards one. */
function notice(payload: Record<string, unknown>, priv = signingKey): string {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256K' }))
  const body = b64url(
    JSON.stringify({
      iss: AUTHORITY,
      aud: SERVICE_ID,
      lxm: LXM,
      exp: Math.floor(Date.now() / 1000) + 60,
      ...payload,
    }),
  )
  const signature = secp256k1.sign(sha256(new TextEncoder().encode(`${header}.${body}`)), priv)
  return `Bearer ${header}.${body}.${b64url(signature)}`
}

const expected = { iss: AUTHORITY, aud: SERVICE_ID, lxm: LXM }

beforeEach(() => {
  signingKey = secp256k1.utils.randomSecretKey()
  atprotoSigningKey.mockReset()
  atprotoSigningKey.mockResolvedValue({
    curve: 'secp256k1',
    bytes: secp256k1.getPublicKey(signingKey, true),
  })
})

afterEach(() => {
  clearPendingNotices()
  vi.useRealTimers()
})

// --- Verification ---

test('a notice signed by the authority is accepted', async () => {
  await expect(verifyNotice(notice({}), expected)).resolves.toBeUndefined()
})

test('a notice with no authorization is refused', async () => {
  await expect(verifyNotice(null, expected)).rejects.toThrow(NoticeError)
  await expect(verifyNotice('DPoP something', expected)).rejects.toThrow(/Missing service auth/)
})

test('a malformed token is refused before any key is resolved', async () => {
  await expect(verifyNotice('Bearer not-a-jwt', expected)).rejects.toThrow(/Malformed/)
  await expect(verifyNotice('Bearer a.b.c', expected)).rejects.toThrow(/Malformed/)
  expect(atprotoSigningKey).not.toHaveBeenCalled()
})

test('a notice from anyone but the space authority is refused', async () => {
  // The issuer is checked against the space the body names, so a valid token
  // from one authority cannot be used to speak about another's space.
  await expect(verifyNotice(notice({ iss: 'did:plc:someone-else' }), expected)).rejects.toThrow(
    /not the space authority/,
  )
})

test('an issuer with a key fragment still matches the authority', async () => {
  await expect(verifyNotice(notice({ iss: `${AUTHORITY}#atproto` }), expected)).resolves.toBeUndefined()
})

test('a notice addressed to another service is refused', async () => {
  // A forwarded notice names the full service identifier, fragment included.
  await expect(verifyNotice(notice({ aud: 'did:web:elsewhere.test#syncer' }), expected)).rejects.toThrow(
    /addressed elsewhere/,
  )
})

test('a notice addressed to the bare DID rather than the service entry is refused', async () => {
  await expect(verifyNotice(notice({ aud: 'did:web:appview.test' }), expected)).rejects.toThrow(/addressed elsewhere/)
})

test('a token minted for a different method is refused', async () => {
  await expect(verifyNotice(notice({ lxm: 'com.atproto.repo.createRecord' }), expected)).rejects.toThrow(
    /different method/,
  )
})

test('an expired notice is refused', async () => {
  await expect(verifyNotice(notice({ exp: Math.floor(Date.now() / 1000) - 600 }), expected)).rejects.toThrow(/expired/)
})

test('a notice without an expiry is refused', async () => {
  await expect(verifyNotice(notice({ exp: undefined }), expected)).rejects.toThrow(/expired/)
})

test('a small amount of clock skew is tolerated', async () => {
  // These are signed for sixty seconds; refusing on a few seconds of drift
  // would drop notices from a host whose clock is merely imperfect.
  await expect(verifyNotice(notice({ exp: Math.floor(Date.now() / 1000) - 10 }), expected)).resolves.toBeUndefined()
})

test('a notice signed by the wrong key is refused', async () => {
  const forged = notice({}, secp256k1.utils.randomSecretKey())
  await expect(verifyNotice(forged, expected)).rejects.toThrow(/does not verify/)
})

test('a tampered payload is refused', async () => {
  const token = notice({})
  const [header, , signature] = token.replace('Bearer ', '').split('.')
  const swapped = b64url(JSON.stringify({ iss: AUTHORITY, aud: SERVICE_ID, lxm: LXM, exp: 9999999999 }))
  await expect(verifyNotice(`Bearer ${header}.${swapped}.${signature}`, expected)).rejects.toThrow(/does not verify/)
})

test('an authority whose key cannot be resolved is an upstream failure, not a pass', async () => {
  atprotoSigningKey.mockResolvedValue(null)
  const err = await verifyNotice(notice({}), expected).catch((e) => e)
  expect(err).toBeInstanceOf(NoticeError)
  expect(err.status).toBe(502)
})

// --- Payloads ---

test('a write notice names the space, the repo and the revision', () => {
  expect(parseWriteNotice({ space: SPACE, repo: WRITER, rev: '3a' })).toEqual({
    space: SPACE,
    repo: WRITER,
    rev: '3a',
  })
})

test('an incomplete or malformed notice is refused', () => {
  expect(parseWriteNotice(null)).toBeNull()
  expect(parseWriteNotice('nope')).toBeNull()
  expect(parseWriteNotice({ space: SPACE, repo: WRITER })).toBeNull()
  expect(parseWriteNotice({ space: 'at://x/y/z', repo: WRITER, rev: '3a' })).toBeNull()
  expect(parseWriteNotice({ space: SPACE, repo: 'alice.test', rev: '3a' })).toBeNull()
})

// --- Debounce ---

test('a burst of notices for one repo collapses into a single sync', async () => {
  // One member writing a gallery sends a notice per record, and each is an
  // invitation to read the same repo again.
  vi.useFakeTimers()
  const run = vi.fn().mockResolvedValue(undefined)
  for (let i = 0; i < 5; i++) scheduleNoticeSync('space|writer', run, 100)
  await vi.advanceTimersByTimeAsync(200)
  expect(run).toHaveBeenCalledTimes(1)
})

test('different repos are synced separately', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockResolvedValue(undefined)
  scheduleNoticeSync('space|alice', run, 100)
  scheduleNoticeSync('space|bob', run, 100)
  await vi.advanceTimersByTimeAsync(200)
  expect(run).toHaveBeenCalledTimes(2)
})

test('a failing sync is reported rather than thrown at the authority', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockRejectedValue(new Error('host down'))
  scheduleNoticeSync('space|writer', run, 100)
  // A rejection here must stay inside the scheduler: an unhandled one would
  // take the process down over a host being briefly unreachable.
  await vi.advanceTimersByTimeAsync(200)
  expect(run).toHaveBeenCalled()
})

test('clearing drops work that has not run yet', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockResolvedValue(undefined)
  scheduleNoticeSync('space|writer', run, 100)
  clearPendingNotices()
  await vi.advanceTimersByTimeAsync(200)
  expect(run).not.toHaveBeenCalled()
})
