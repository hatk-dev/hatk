/**
 * What a PDS says it serves, and the scopes worth asking it for.
 *
 * `community.lexicon.service.describe` answers with a service's roles and every
 * XRPC method it routes. It is the direct question and the answer to trust when
 * it comes — but it is still a proposal, and implementations exist that serve
 * the features while serving no describe. The reference spaces build of
 * `@atproto/pds` is one: it routes every space method and does not contain the
 * describe NSID at all. Reading its silence as "no optional features" denies it
 * scopes it could honor.
 *
 * So when describe says nothing, the methods a caller actually cares about are
 * probed directly. Calling one and reading the failure cannot tell a missing
 * feature from a broken server *on its own* — but it can against a control: ask
 * for an NSID that certainly does not exist, learn how this server says "no such
 * method", and a different answer for a real method is evidence it has one.
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

/** An NSID no server routes, for learning how one says "no such method". */
const CONTROL_NSID = 'dev.hatk.unspecced.methodThatDoesNotExist'

/** How a server answered, as a comparable string: status and error code. */
async function signature(pdsEndpoint: string, nsid: string): Promise<string | null> {
  try {
    const res = await fetch(`${pdsEndpoint.replace(/\/$/, '')}/xrpc/${nsid}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    return `${res.status}:${body?.error ?? ''}`
  } catch {
    return null
  }
}

/**
 * Which of `candidates` this server appears to route, judged against how it
 * answers for a method that does not exist.
 *
 * Conservative by construction. A server that answers identically either way —
 * bsky.social returns `401 AuthMissing` for both — yields nothing, so a feature
 * it does not have is never claimed. The cost is failing to see support that
 * cannot be distinguished, which is where this started anyway.
 */
async function probeMethods(pdsEndpoint: string, candidates: string[]): Promise<Set<string>> {
  const control = await signature(pdsEndpoint, CONTROL_NSID)
  // Unreachable is not evidence about the server, so claim nothing.
  if (control === null) return new Set<string>()

  const answers = await Promise.all(candidates.map((n) => signature(pdsEndpoint, n)))
  const found = new Set<string>()
  candidates.forEach((nsid, i) => {
    const a = answers[i]
    if (a !== null && a !== control) found.add(nsid)
  })
  return found
}

/**
 * Every XRPC method a PDS serves, as far as it can be established.
 *
 * `candidates` are the methods the caller needs an answer about. They are only
 * used when describe says nothing — an explicit list is always preferred to
 * inference, and a server that answers describe is taken at its word.
 */
export async function describeMethods(pdsEndpoint: string, candidates: string[] = []): Promise<Set<string>> {
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

  // No describe, or one that listed nothing: fall back to asking about the
  // methods this caller actually needs. Only those — a probe per method is a
  // request per method, and the conditional sets name two.
  if (methods.size === 0 && candidates.length > 0) {
    methods = await probeMethods(pdsEndpoint, candidates)
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

  const methods = await describeMethods(
    pdsEndpoint,
    conditional.map((c) => c.whenMethod),
  )
  const granted = conditional.filter((c) => methods.has(c.whenMethod)).flatMap((c) => c.scopes)
  if (granted.length === 0) return base

  emit('oauth', 'conditional_scopes', { pds: pdsEndpoint, scopes: granted })
  return [base, ...granted].join(' ')
}

/** Drop cached describe answers. For tests. */
export function clearDescribeCache(): void {
  cache.clear()
}
