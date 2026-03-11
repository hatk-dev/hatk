// Lexicon resolver — fetches lexicons from the AT Protocol registry via DNS → DID → PDS chain
// and recursively resolves all $ref dependencies.

import { isValidDid } from '@bigmoves/lexicon'

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

// --- Built-in core schemas (not published via DNS) ---

const coreSchemas: Record<string, Lexicon> = {
  'com.atproto.repo.strongRef': {
    lexicon: 1,
    id: 'com.atproto.repo.strongRef',
    description: 'A URI with a content-hash fingerprint.',
    defs: {
      main: {
        type: 'object',
        required: ['uri', 'cid'],
        properties: { uri: { type: 'string', format: 'at-uri' }, cid: { type: 'string', format: 'cid' } },
      },
    },
  },
  'com.atproto.label.defs': {
    lexicon: 1,
    id: 'com.atproto.label.defs',
    defs: {
      label: {
        type: 'object',
        description: 'Metadata tag on an atproto resource (eg, repo or record).',
        required: ['src', 'uri', 'val', 'cts'],
        properties: {
          ver: { type: 'integer' },
          src: { type: 'string', format: 'did' },
          uri: { type: 'string', format: 'uri' },
          cid: { type: 'string', format: 'cid' },
          val: { type: 'string', maxLength: 128 },
          neg: { type: 'boolean' },
          cts: { type: 'string', format: 'datetime' },
          exp: { type: 'string', format: 'datetime' },
          sig: { type: 'bytes' },
        },
      },
      selfLabels: {
        type: 'object',
        description: 'Metadata tags on an atproto record, published by the author within the record.',
        required: ['values'],
        properties: { values: { type: 'array', items: { type: 'ref', ref: '#selfLabel' }, maxLength: 10 } },
      },
      selfLabel: { type: 'object', required: ['val'], properties: { val: { type: 'string', maxLength: 128 } } },
      labelValueDefinition: {
        type: 'object',
        description: 'Declares a label value and its expected interpretations and behaviors.',
        required: ['identifier', 'severity', 'blurs', 'locales'],
        properties: {
          identifier: { type: 'string', maxLength: 100 },
          severity: { type: 'string', knownValues: ['inform', 'alert', 'none'] },
          blurs: { type: 'string', knownValues: ['content', 'media', 'none'] },
          defaultSetting: { type: 'string', knownValues: ['ignore', 'warn', 'hide'] },
          adultOnly: { type: 'boolean' },
          locales: { type: 'array', items: { type: 'ref', ref: '#labelValueDefinitionStrings' } },
        },
      },
      labelValueDefinitionStrings: {
        type: 'object',
        required: ['lang', 'name', 'description'],
        properties: {
          lang: { type: 'string', format: 'language' },
          name: { type: 'string', maxLength: 640 },
          description: { type: 'string', maxLength: 100000 },
        },
      },
      labelValue: {
        type: 'string',
        knownValues: [
          '!hide',
          '!no-promote',
          '!warn',
          '!no-unauthenticated',
          'dmca-violation',
          'doxxing',
          'porn',
          'sexual',
          'nudity',
          'nsfl',
          'gore',
        ],
      },
    },
  },
  'com.atproto.moderation.defs': {
    lexicon: 1,
    id: 'com.atproto.moderation.defs',
    defs: {
      reasonType: {
        type: 'string',
        knownValues: [
          'com.atproto.moderation.defs#reasonSpam',
          'com.atproto.moderation.defs#reasonViolation',
          'com.atproto.moderation.defs#reasonMisleading',
          'com.atproto.moderation.defs#reasonSexual',
          'com.atproto.moderation.defs#reasonRude',
          'com.atproto.moderation.defs#reasonOther',
          'com.atproto.moderation.defs#reasonAppeal',
        ],
      },
      reasonSpam: { type: 'token', description: 'Spam: frequent unwanted promotion, replies, mentions.' },
      reasonViolation: { type: 'token', description: 'Direct violation of server rules, laws, terms of service.' },
      reasonMisleading: { type: 'token', description: 'Misleading identity, affiliation, or content.' },
      reasonSexual: { type: 'token', description: 'Unwanted or mislabeled sexual content.' },
      reasonRude: { type: 'token', description: 'Rude, harassing, explicit, or otherwise unwelcoming behavior.' },
      reasonOther: { type: 'token', description: 'Reports not falling under another report category.' },
      reasonAppeal: { type: 'token', description: 'Appeal a previously taken moderation action.' },
      subjectType: {
        type: 'string',
        description: 'Tag describing a type of subject that might be reported.',
        knownValues: ['account', 'record', 'chat'],
      },
    },
  },
}

// --- Resolver ---

interface Lexicon {
  lexicon: number
  id: string
  defs: Record<string, any>
  [key: string]: any
}

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
