/**
 * What a PDS says it serves, and the scopes worth asking it for.
 *
 * `community.lexicon.service.describe` answers with a service's roles and every
 * XRPC method it routes. It is the only way to ask: atproto publishes no method
 * list, so the alternative is to call a method and read the failure, where a
 * server without an optional feature and one that is broken look alike.
 *
 * Used before pushing an authorization request, so a PDS is asked for a
 * feature's scopes only when it implements the feature.
 */
import type { OAuthConfig } from '../config.ts'
import { emit } from '../logger.ts'

const DESCRIBE_NSID = 'community.lexicon.service.describe'
const PROBE_TIMEOUT_MS = 5000
const CACHE_TTL_MS = 60 * 60 * 1000

/** Answers are a property of the server, so one entry covers every account on it. */
const cache = new Map<string, { methods: Set<string>; expires: number }>()

/**
 * Every XRPC method a PDS serves. An empty set for a server that answers no
 * describe — which is every PDS that predates the method, so absence has to
 * read as "no optional features" rather than as an error.
 */
export async function describeMethods(pdsEndpoint: string): Promise<Set<string>> {
  const cached = cache.get(pdsEndpoint)
  if (cached && cached.expires > Date.now()) return cached.methods

  let methods = new Set<string>()
  try {
    const res = await fetch(`${pdsEndpoint.replace(/\/$/, '')}/xrpc/${DESCRIBE_NSID}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { methods?: { value?: unknown }[] } | null
      if (Array.isArray(body?.methods)) {
        for (const m of body.methods) {
          if (typeof m?.value === 'string') methods.add(m.value)
        }
      }
    }
  } catch {
    methods = new Set<string>()
  }

  cache.set(pdsEndpoint, { methods, expires: Date.now() + CACHE_TTL_MS })
  return methods
}

/**
 * The scope string to request from this PDS: `base`, plus any conditional set
 * whose `whenMethod` the server serves.
 *
 * Loopback clients are left alone. Their client_id encodes the scope they may
 * request, and the token exchange rebuilds that client_id from config — vary
 * the request and the two disagree. A local setup that needs the extra scopes
 * lists them in its client's own `scope` instead.
 */
export async function negotiateScope(
  config: OAuthConfig,
  base: string,
  pdsEndpoint: string | undefined,
  isLoopback: boolean,
): Promise<string> {
  const conditional = config.conditionalScopes ?? []
  if (conditional.length === 0 || !pdsEndpoint || isLoopback) return base

  const methods = await describeMethods(pdsEndpoint)
  const granted = conditional.filter((c) => methods.has(c.whenMethod)).flatMap((c) => c.scopes)
  if (granted.length === 0) return base

  emit('oauth', 'conditional_scopes', { pds: pdsEndpoint, scopes: granted })
  return [base, ...granted].join(' ')
}

/** Drop cached describe answers. For tests. */
export function clearDescribeCache(): void {
  cache.clear()
}
