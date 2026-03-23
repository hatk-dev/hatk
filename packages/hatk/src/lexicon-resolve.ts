// Lexicon resolver — fetches lexicons from the AT Protocol registry via DNS → DID → PDS chain
// and recursively resolves all $ref dependencies.

import { isValidDid } from '@bigmoves/lexicon'
import { join } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

// --- Authority ---

function nsidToDomain(nsid: string): string {
  const parts = nsid.split('.')
  return parts.slice(0, 2).reverse().join('.')
}

function domainToLexiconDns(domain: string): string {
  return `_lexicon.${domain}`
}

// --- DNS ---

function parseDidFromTxt(txt: string): string | null {
  if (!txt) return null
  const unquoted = txt.replace(/^"|"$/g, '')
  const match = unquoted.match(/^did=(.+)$/)
  if (!match) return null
  const did = match[1]
  return isValidDid(did) ? did : null
}

async function lookupTxt(domain: string, opts: { dohUrl?: string; fetch?: typeof fetch } = {}): Promise<string[]> {
  const dohUrl = opts.dohUrl ?? 'https://cloudflare-dns.com/dns-query'
  const fetchFn = opts.fetch ?? globalThis.fetch

  try {
    const url = `${dohUrl}?name=${encodeURIComponent(domain)}&type=TXT`
    const response = await fetchFn(url, {
      headers: { Accept: 'application/dns-json' },
    })

    if (!response.ok) return []

    const data = await response.json()
    if (!data.Answer) return []

    return data.Answer.filter((record: any) => record.type === 16).map(
      (record: any) => record.data?.replace(/^"|"$/g, '') ?? '',
    )
  } catch {
    return []
  }
}

// --- DID ---

function extractPdsEndpoint(didDoc: any): string | null {
  if (!didDoc?.service || !Array.isArray(didDoc.service)) return null
  const pdsService = didDoc.service.find((s: any) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer')
  return pdsService?.serviceEndpoint ?? null
}

async function resolveDid(did: string, opts: { plcUrl?: string; fetch?: typeof fetch } = {}): Promise<string | null> {
  const plcUrl = opts.plcUrl ?? 'https://plc.directory'
  const fetchFn = opts.fetch ?? globalThis.fetch

  try {
    let didDocUrl: string
    if (did.startsWith('did:plc:')) {
      didDocUrl = `${plcUrl}/${did}`
    } else if (did.startsWith('did:web:')) {
      const domain = did.slice('did:web:'.length)
      didDocUrl = `https://${domain}/.well-known/did.json`
    } else {
      return null
    }

    const response = await fetchFn(didDocUrl)
    if (!response.ok) return null
    const didDoc = await response.json()
    return extractPdsEndpoint(didDoc)
  } catch {
    return null
  }
}

interface Lexicon {
  lexicon: number
  id: string
  defs: Record<string, any>
  [key: string]: any
}

// --- Built-in core schemas (loaded from src/lexicons/) ---

function loadCoreSchemas(): Record<string, Lexicon> {
  const schemas: Record<string, Lexicon> = {}
  const lexDir = join(import.meta.dirname!, 'lexicons')

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.json')) {
        const lexicon = JSON.parse(readFileSync(full, 'utf-8'))
        if (lexicon.id) schemas[lexicon.id] = lexicon
      }
    }
  }

  try { walk(lexDir) } catch {}
  return schemas
}

const coreSchemas: Record<string, Lexicon> = loadCoreSchemas()

// --- Resolver ---

function refToNsid(ref: string): string | null {
  let nsid = ref.startsWith('lex:') ? ref.slice(4) : ref
  const hashIndex = nsid.indexOf('#')
  if (hashIndex !== -1) nsid = nsid.slice(0, hashIndex)
  const parts = nsid.split('.')
  return parts.length >= 3 ? nsid : null
}

function extractRefs(schema: Lexicon): string[] {
  const refs = new Set<string>()

  const walk = (obj: unknown) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item)
      return
    }
    const record = obj as Record<string, unknown>
    if (record.type === 'ref' && typeof record.ref === 'string') {
      const nsid = refToNsid(record.ref)
      if (nsid) refs.add(nsid)
    }
    if (record.type === 'union' && Array.isArray(record.refs)) {
      for (const ref of record.refs) {
        if (typeof ref === 'string') {
          const nsid = refToNsid(ref)
          if (nsid) refs.add(nsid)
        }
      }
    }
    for (const value of Object.values(record)) walk(value)
  }

  walk(schema)
  return Array.from(refs)
}

async function fetchLexicon(nsid: string): Promise<Lexicon | null> {
  const domain = nsidToDomain(nsid)
  const dnsName = domainToLexiconDns(domain)

  const txtRecords = await lookupTxt(dnsName)

  let did: string | null = null
  for (const txt of txtRecords) {
    did = parseDidFromTxt(txt)
    if (did) break
  }
  if (!did) return null

  const pdsEndpoint = await resolveDid(did)
  if (!pdsEndpoint) return null

  const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=com.atproto.lexicon.schema&rkey=${encodeURIComponent(nsid)}`
  const response = await fetch(url)
  if (!response.ok) return null

  const data = await response.json()
  return data.value ?? null
}

/**
 * Resolve a lexicon by NSID from the AT Protocol registry,
 * recursively fetching all referenced lexicons.
 * Returns a map of NSID → Lexicon for all resolved schemas.
 */
export async function resolveLexicon(nsid: string): Promise<Map<string, Lexicon>> {
  const resolved = new Map<string, Lexicon>()

  async function resolve(nsid: string): Promise<void> {
    if (resolved.has(nsid)) return

    // Check built-in core schemas first
    if (coreSchemas[nsid]) {
      console.log(`  ${nsid} (built-in)`)
      resolved.set(nsid, coreSchemas[nsid])
      const refs = extractRefs(coreSchemas[nsid])
      for (const ref of refs) await resolve(ref)
      return
    }

    console.log(`  resolving ${nsid}...`)
    const lexicon = await fetchLexicon(nsid)
    if (!lexicon) {
      console.log(`  could not resolve ${nsid}`)
      return
    }

    resolved.set(nsid, lexicon)

    const refs = extractRefs(lexicon)
    for (const ref of refs) {
      await resolve(ref)
    }
  }

  await resolve(nsid)
  return resolved
}
