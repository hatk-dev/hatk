/**
 * Resolving the services a space is reached through.
 *
 * Two different endpoints matter, and they are usually but not always the same
 * host:
 *
 *   the authority's space host — issues credentials, enumerates writers
 *   each writer's own PDS       — holds that writer's records and blobs
 *
 * A space is the aggregation of one repo per writer, each on the writer's own
 * server, so reading one means talking to every writer's host with a credential
 * the authority signed. There is no single server that has all of it.
 */

import { pdsFor } from '../backfill.ts'

interface DidDocument {
  service?: { id?: string; type?: string; serviceEndpoint?: string }[]
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
  return pending
}

function serviceEndpoint(doc: DidDocument | null, id: string): string | undefined {
  return doc?.service?.find((s) => s.id === id || s.id?.endsWith(id))?.serviceEndpoint
}

/**
 * Where to send credential and writer-set requests for a space.
 *
 * The authority may publish a dedicated `#atproto_space_host`; one that does
 * not is still reached at its `#atproto_pds`, which is the case for every
 * community host built on the reference implementation.
 */
export async function spaceHostEndpoint(authority: string): Promise<string> {
  const doc = await fetchDidDoc(authority)
  const endpoint = serviceEndpoint(doc, '#atproto_space_host') ?? serviceEndpoint(doc, '#atproto_pds')
  if (!endpoint) throw new Error(`No space host or PDS endpoint in DID document for ${authority}`)
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
