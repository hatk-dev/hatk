/**
 * Receiving write notices from a space authority.
 *
 * A space's writes never reach a firehose, so an authority tells its
 * subscribers directly: register once, and every write into the space arrives
 * as a `notifyWrite` carrying the repo and the revision it reached — and no
 * records. The notice says something moved; reading it is still the syncer's
 * job, with its own credential.
 *
 * This only makes sync prompt, never correct. Delivery is best-effort by
 * design: the reference host forwards each notice once from an in-memory queue
 * and logs the failure, so a missed one is recovered by the reconcile sweep or
 * by the next write. Nothing here may be load-bearing.
 *
 * ## Why this needs its own verifier
 *
 * A forwarded notice does not look like the one a PDS sends its own authority.
 * At origin, a writer's host signs with `iss` = the writer and `aud` = the bare
 * authority DID. Forwarded onward, the authority re-signs with `iss` = itself
 * and `aud` = the registered service identifier *including its fragment*. The
 * reference PDS's own inbound handler rejects exactly that shape — it requires
 * `iss` to equal the claimed writer and `aud` to equal the bare authority — so
 * a receiver cannot borrow it and has to check the forwarded shape itself.
 */

import { emit } from '../logger.ts'
import { atprotoSigningKey } from './identity.ts'
import { parseSpaceRef } from './uri.ts'
import { verifySignature } from './verify.ts'

/** Clock skew tolerated on a notice's expiry. The reference signs them for 60s. */
const SKEW_SEC = 60

export class NoticeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(padded, 'base64'))
}

interface ServiceAuthPayload {
  iss?: string
  aud?: string
  lxm?: string
  exp?: number
}

/**
 * Check a service-auth JWT that claims to come from `expectedIss`.
 *
 * The audience must match this instance's own service identifier exactly,
 * fragment included: a token addressed to somebody else is not ours to act on
 * however valid its signature. The method is checked for the same reason — a
 * token minted for one call must not be replayable against another.
 */
export async function verifyNotice(
  authorization: string | null,
  expected: { iss: string; aud: string; lxm: string },
): Promise<void> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!token) throw new NoticeError(401, 'Missing service auth')

  const parts = token.split('.')
  if (parts.length !== 3) throw new NoticeError(401, 'Malformed service auth')

  let payload: ServiceAuthPayload
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as ServiceAuthPayload
  } catch {
    throw new NoticeError(401, 'Malformed service auth')
  }

  // The issuer is checked against the space named in the body rather than
  // trusted from the token, so a valid token from one authority cannot be used
  // to speak about another authority's space.
  if (payload.iss?.split('#')[0] !== expected.iss) {
    throw new NoticeError(403, 'Notice issuer is not the space authority')
  }
  if (payload.aud !== expected.aud) throw new NoticeError(403, 'Notice is addressed elsewhere')
  if (payload.lxm !== expected.lxm) throw new NoticeError(403, 'Notice is for a different method')
  if (typeof payload.exp !== 'number' || payload.exp + SKEW_SEC < Date.now() / 1000) {
    throw new NoticeError(401, 'Notice has expired')
  }

  const key = await atprotoSigningKey(expected.iss)
  if (!key) throw new NoticeError(502, `Could not resolve a signing key for ${expected.iss}`)

  const message = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  if (!verifySignature(key, base64UrlToBytes(parts[2]), message)) {
    throw new NoticeError(403, 'Notice signature does not verify')
  }
}

export interface WriteNotice {
  space: string
  repo: string
  rev: string
}

export function parseWriteNotice(body: unknown): WriteNotice | null {
  if (!body || typeof body !== 'object') return null
  const { space, repo, rev } = body as Record<string, unknown>
  if (typeof space !== 'string' || typeof repo !== 'string' || typeof rev !== 'string') return null
  if (!parseSpaceRef(space) || !repo.startsWith('did:')) return null
  return { space, repo, rev }
}

/**
 * Collapse a burst of notices for the same repo into one sync.
 *
 * A member writing a gallery produces a notice per record, and syncing per
 * notice would read the same repo a dozen times over a few seconds. A short
 * trailing delay turns that into one read, which is also what keeps a flood —
 * forged or otherwise — from costing more than one sync per interval.
 */
const DEBOUNCE_MS = 750

const pending = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleNoticeSync(key: string, run: () => Promise<void>, delay = DEBOUNCE_MS): void {
  const existing = pending.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    pending.delete(key)
    void run().catch((err) => emit('spaces', 'notice_sync_failed', { key, error: err?.message ?? String(err) }))
  }, delay)
  timer.unref?.()
  pending.set(key, timer)
}

/** Drop every pending sync. For shutdown, and for tests. */
export function clearPendingNotices(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
}
