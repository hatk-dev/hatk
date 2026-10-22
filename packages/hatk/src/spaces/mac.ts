/**
 * Asking a repo host to vouch for what it serves.
 *
 * A space commit carries no signature. Its host authenticates it to one syncer
 * at a time with a MAC, keyed by a secret only the two of them can derive: the
 * syncer sends a fresh P-256 key share with each request, encapsulated against
 * the writer's `#atproto_kem` key, and the host answers with
 * `Atproto-Space-Mac` over the commit (or record) it returned. A leaked
 * response then proves nothing to anyone else.
 *
 * Required on getRepo, getLatestCommit, listRepoOps and getRecord whenever a
 * space credential is presented; a request without one is refused with
 * `BadSpaceMac`. The derivation and header formats are `@atproto/space`'s.
 */

import {
  COMMIT_MAC_TYPE,
  MAC_HEADER,
  type MacType,
  RECORD_MAC_TYPE,
  SpaceMacError,
  WANT_MAC_HEADER,
  encapsulate,
  formatWantMacHeader,
  parseMacHeader,
} from '@atproto/space'
import { kemKey } from './identity.ts'

export { COMMIT_MAC_TYPE, RECORD_MAC_TYPE, type MacType }

export interface MacRequest {
  type: MacType
  /** The `Atproto-Space-Want-Mac` header to send with the request. */
  headers: Record<string, string>
  sharedSecret: Uint8Array
}

/** A fresh key share for one request to `repo`'s host. Never reuse one. */
export async function requestMac(type: MacType, repo: string): Promise<MacRequest> {
  const key = await kemKey(repo)
  if (!key) throw new SpaceMacError(`No #atproto_kem key in the DID document for ${repo}`)
  const { keyShare, sharedSecret } = await encapsulate(key)
  return { type, headers: { [WANT_MAC_HEADER]: formatWantMacHeader(type, keyShare) }, sharedSecret }
}

/** The MAC a response carried for `request`. Throws if it carried none. */
export function responseMac(res: Response, request: MacRequest): Uint8Array {
  return parseMacHeader(res.headers.get(MAC_HEADER) ?? undefined, request.type)
}
