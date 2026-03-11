import { createServer, type Server, type IncomingMessage } from 'node:http'
import { gzipSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import {
  queryRecords,
  getRecordByUri,
  searchRecords,
  getSchema,
  reshapeRow,
  setRepoStatus,
  getRepoStatus,
  getRepoRetryInfo,
  querySQL,
  insertRecord,
  deleteRecord,
  queryLabelsForUris,
  insertLabels,
  searchAccounts,
  listReposPaginated,
  getCollectionCounts,
  normalizeValue,
  getSchemaDump,
  getPreferences,
  putPreference,
} from './db.ts'
import { executeFeed, listFeeds } from './feeds.ts'
import { executeXrpc, InvalidRequestError } from './xrpc.ts'
import { getLexiconArray } from './schema.ts'
import { validateRecord } from '@bigmoves/lexicon'
import { resolveRecords } from './hydrate.ts'
import { handleOpengraphRequest, buildOgMeta } from './opengraph.ts'
import { getLabelDefinitions, rescanLabels } from './labels.ts'
import { triggerAutoBackfill } from './indexer.ts'
import { log, emit, timer } from './logger.ts'
import {
  getAuthServerMetadata,
  getProtectedResourceMetadata,
  getJwks,
  getClientMetadata,
  handlePar,
  buildAuthorizeRedirect,
  handleCallback,
  handleToken,
  authenticate,
  refreshPdsSession,
} from './oauth/server.ts'
import { getOAuthRequest } from './oauth/db.ts'
import { createDpopProof } from './oauth/dpop.ts'
import { getServerKey, getSession } from './oauth/db.ts'
import type { OAuthConfig } from './config.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function readBodyRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function startServer(
  port: number,
  collections: string[],
  publicDir: string | null,
  oauth: OAuthConfig | null,
  admins: string[] = [],
  resolveViewer?: (req: IncomingMessage) => { did: string } | null,
): Server {
  const coreXrpc = (method: string) => `/xrpc/dev.hatk.${method}`

  function requireAdmin(viewer: { did: string } | null, res: any): boolean {
    if (!viewer) {
      jsonError(res, 401, 'Authentication required')
      return false
    }
    if (!admins.includes(viewer.did)) {
      jsonError(res, 403, 'Admin access required')
      return false
    }
    return true
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`)

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const isXrpc = url.pathname.startsWith('/xrpc/')
    const isAdmin =
      url.pathname.startsWith('/admin') && !url.pathname.endsWith('.html') && !url.pathname.endsWith('.js')
    const elapsed = isXrpc || isAdmin ? timer() : null
    let error: string | undefined
    const requestOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['host'] || `localhost:${port}`}`

    // Authenticate viewer (optional — unauthenticated requests still work)
    let viewer: { did: string } | null = resolveViewer?.(req) ?? null
    if (!viewer && oauth) {
      try {
        viewer = await authenticate(
          (req.headers['authorization'] as string) || null,
          (req.headers['dpop'] as string) || null,
          req.method!,
          `${requestOrigin}${url.pathname}`,
        )
      } catch (err: any) {
        emit('oauth', 'authenticate_error', { error: err.message })
      }
    }

    try {
      // GET /xrpc/dev.hatk.getRecords?collection=<nsid>&limit=N&cursor=C&<field>=<value>
      if (url.pathname === coreXrpc('getRecords')) {
        const collection = url.searchParams.get('collection')
        if (!collection) {
          jsonError(res, 400, 'Missing collection parameter')
          return
        }
        if (!getSchema(collection)) {
          jsonError(res, 404, `Unknown collection: ${collection}`)
          return
        }

        const limit = parseInt(url.searchParams.get('limit') || '20')
        const cursor = url.searchParams.get('cursor') || undefined
        const sort = url.searchParams.get('sort') || undefined
        const order = (url.searchParams.get('order') || undefined) as 'asc' | 'desc' | undefined

        // Collect field filters (everything except reserved params)
        const reserved = new Set(['collection', 'limit', 'cursor', 'sort', 'order'])
        const filters: Record<string, string> = {}
        for (const [key, value] of url.searchParams) {
          if (!reserved.has(key)) filters[key] = value
        }

        const result = await queryRecords(collection, {
          limit,
          cursor,
          sort,
          order,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        })

        const uris = result.records.map((r: any) => r.uri)
        const items = await resolveRecords(uris)
        jsonResponse(res, { items, cursor: result.cursor })
        return
      }

      // GET /xrpc/dev.hatk.getRecord?uri=<at-uri>
      if (url.pathname === coreXrpc('getRecord')) {
        const uri = url.searchParams.get('uri')
        if (!uri) {
          jsonError(res, 400, 'Missing uri parameter')
          return
        }

        const record = await getRecordByUri(uri)
        if (!record) {
          jsonError(res, 404, 'Record not found')
          return
        }

        const shaped = reshapeRow(record, record?.__childData) as Record<string, any>
        const labelsMap = await queryLabelsForUris([record.uri])
        if (shaped) shaped.labels = labelsMap.get(record.uri) || []
        jsonResponse(res, { record: shaped })
        return
      }

      // GET /xrpc/dev.hatk.getFeed?feed=<name>&limit=N&cursor=C
      if (url.pathname === coreXrpc('getFeed')) {
        const feedName = url.searchParams.get('feed')
        if (!feedName) {
          jsonError(res, 400, 'Missing feed parameter')
          return
        }
        const limit = parseInt(url.searchParams.get('limit') || '30')
        const cursor = url.searchParams.get('cursor') || undefined

        const params: Record<string, string> = {}
        for (const [key, value] of url.searchParams) {
          params[key] = value
        }

        const result = await executeFeed(feedName, params, cursor, limit, viewer)
        if (!result) {
          jsonError(res, 404, `Unknown feed: ${feedName}`)
          return
        }

        jsonResponse(res, result)
        return
      }

      // GET /xrpc/dev.hatk.searchRecords?collection=<nsid>&q=<query>&limit=N&cursor=C
      if (url.pathname === coreXrpc('searchRecords')) {
        const collection = url.searchParams.get('collection')
        const q = url.searchParams.get('q')
        if (!collection) {
          jsonError(res, 400, 'Missing collection parameter')
          return
        }
        if (!q) {
          jsonError(res, 400, 'Missing q parameter')
          return
        }
        if (!getSchema(collection)) {
          jsonError(res, 404, `Unknown collection: ${collection}`)
          return
        }

        const limit = parseInt(url.searchParams.get('limit') || '20')
        const cursor = url.searchParams.get('cursor') || undefined
        const fuzzy = url.searchParams.get('fuzzy') !== 'false'

        const result = await searchRecords(collection, q, { limit, cursor, fuzzy })

        const uris = result.records.map((r: any) => r.uri)
        const items = await resolveRecords(uris)
        jsonResponse(res, { items, cursor: result.cursor })
        return
      }

      // GET /xrpc/dev.hatk.describeFeeds
      if (url.pathname === coreXrpc('describeFeeds')) {
        jsonResponse(res, { feeds: listFeeds() })
        return
      }

      // GET /xrpc/dev.hatk.describeCollections
      if (url.pathname === coreXrpc('describeCollections')) {
        const collectionInfo = collections.map((c) => {
          const schema = getSchema(c)
          return {
            collection: c,
            columns: schema?.columns.map((col) => ({
              name: col.name,
              originalName: col.originalName,
              type: col.duckdbType,
              required: col.notNull,
            })),
          }
        })
        jsonResponse(res, { collections: collectionInfo })
        return
      }

      // GET /xrpc/dev.hatk.describeLabels
      if (url.pathname === coreXrpc('describeLabels')) {
        jsonResponse(res, { definitions: getLabelDefinitions() })
        return
      }

      // GET /xrpc/dev.hatk.getPreferences — get all preferences for authenticated user
      if (url.pathname === coreXrpc('getPreferences')) {
        if (!viewer) {
          jsonError(res, 401, 'Authentication required')
          return
        }
        const prefs = await getPreferences(viewer.did)
        jsonResponse(res, { preferences: prefs })
        return
      }

      // POST /xrpc/dev.hatk.putPreference — set a single preference
      if (url.pathname === coreXrpc('putPreference') && req.method === 'POST') {
        if (!viewer) {
          jsonError(res, 401, 'Authentication required')
          return
        }
        const body = JSON.parse(await readBody(req))
        if (!body.key || typeof body.key !== 'string') {
          jsonError(res, 400, 'Missing or invalid key')
          return
        }
        if (body.value === undefined) {
          jsonError(res, 400, 'Missing value')
          return
        }
        await putPreference(viewer.did, body.key, body.value)
        jsonResponse(res, { success: true })
        return
      }

      // ── Admin Repo Management ──

      // POST /admin/repos/add — enqueue DIDs for backfill
      if (url.pathname === '/admin/repos/add' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const { dids } = JSON.parse(await readBody(req))
        if (!Array.isArray(dids)) {
          jsonError(res, 400, 'Missing dids array')
          return
        }
        for (const did of dids) {
          await setRepoStatus(did, 'pending')
          triggerAutoBackfill(did)
        }
        jsonResponse(res, { added: dids.length })
        return
      }

      // POST /admin/labels/rescan — retroactively apply label rules
      if (url.pathname === '/admin/labels/rescan' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const result = await rescanLabels(collections)
        jsonResponse(res, result)
        return
      }

      // ── Admin Endpoints ──

      // GET /admin/whoami — check if current viewer is admin
      if (url.pathname === '/admin/whoami') {
        if (!requireAdmin(viewer, res)) return
        jsonResponse(res, { did: viewer!.did, admin: true })
        return
      }

      // GET /admin/labels/definitions — get available label definitions
      if (url.pathname === '/admin/labels/definitions') {
        if (!requireAdmin(viewer, res)) return
        jsonResponse(res, { definitions: getLabelDefinitions() })
        return
      }

      // POST /admin/labels — apply a label
      if (url.pathname === '/admin/labels' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const { uri, val } = JSON.parse(await readBody(req))
        if (!uri || !val) {
          jsonError(res, 400, 'Missing uri or val')
          return
        }
        await insertLabels([{ src: 'admin', uri, val }])
        jsonResponse(res, { ok: true })
        return
      }

      // POST /admin/labels/reset — delete all labels of a given type
      if (url.pathname === '/admin/labels/reset' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const { val } = JSON.parse(await readBody(req))
        if (!val) {
          jsonError(res, 400, 'Missing val')
          return
        }
        const result = await querySQL(`SELECT COUNT(*)::INTEGER as count FROM _labels WHERE val = $1`, [val])
        const count = Number(result[0]?.count || 0)
        await querySQL(`DELETE FROM _labels WHERE val = $1`, [val])
        jsonResponse(res, { deleted: count })
        return
      }

      // POST /admin/labels/negate — negate a label
      if (url.pathname === '/admin/labels/negate' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const { uri, val } = JSON.parse(await readBody(req))
        if (!uri || !val) {
          jsonError(res, 400, 'Missing uri or val')
          return
        }
        await insertLabels([{ src: 'admin', uri, val, neg: true }])
        jsonResponse(res, { ok: true })
        return
      }

      // POST /admin/takedown — takedown an account
      if (url.pathname === '/admin/takedown' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const { did } = JSON.parse(await readBody(req))
        if (!did) {
          jsonError(res, 400, 'Missing did')
          return
        }
        await setRepoStatus(did, 'takendown')
        jsonResponse(res, { ok: true })
        return
      }

      // POST /admin/reverse-takedown — reverse a takedown
      if (url.pathname === '/admin/reverse-takedown' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const { did } = JSON.parse(await readBody(req))
        if (!did) {
          jsonError(res, 400, 'Missing did')
          return
        }
        await setRepoStatus(did, 'active')
        jsonResponse(res, { ok: true })
        return
      }

      // GET /admin/search — search records or accounts
      if (url.pathname === '/admin/search') {
        if (!requireAdmin(viewer, res)) return
        const q = url.searchParams.get('q') || ''
        const type = url.searchParams.get('type') || 'records'
        const limit = parseInt(url.searchParams.get('limit') || '20')

        if (type === 'accounts') {
          const accounts = await searchAccounts(q, limit)
          jsonResponse(res, { accounts })
          return
        }

        // No query — live firehose activity (excludes bulk backfill records)
        if (!q) {
          const offset = parseInt(url.searchParams.get('offset') || '0')
          const allResults: any[] = []
          for (const col of collections) {
            try {
              const schema = getSchema(col)
              if (!schema) continue
              // Only show records indexed after the repo's backfill completed (live activity)
              const rows = await querySQL(
                `SELECT t.* FROM ${schema.tableName} t JOIN _repos r ON t.did = r.did WHERE t.indexed_at > r.backfilled_at ORDER BY t.indexed_at DESC LIMIT $1`,
                [limit + offset],
              )
              const uris = rows.map((r: any) => r.uri)
              const labelsMap = await queryLabelsForUris(uris)
              for (const rec of rows) {
                allResults.push({ ...reshapeRow(rec, rec?.__childData), labels: labelsMap.get(rec.uri) || [] })
              }
            } catch {}
          }
          allResults.sort((a, b) => {
            const ta = a.indexed_at || ''
            const tb = b.indexed_at || ''
            return ta > tb ? -1 : ta < tb ? 1 : 0
          })
          const page = allResults.slice(offset, offset + limit)
          jsonResponse(res, { records: page, total: allResults.length })
          return
        }

        // URI lookup
        if (q.startsWith('at://')) {
          const rec = await getRecordByUri(q)
          if (rec) {
            const labelsMap = await queryLabelsForUris([rec.uri])
            jsonResponse(res, {
              records: [{ ...reshapeRow(rec, rec?.__childData), labels: labelsMap.get(rec.uri) || [] }],
            })
          } else {
            jsonResponse(res, { records: [] })
          }
          return
        }

        // DID lookup — find all records by this DID
        if (q.startsWith('did:')) {
          const allResults: any[] = []
          for (const col of collections) {
            try {
              const result = await queryRecords(col, { filters: { did: q }, limit })
              const uris = result.records.map((r: any) => r.uri)
              const labelsMap = await queryLabelsForUris(uris)
              for (const rec of result.records) {
                allResults.push({
                  ...reshapeRow(rec, rec?.__childData),
                  labels: labelsMap.get(rec.uri) || [],
                })
              }
            } catch {}
          }
          jsonResponse(res, { records: allResults.slice(0, limit) })
          return
        }

        // Default: full-text search records across all collections
        const allResults: any[] = []
        for (const col of collections) {
          try {
            const result = await searchRecords(col, q, { limit })
            const uris = result.records.map((r: any) => r.uri)
            const labelsMap = await queryLabelsForUris(uris)
            for (const rec of result.records) {
              allResults.push({
                ...reshapeRow(rec, rec?.__childData),
                labels: labelsMap.get(rec.uri) || [],
              })
            }
          } catch {}
        }
        jsonResponse(res, { records: allResults.slice(0, limit) })
        return
      }

      // POST /admin/repos/resync — re-download repos
      if (url.pathname === '/admin/repos/resync' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const body = await readBody(req)
        const { dids } = body ? JSON.parse(body) : ({} as { dids?: string[] })
        let repoList: string[]
        if (Array.isArray(dids) && dids.length > 0) {
          repoList = dids
        } else {
          const rows = await querySQL(`SELECT did FROM _repos WHERE status = 'active'`)
          repoList = rows.map((r: any) => r.did)
        }
        for (const did of repoList) {
          await setRepoStatus(did, 'pending')
          triggerAutoBackfill(did)
        }
        jsonResponse(res, { resyncing: repoList.length })
        return
      }

      // POST /admin/repos/remove — remove DIDs from tracking
      if (url.pathname === '/admin/repos/remove' && req.method === 'POST') {
        if (!requireAdmin(viewer, res)) return
        const { dids } = JSON.parse(await readBody(req))
        if (!Array.isArray(dids)) {
          jsonError(res, 400, 'Missing dids array')
          return
        }
        for (const did of dids) {
          await querySQL(`DELETE FROM _repos WHERE did = $1`, [did])
        }
        jsonResponse(res, { removed: dids.length })
        return
      }

      // GET /admin/info — aggregate status + db size + collection counts
      if (url.pathname === '/admin/info') {
        if (!requireAdmin(viewer, res)) return
        const rows = await querySQL(`SELECT status, COUNT(*)::INTEGER as count FROM _repos GROUP BY status`)
        const counts: Record<string, number> = {}
        for (const row of rows) counts[row.status as string] = Number(row.count)
        const sizeRows = await querySQL(`SELECT database_size, memory_usage, memory_limit FROM pragma_database_size()`)
        const dbInfo = sizeRows[0] ?? {}
        const collectionCounts = await getCollectionCounts()
        jsonResponse(res, { repos: counts, duckdb: dbInfo, collections: collectionCounts })
        return
      }

      // GET /admin/info/:did — repo status info
      if (url.pathname.startsWith('/admin/info/did:')) {
        if (!requireAdmin(viewer, res)) return
        const did = url.pathname.slice('/admin/info/'.length)
        const status = await getRepoStatus(did)
        if (!status) {
          jsonError(res, 404, 'Repo not found')
          return
        }
        const retryInfo = await getRepoRetryInfo(did)
        jsonResponse(res, {
          did,
          status,
          retry_count: retryInfo?.retryCount ?? 0,
          retry_after: retryInfo?.retryAfter ?? 0,
        })
        return
      }

      // GET /admin/repos — paginated repo listing
      if (url.pathname === '/admin/repos' && req.method === 'GET') {
        if (!requireAdmin(viewer, res)) return
        const limit = parseInt(url.searchParams.get('limit') || '50')
        const offset = parseInt(url.searchParams.get('offset') || '0')
        const status = url.searchParams.get('status') || undefined
        const q = url.searchParams.get('q') || undefined
        const result = await listReposPaginated({ limit, offset, status, q })
        jsonResponse(res, result)
        return
      }

      // GET /admin/schema — full DuckDB DDL dump + lexicons
      if (url.pathname === '/admin/schema') {
        if (!requireAdmin(viewer, res)) return
        const { getAllLexicons } = await import('./schema.ts')
        const ddl = await getSchemaDump()
        jsonResponse(res, { ddl, lexicons: getAllLexicons() })
        return
      }

      // ── Public Repo Endpoints (used by hatk clients for auto-sync) ──

      // POST /repos/add — enqueue DIDs for backfill (public)
      if (url.pathname === '/repos/add' && req.method === 'POST') {
        const { dids } = JSON.parse(await readBody(req))
        if (!Array.isArray(dids)) {
          jsonError(res, 400, 'Missing dids array')
          return
        }
        for (const did of dids) {
          await setRepoStatus(did, 'pending')
          triggerAutoBackfill(did)
        }
        jsonResponse(res, { added: dids.length })
        return
      }

      // GET /info/:did — repo status info (public)
      if (url.pathname.startsWith('/info/did:')) {
        const did = url.pathname.slice('/info/'.length)
        const status = await getRepoStatus(did)
        if (!status) {
          jsonError(res, 404, 'Repo not found')
          return
        }
        const retryInfo = await getRepoRetryInfo(did)
        jsonResponse(res, {
          did,
          status,
          retry_count: retryInfo?.retryCount ?? 0,
          retry_after: retryInfo?.retryAfter ?? 0,
        })
        return
      }

      // --- OAuth Endpoints ---

      // OAuth well-known endpoints
      if (url.pathname === '/.well-known/oauth-authorization-server' && oauth) {
        jsonResponse(res, getAuthServerMetadata(oauth.issuer, oauth))
        return
      }
      if (url.pathname === '/.well-known/oauth-protected-resource' && oauth) {
        jsonResponse(res, getProtectedResourceMetadata(oauth.issuer, oauth))
        return
      }
      if (url.pathname === '/oauth/jwks' && oauth) {
        jsonResponse(res, getJwks())
        return
      }
      if ((url.pathname === '/oauth/client-metadata.json' || url.pathname === '/oauth-client-metadata.json') && oauth) {
        jsonResponse(res, getClientMetadata(oauth.issuer, oauth))
        return
      }

      // OAuth PAR
      if (url.pathname === '/oauth/par' && req.method === 'POST' && oauth) {
        const rawBody = await readBody(req)
        let body: Record<string, string>
        if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(rawBody))
        } else {
          body = JSON.parse(rawBody)
        }
        const dpopHeader = req.headers['dpop'] as string
        if (!dpopHeader) {
          jsonError(res, 400, 'DPoP header required')
          return
        }
        const result = await handlePar(oauth, body, dpopHeader, `${requestOrigin}/oauth/par`)
        jsonResponse(res, result)
        return
      }

      // OAuth Authorize
      if (url.pathname === '/oauth/authorize' && oauth) {
        const requestUri = url.searchParams.get('request_uri')
        if (!requestUri) {
          jsonError(res, 400, 'request_uri required')
          return
        }
        const request = await getOAuthRequest(requestUri)
        if (!request) {
          jsonError(res, 400, 'Invalid or expired request_uri')
          return
        }
        const redirectUrl = buildAuthorizeRedirect(oauth, request)
        res.writeHead(302, { Location: redirectUrl })
        res.end()
        return
      }

      // OAuth Callback (PDS redirects here after user approves)
      // Skip if iss matches our own issuer — that's the client-side redirect, let the SPA handle it
      if (url.pathname === '/oauth/callback' && oauth) {
        const iss = url.searchParams.get('iss')
        if (iss === oauth.issuer) {
          // Client-side callback — fall through to SPA
        } else {
          const code = url.searchParams.get('code')
          const state = url.searchParams.get('state')
          if (!code) {
            jsonError(res, 400, 'Missing code')
            return
          }
          const result = await handleCallback(oauth, code, state, iss)
          res.writeHead(302, { Location: result.clientRedirectUri })
          res.end()
          return
        }
      }

      // OAuth Token
      if (url.pathname === '/oauth/token' && req.method === 'POST' && oauth) {
        const rawBody = await readBody(req)
        let body: Record<string, string>
        if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(rawBody))
        } else {
          body = JSON.parse(rawBody)
        }
        const dpopHeader = req.headers['dpop'] as string
        if (!dpopHeader) {
          jsonError(res, 400, 'DPoP header required')
          return
        }
        const result = await handleToken(oauth, body, dpopHeader, `${requestOrigin}/oauth/token`)
        jsonResponse(res, result)
        return
      }

      // POST /xrpc/dev.hatk.createRecord — proxy write to user's PDS
      if (url.pathname === coreXrpc('createRecord') && req.method === 'POST' && oauth) {
        if (!viewer) {
          jsonError(res, 401, 'Authentication required')
          return
        }
        const body = JSON.parse(await readBody(req))

        const validationError = validateRecord(getLexiconArray(), body.collection, body.record)
        if (validationError) {
          jsonError(
            res,
            400,
            `InvalidRecord: ${validationError.path ? validationError.path + ': ' : ''}${validationError.message}`,
          )
          return
        }

        const session = await getSession(viewer.did)
        if (!session) {
          jsonError(res, 401, 'No PDS session for user')
          return
        }

        const pdsUrl = `${session.pds_endpoint}/xrpc/com.atproto.repo.createRecord`
        const pdsBody = {
          repo: viewer.did,
          collection: body.collection,
          rkey: body.rkey,
          record: body.record,
        }

        const pdsRes = await proxyToPds(oauth, session, 'POST', pdsUrl, pdsBody)
        if (!pdsRes.ok) {
          jsonError(res, pdsRes.status, pdsRes.body.error || 'PDS write failed')
          return
        }
        const result = pdsRes.body

        // Index the record immediately
        try {
          await insertRecord(body.collection, result.uri, result.cid, viewer.did, body.record)
        } catch {
          // Non-fatal — firehose will catch it
        }

        jsonResponse(res, result)
        return
      }

      // POST /xrpc/dev.hatk.deleteRecord — proxy delete to user's PDS
      if (url.pathname === coreXrpc('deleteRecord') && req.method === 'POST' && oauth) {
        if (!viewer) {
          jsonError(res, 401, 'Authentication required')
          return
        }
        const body = JSON.parse(await readBody(req))
        const session = await getSession(viewer.did)
        if (!session) {
          jsonError(res, 401, 'No PDS session for user')
          return
        }

        const pdsUrl = `${session.pds_endpoint}/xrpc/com.atproto.repo.deleteRecord`
        const pdsBody = {
          repo: viewer.did,
          collection: body.collection,
          rkey: body.rkey,
        }

        const pdsRes = await proxyToPds(oauth, session, 'POST', pdsUrl, pdsBody)
        if (!pdsRes.ok) {
          jsonError(res, pdsRes.status, pdsRes.body.error || 'PDS delete failed')
          return
        }
        const result = pdsRes.body

        // Delete the record locally
        try {
          const uri = `at://${viewer.did}/${body.collection}/${body.rkey}`
          await deleteRecord(body.collection, uri)
        } catch {
          // Non-fatal — firehose will catch it
        }

        jsonResponse(res, result)
        return
      }

      // POST /xrpc/dev.hatk.putRecord — proxy create-or-update to user's PDS
      if (url.pathname === coreXrpc('putRecord') && req.method === 'POST' && oauth) {
        if (!viewer) {
          jsonError(res, 401, 'Authentication required')
          return
        }
        const body = JSON.parse(await readBody(req))

        const validationError = validateRecord(getLexiconArray(), body.collection, body.record)
        if (validationError) {
          jsonError(
            res,
            400,
            `InvalidRecord: ${validationError.path ? validationError.path + ': ' : ''}${validationError.message}`,
          )
          return
        }

        const session = await getSession(viewer.did)
        if (!session) {
          jsonError(res, 401, 'No PDS session for user')
          return
        }

        const pdsUrl = `${session.pds_endpoint}/xrpc/com.atproto.repo.putRecord`
        const pdsBody = {
          repo: viewer.did,
          collection: body.collection,
          rkey: body.rkey,
          record: body.record,
        }

        const pdsRes = await proxyToPds(oauth, session, 'POST', pdsUrl, pdsBody)
        if (!pdsRes.ok) {
          jsonError(res, pdsRes.status, pdsRes.body.error || 'PDS write failed')
          return
        }
        const result = pdsRes.body

        // Re-index (insertRecord uses INSERT OR REPLACE so this handles both create and update)
        try {
          await insertRecord(body.collection, result.uri, result.cid, viewer.did, body.record)
        } catch {
          // Non-fatal — firehose will catch it
        }

        jsonResponse(res, result)
        return
      }

      // POST /xrpc/dev.hatk.uploadBlob — proxy blob upload to user's PDS
      if (url.pathname === coreXrpc('uploadBlob') && req.method === 'POST' && oauth) {
        if (!viewer) {
          jsonError(res, 401, 'Authentication required')
          return
        }

        const session = await getSession(viewer.did)
        if (!session) {
          jsonError(res, 401, 'No PDS session for user')
          return
        }

        const contentType = req.headers['content-type'] || 'application/octet-stream'
        const rawBody = await readBodyRaw(req)

        const pdsUrl = `${session.pds_endpoint}/xrpc/com.atproto.repo.uploadBlob`
        const pdsRes = await proxyToPdsRaw(oauth, session, pdsUrl, rawBody, contentType)
        if (!pdsRes.ok) {
          jsonError(res, pdsRes.status, String(pdsRes.body.error || 'PDS upload failed'))
          return
        }

        jsonResponse(res, pdsRes.body)
        return
      }

      // GET /admin — serve admin UI from hatk package
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        const adminPath = join(import.meta.dirname, '../public/admin.html')
        try {
          const content = await readFile(adminPath)
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(content)
          return
        } catch {
          res.writeHead(404)
          res.end('Admin page not found')
          return
        }
      }

      // GET /admin/admin-auth.js — serve bundled OAuth client
      if (url.pathname === '/admin/admin-auth.js') {
        const authPath = join(import.meta.dirname, '../public/admin-auth.js')
        try {
          const content = await readFile(authPath)
          res.writeHead(200, { 'Content-Type': 'application/javascript' })
          res.end(content)
          return
        } catch {
          res.writeHead(404)
          res.end('Not found')
          return
        }
      }

      // GET /_health
      if (url.pathname === '/_health') {
        jsonResponse(res, { status: 'ok' })
        return
      }

      // GET /og/* — OpenGraph image routes
      if (url.pathname.startsWith('/og/') && !res.writableEnded) {
        const png = await handleOpengraphRequest(url.pathname)
        if (png) {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=300',
          })
          res.end(png)
          return
        }
      }

      // GET/POST /xrpc/{nsid} — custom XRPC handlers (matched by full NSID from folder structure)
      if (url.pathname.startsWith('/xrpc/') && !res.writableEnded) {
        const method = url.pathname.slice('/xrpc/'.length)
        const limit = parseInt(url.searchParams.get('limit') || '20')
        const cursor = url.searchParams.get('cursor') || undefined

        const params: Record<string, string> = {}
        for (const [key, value] of url.searchParams) {
          params[key] = value
        }

        // Parse request body for POST (procedures)
        let input: unknown
        if (req.method === 'POST') {
          try {
            input = JSON.parse(await readBody(req))
          } catch {
            input = {}
          }
        }

        try {
          const result = await executeXrpc(method, params, cursor, limit, viewer, input)
          if (result) {
            jsonResponse(res, result)
            return
          }
        } catch (err: any) {
          if (err instanceof InvalidRequestError) {
            jsonError(res, err.status, err.errorName || err.message)
            return
          }
          throw err
        }
      }

      // GET /robots.txt — serve from user's public dir or fall back to hatk default
      if (url.pathname === '/robots.txt') {
        const userRobots = publicDir ? join(publicDir, 'robots.txt') : null
        const defaultRobots = join(import.meta.dirname, '../public/robots.txt')
        const robotsPath = userRobots && existsSync(userRobots) ? userRobots : defaultRobots
        try {
          const content = await readFile(robotsPath)
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(content)
          return
        } catch {
          // fall through
        }
      }

      // Static file serving
      if (publicDir) {
        try {
          const filePath = join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname)
          const content = await readFile(filePath)
          res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'text/plain' })
          res.end(content)
          return
        } catch {}

        // SPA fallback — serve index.html for client-side routes
        try {
          let content = await readFile(join(publicDir, 'index.html'), 'utf-8')

          // Inject OG meta tags for shareable routes
          const ogMeta = buildOgMeta(url.pathname, requestOrigin)
          if (ogMeta) {
            content = content.replace('</head>', `${ogMeta}\n</head>`)
          }

          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(content)
          return
        } catch {}
      }

      res.writeHead(404)
      res.end('Not Found')
    } catch (err: any) {
      error = err.message
      jsonError(res, 500, err.message)
    } finally {
      if (isXrpc || isAdmin) {
        emit('server', 'request', {
          method: req.method,
          path: url.pathname,
          status_code: res.statusCode,
          duration_ms: elapsed!(),
          collection: url.searchParams.get('collection') || undefined,
          query: url.searchParams.get('q') || undefined,
          error,
        })
      }
    }
  })

  server.listen(port, () => log(`[server] ${oauth?.issuer || `http://localhost:${port}`}`))
  return server
}

function sendJson(res: any, status: number, body: Buffer): void {
  const acceptEncoding = res.req?.headers['accept-encoding'] || ''
  if (body.length > 1024 && /\bgzip\b/.test(acceptEncoding as string)) {
    const compressed = gzipSync(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Vary': 'Accept-Encoding',
      ...(status === 200 ? { 'Cache-Control': 'no-store' } : {}),
    })
    res.end(compressed)
  } else {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...(status === 200 ? { 'Cache-Control': 'no-store' } : {}),
    })
    res.end(body)
  }
}

function jsonResponse(res: any, data: any): void {
  sendJson(res, 200, Buffer.from(JSON.stringify(data, (_, v) => normalizeValue(v))))
}

function jsonError(res: any, status: number, message: string): void {
  if (res.headersSent) return
  sendJson(res, status, Buffer.from(JSON.stringify({ error: message })))
}

/** Proxy a request to the user's PDS with DPoP + automatic nonce retry + token refresh. */
async function proxyToPds(
  oauthConfig: import('./config.ts').OAuthConfig,
  session: any,
  method: string,
  pdsUrl: string,
  body: any,
): Promise<{ ok: boolean; status: number; body: any; headers: Headers }> {
  const serverKey = await getServerKey('appview-oauth-key')
  const privateJwk = JSON.parse(serverKey!.privateKey)
  const publicJwk = JSON.parse(serverKey!.publicKey)

  let accessToken = session.access_token

  async function doFetch(
    token: string,
    nonce?: string,
  ): Promise<{ ok: boolean; status: number; body: any; headers: Headers }> {
    const proof = await createDpopProof(privateJwk, publicJwk, method, pdsUrl, token, nonce)
    const res = await fetch(pdsUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${token}`,
        DPoP: proof,
      },
      body: JSON.stringify(body),
    })
    const resBody = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body: resBody, headers: res.headers }
  }

  let result = await doFetch(accessToken)
  if (result.ok) return result

  let nonce: string | undefined

  // Step 1: handle DPoP nonce requirement
  if (result.body.error === 'use_dpop_nonce') {
    nonce = result.headers.get('DPoP-Nonce') || undefined
    if (nonce) {
      result = await doFetch(accessToken, nonce)
      if (result.ok) return result
    }
  }

  // Step 2: handle expired PDS token — refresh and retry
  if (result.body.error === 'invalid_token') {
    const refreshed = await refreshPdsSession(oauthConfig, session)
    if (refreshed) {
      accessToken = refreshed.accessToken
      result = await doFetch(accessToken, nonce)
      if (result.ok) return result
      // May need DPoP nonce after refresh
      if (result.body.error === 'use_dpop_nonce') {
        nonce = result.headers.get('DPoP-Nonce') || undefined
        if (nonce) result = await doFetch(accessToken, nonce)
      }
    }
  }

  return result
}

/** Proxy a raw binary request to the user's PDS with DPoP + nonce retry + token refresh. */
async function proxyToPdsRaw(
  oauthConfig: import('./config.ts').OAuthConfig,
  session: { access_token: string; pds_endpoint: string; did: string; refresh_token: string; dpop_jkt: string },
  pdsUrl: string,
  body: Uint8Array,
  contentType: string,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; headers: Headers }> {
  const serverKey = await getServerKey('appview-oauth-key')
  const privateJwk = JSON.parse(serverKey!.privateKey)
  const publicJwk = JSON.parse(serverKey!.publicKey)

  let accessToken = session.access_token

  async function doFetch(
    token: string,
    nonce?: string,
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; headers: Headers }> {
    const proof = await createDpopProof(privateJwk, publicJwk, 'POST', pdsUrl, token, nonce)
    const res = await fetch(pdsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        Authorization: `DPoP ${token}`,
        DPoP: proof,
      },
      body: Buffer.from(body),
    })
    const resBody: Record<string, unknown> = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body: resBody, headers: res.headers }
  }

  let result = await doFetch(accessToken)
  if (result.ok) return result

  let nonce: string | undefined

  if (result.body.error === 'use_dpop_nonce') {
    nonce = result.headers.get('DPoP-Nonce') || undefined
    if (nonce) {
      result = await doFetch(accessToken, nonce)
      if (result.ok) return result
    }
  }

  if (result.body.error === 'invalid_token') {
    const refreshed = await refreshPdsSession(oauthConfig, session)
    if (refreshed) {
      accessToken = refreshed.accessToken
      result = await doFetch(accessToken, nonce)
      if (result.ok) return result
      if (result.body.error === 'use_dpop_nonce') {
        nonce = result.headers.get('DPoP-Nonce') || undefined
        if (nonce) result = await doFetch(accessToken, nonce)
      }
    }
  }

  return result
}
