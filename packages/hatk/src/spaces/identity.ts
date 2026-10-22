/**
 * Resolving the services a space is reached through.
 *
 * Two different endpoints matter, and they are usually but not always the same
 * host:
 *
 *   the authority's PDS   — issues credentials, enumerates writers
 *   each writer's own PDS — holds that writer's records and blobs
 *
 * A space is the aggregation of one repo per writer, each on the writer's own
 * server, so reading one means talking to every writer's host with a credential
 * the authority signed. There is no single server that has all of it.
 */

import { pdsFor } from '../backfill.ts'
import { parseMultibaseKey, type PublicKey } from './verify.ts'

interface DidDocument {
  service?: { id?: string; type?: string; serviceEndpoint?: string }[]
  verificationMethod?: { id?: string; type?: string; publicKeyMultibase?: string }[]
}

let plcUrl = 'https://plc.directory'

export function configureSpaceIdentity(url: string): void {
  plcUrl = url
}

const docCache = new Map<string, Promise<DidDocument | null>>()

function fetchDidDoc(did: string): Promise<DidDocument | null> {
  const cached = docCache.get(did)
  if (cached) return cached
  const pending = (async () => {
    try {
      const url = did.startsWith('did:web:')
        ? `https://${decodeURIComponent(did.slice('did:web:'.length)).replace(/:/g, '/')}/.well-known/did.json`
        : `${plcUrl}/${did}`
      const res = await fetch(url)
      if (!res.ok) return null
      return (await res.json()) as DidDocument
    } catch {
      return null
    }
  })()
  docCache.set(did, pending)
  // A failed lookup is not an answer: the next call asks again.
  void pending.then((doc) => {
    if (doc === null && docCache.get(did) === pending) docCache.delete(did)
  })
  return pending
}

function serviceEndpoint(doc: DidDocument | null, id: string): string | undefined {
  return doc?.service?.find((s) => s.id === id || s.id?.endsWith(id))?.serviceEndpoint
}

/**
 * Where to send credential and writer-set requests for a space: the
 * authority's own PDS, as its DID document publishes it.
 */
export async function spaceHostEndpoint(authority: string): Promise<string> {
  const doc = await fetchDidDoc(authority)
  const endpoint = serviceEndpoint(doc, '#atproto_pds')
  if (!endpoint) throw new Error(`No PDS endpoint in DID document for ${authority}`)
  return endpoint
}

/** Where a writer's repo in a space lives: their own PDS, wherever that is. */
export function repoEndpoint(did: string): Promise<string> {
  return pdsFor(did)
}

/** Drop cached DID documents. For tests, and for a host that has just moved. */
export function clearSpaceIdentityCache(): void {
  docCache.clear()
}

function verificationMethod(doc: DidDocument | null, id: string) {
  return doc?.verificationMethod?.find((m) => m.id === id || m.id?.endsWith(id))
}

/**
 * An account's atproto signing key, as its DID document publishes it.
 *
 * Used to check that a write notice really came from the space authority it
 * claims to: everything an authority signs for a space, it signs with
 * `#atproto`.
 */
export async function atprotoSigningKey(did: string): Promise<PublicKey | null> {
  const method = verificationMethod(await fetchDidDoc(did), '#atproto')
  if (!method?.publicKeyMultibase) return null
  try {
    return parseMultibaseKey(method.publicKeyMultibase)
  } catch {
    return null
  }
}

/**
 * An account's `#atproto_kem` key as a P-256 did:key: what a syncer encrypts a
 * request's key share against, so that only the account's own host can answer
 * it with a MAC.
 *
 * Hosts add this key to accounts that predate it, so a document cached without
 * one is fetched again once before the answer is no.
 */
export async function kemKey(did: string): Promise<string | null> {
  let method = verificationMethod(await fetchDidDoc(did), '#atproto_kem')
  if (!method) {
    docCache.delete(did)
    method = verificationMethod(await fetchDidDoc(did), '#atproto_kem')
  }
  const multibase = method?.publicKeyMultibase
  if (!multibase) return null
  try {
    if (parseMultibaseKey(multibase).curve !== 'p256') return null
  } catch {
    return null
  }
  return `did:key:${multibase}`
}
