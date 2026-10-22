/**
 * The HTTP message signature a space credential travels with.
 *
 * A credential is bound to a P-256 key made for it alone and named by its
 * did:key (the credential's `cnf.kid`). Every request that presents it signs
 * the credential together with the DID the request is addressed to, under
 * RFC 9421's label and tag `atproto-space-credential`, so a credential lifted
 * off one request cannot be replayed at another account by anyone without the
 * key.
 *
 * The signing itself is `@atproto/space`'s, so the headers match the reference
 * verifier byte for byte.
 */

import { P256Keypair } from '@atproto/crypto'
import { createSpaceSigHeaders } from '@atproto/space'

/** The Authorization scheme a space credential is presented under. */
export const CREDENTIAL_SCHEME = 'Atproto-Space-Credential'

/** A credential's key: `did()` names it, and it is held in memory only. */
export type SpaceSigKey = P256Keypair

/** A fresh P-256 key, never exported. */
export function generateSpaceSigKey(): Promise<SpaceSigKey> {
  return P256Keypair.create()
}

/**
 * Authorization, audience and signature headers presenting `credential` to
 * `audience`: the repo a request names, or the space's authority.
 */
export function spaceSigHeaders(
  key: SpaceSigKey,
  credential: string,
  audience: string,
): Promise<Record<string, string>> {
  return createSpaceSigHeaders(key, {
    authorization: `${CREDENTIAL_SCHEME} ${credential}`,
    audience: audience as `did:${string}:${string}`,
  })
}
