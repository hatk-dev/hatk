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
  queryLabelsForUris,
  insertLabels,
  searchAccounts,
  listReposPaginated,
  getCollectionCounts,
  getRepoStatusCounts,
  getDatabaseSize,
  deleteLabels,
  getRecentRecords,
  listActiveRepoDids,
  removeRepo,
  getRepoHandle,
  getPreferences,
  putPreference,
  insertReport,
  queryReports,
  resolveReport,
  getOpenReportCount,
} from './database/db.ts'
import { executeFeed, listFeeds } from './feeds.ts'
import { executeXrpc, InvalidRequestError, NotFoundError, registerCoreXrpcHandler } from './xrpc.ts'
import { resolveRecords } from './hydrate.ts'
import { handleOpengraphRequest, buildOgMeta } from './opengraph.ts'
import { getLabelDefinitions, rescanLabels } from './labels.ts'
import { triggerAutoBackfill } from './indexer.ts'
import { emit, timer } from './logger.ts'
import {
  getAuthServerMetadata,
  getProtectedResourceMetadata,
  getJwks,
  getClientMetadata,
  handlePar,
  buildAuthorizeRedirect,
  handleCallback,
  serverLogin,
  handleToken,
  authenticate,
} from './oauth/server.ts'
import {
  createSessionCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  parseSessionCookie,
} from './oauth/session.ts'
import { getOAuthRequest } from './oauth/db.ts'
import type { OAuthConfig } from './config.ts'
import {
  pdsCreateRecord,
  pdsDeleteRecord,
  pdsPutRecord,
  pdsUploadBlob,
  ProxyError,
  ScopeMissingProxyError,
} from './pds-proxy.ts'
import { json, jsonError, cors, withCors, file, notFound } from './response.ts'
import { serve } from './adapter.ts'
import { renderPage } from './renderer.ts'

function scopeMissingResponse(acceptEncoding: string | null, handle?: string): Response {
  const res = withCors(json({ error: 'ScopeMissingError', ...(handle ? { handle } : {}) }, 401, acceptEncoding))
  res.headers.append('Set-Cookie', clearSessionCookieHeader())
  return res
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
}

/**
 * Register built-in dev.hatk.* XRPC handlers in the handler registry.
 * This makes them available to callXrpc() for use in SSR and server code.
 */
export function registerCoreHandlers(collections: string[], oauth: OAuthConfig | null): void {
  registerCoreXrpcHandler('dev.hatk.getRecords', async (params, cursor, limit) => {
    const collection = params.collection
    if (!collection) throw new InvalidRequestError('Missing collection parameter')
    if (!getSchema(collection)) throw new NotFoundError(`Unknown collection: ${collection}`)

    const sort = params.sort || undefined
    const order = (params.order || undefined) as 'asc' | 'desc' | undefined
    const reserved = new Set(['collection', 'limit', 'cursor', 'sort', 'order'])
    const filters: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
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
    return { items, cursor: result.cursor }
  })

  registerCoreXrpcHandler('dev.hatk.getRecord', async (params) => {
    const uri = params.uri
    if (!uri) throw new InvalidRequestError('Missing uri parameter')
    const record = await getRecordByUri(uri)
    if (!record) throw new NotFoundError('Record not found')
    const shaped = reshapeRow(record, record?.__childData) as Record<string, any>
    const labelsMap = await queryLabelsForUris([record.uri])
    if (shaped) shaped.labels = labelsMap.get(record.uri) || []
    return { record: shaped }
  })

  registerCoreXrpcHandler('dev.hatk.getFeed', async (params, cursor, limit, viewer) => {
    const feedName = params.feed
    if (!feedName) throw new InvalidRequestError('Missing feed parameter')
    const result = await executeFeed(feedName, params, cursor, limit, viewer)
    if (!result) throw new NotFoundError(`Unknown feed: ${feedName}`)
    return result
  })

  registerCoreXrpcHandler('dev.hatk.searchRecords', async (params, cursor, limit) => {
    const collection = params.collection
    const q = params.q
    if (!collection) throw new InvalidRequestError('Missing collection parameter')
    if (!q) throw new InvalidRequestError('Missing q parameter')
    if (!getSchema(collection)) throw new NotFoundError(`Unknown collection: ${collection}`)

    const fuzzy = params.fuzzy !== 'false'
    const result = await searchRecords(collection, q, { limit, cursor, fuzzy })
    const uris = result.records.map((r: any) => r.uri)
    const items = await resolveRecords(uris)
    return { items, cursor: result.cursor }
  })

  registerCoreXrpcHandler('dev.hatk.describeFeeds', async () => {
    return { feeds: listFeeds() }
  })

  registerCoreXrpcHandler('dev.hatk.describeCollections', async () => {
    const collectionInfo = collections.map((c) => {
      const schema = getSchema(c)
      return {
        collection: c,
        columns: schema?.columns.map((col) => ({
          name: col.name,
          originalName: col.originalName,
          type: col.sqlType,
          required: col.notNull,
        })),
      }
    })
    return { collections: collectionInfo }
  })

  registerCoreXrpcHandler('dev.hatk.describeLabels', async () => {
    return { definitions: getLabelDefinitions() }
  })

  // Write operations — proxy to user's PDS
  if (oauth) {
    registerCoreXrpcHandler('dev.hatk.getPreferences', async (_params, _cursor, _limit, viewer) => {
      if (!viewer) throw new InvalidRequestError('Authentication required')
      const prefs = await getPreferences(viewer.did)
      return { preferences: prefs }
    })

    registerCoreXrpcHandler('dev.hatk.putPreference', async (_params, _cursor, _limit, viewer, input) => {
      if (!viewer) throw new InvalidRequestError('Authentication required')
      const body = input as { key?: string; value?: unknown }
      if (!body.key || typeof body.key !== 'string') throw new InvalidRequestError('Missing or invalid key')
      if (body.value === undefined) throw new InvalidRequestError('Missing value')
      await putPreference(viewer.did, body.key, body.value)
      return { success: true }
    })

    registerCoreXrpcHandler('dev.hatk.createRecord', async (_params, _cursor, _limit, viewer, input) => {
      if (!viewer) throw new InvalidRequestError('Authentication required')
      return pdsCreateRecord(oauth, viewer, input as any)
    })

    registerCoreXrpcHandler('dev.hatk.deleteRecord', async (_params, _cursor, _limit, viewer, input) => {
      if (!viewer) throw new InvalidRequestError('Authentication required')
      return pdsDeleteRecord(oauth, viewer, input as any)
    })

    registerCoreXrpcHandler('dev.hatk.putRecord', async (_params, _cursor, _limit, viewer, input) => {
      if (!viewer) throw new InvalidRequestError('Authentication required')
      return pdsPutRecord(oauth, viewer, input as any)
    })

    registerCoreXrpcHandler('dev.hatk.uploadBlob', async (_params, _cursor, _limit, viewer, input) => {
      if (!viewer) throw new InvalidRequestError('Authentication required')
      return pdsUploadBlob(oauth, viewer, input as any, 'application/octet-stream')
    })

    registerCoreXrpcHandler('dev.hatk.createReport', async (_params, _cursor, _limit, viewer, input) => {
      if (!viewer) throw new InvalidRequestError('Authentication required')
      const body = input as { subject?: any; label?: string; reason?: string }
      if (!body.subject) throw new InvalidRequestError('Missing subject')
      if (!body.label || typeof body.label !== 'string') throw new InvalidRequestError('Missing or invalid label')

      const defs = getLabelDefinitions()
      if (!defs.some((d) => d.identifier === body.label)) {
        throw new InvalidRequestError(`Unknown label: ${body.label}`)
      }

      if (body.reason && body.reason.length > 2000) {
        throw new InvalidRequestError('Reason must be 2000 characters or less')
      }

      let subjectUri: string
      let subjectDid: string
      if (body.subject.uri) {
        subjectUri = body.subject.uri
        const match = body.subject.uri.match(/^at:\/\/(did:[^/]+)/)
        if (!match) throw new InvalidRequestError('Invalid subject URI')
        subjectDid = match[1]
      } else if (body.subject.did) {
        subjectUri = `at://${body.subject.did}`
        subjectDid = body.subject.did
      } else {
        throw new InvalidRequestError('Subject must have uri or did')
      }

      const result = await insertReport({
        subjectUri,
        subjectDid,
        label: body.label,
        reason: body.reason,
        reportedBy: viewer.did,
      })

      return {
        id: result.id,
        subject: body.subject,
        label: body.label,
        reason: body.reason || null,
        reportedBy: viewer.did,
        createdAt: new Date().toISOString(),
      }
    })
  }
}

export interface HandlerConfig {
  collections: string[]
  publicDir: string | null
  oauth: OAuthConfig | null
  admins: string[]
  renderer?: (request: Request, manifest: any) => Promise<{ html: string; head?: string }>
  resolveViewer?: (request: Request) => { did: string } | null
  onResync?: () => void
}

/**
 * Create a Web Standard request handler for all hatk routes.
 * Returns a pure function: (Request) → Promise<Response>
 */
export function createHandler(config: HandlerConfig): (request: Request) => Promise<Response> {
  const { collections, publicDir, oauth, admins } = config
  const devMode = process.env.DEV_MODE === '1'
  const coreXrpc = (method: string) => `/xrpc/dev.hatk.${method}`

  function requireAdmin(viewer: { did: string } | null, acceptEncoding: string | null): Response | null {
    if (!viewer) return withCors(jsonError(401, 'Authentication required', acceptEncoding))
    if (!devMode && !admins.includes(viewer.did))
      return withCors(jsonError(403, 'Admin access required', acceptEncoding))
    return null // auth OK
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const acceptEncoding = request.headers.get('accept-encoding')

    // CORS preflight
    if (request.method === 'OPTIONS') return cors()

    const isXrpc = url.pathname.startsWith('/xrpc/')
    const isAdmin =
      url.pathname.startsWith('/admin') && !url.pathname.endsWith('.html') && !url.pathname.endsWith('.js')
    const elapsed = isXrpc || isAdmin ? timer() : null
    let error: string | undefined
    const requestOrigin = `${request.headers.get('x-forwarded-proto') || 'http'}://${request.headers.get('host') || 'localhost'}`

    // Authenticate viewer (optional — unauthenticated requests still work)
    let viewer: { did: string; handle?: string } | null = config.resolveViewer?.(request) ?? null
    if (!viewer && oauth) {
      try {
        viewer = await authenticate(
          request.headers.get('authorization'),
          request.headers.get('dpop'),
          request.method,
          `${requestOrigin}${url.pathname}`,
        )
      } catch (err: any) {
        emit('oauth', 'authenticate_error', { error: err.message })
      }
    }
    // Fallback: resolve viewer from session cookie (for browser requests without DPoP)
    if (!viewer && oauth) {
      try {
        viewer = await parseSessionCookie(request)
      } catch {}
    }

    try {
      // GET /xrpc/dev.hatk.getRecords?collection=<nsid>&limit=N&cursor=C&<field>=<value>
      if (url.pathname === coreXrpc('getRecords')) {
        const collection = url.searchParams.get('collection')
        if (!collection) return withCors(jsonError(400, 'Missing collection parameter', acceptEncoding))
        if (!getSchema(collection)) return withCors(jsonError(404, `Unknown collection: ${collection}`, acceptEncoding))

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
        return withCors(json({ items, cursor: result.cursor }, 200, acceptEncoding))
      }

      // GET /xrpc/dev.hatk.getRecord?uri=<at-uri>
      if (url.pathname === coreXrpc('getRecord')) {
        const uri = url.searchParams.get('uri')
        if (!uri) return withCors(jsonError(400, 'Missing uri parameter', acceptEncoding))

        const record = await getRecordByUri(uri)
        if (!record) return withCors(jsonError(404, 'Record not found', acceptEncoding))

        const shaped = reshapeRow(record, record?.__childData) as Record<string, any>
        const labelsMap = await queryLabelsForUris([record.uri])
        if (shaped) shaped.labels = labelsMap.get(record.uri) || []
        return withCors(json({ record: shaped }, 200, acceptEncoding))
      }

      // GET /xrpc/dev.hatk.getFeed?feed=<name>&limit=N&cursor=C
      if (url.pathname === coreXrpc('getFeed')) {
        const feedName = url.searchParams.get('feed')
        if (!feedName) return withCors(jsonError(400, 'Missing feed parameter', acceptEncoding))
        const limit = parseInt(url.searchParams.get('limit') || '30')
        const cursor = url.searchParams.get('cursor') || undefined

        const params: Record<string, string> = {}
        for (const [key, value] of url.searchParams) {
          params[key] = value
        }

        const result = await executeFeed(feedName, params, cursor, limit, viewer)
        if (!result) return withCors(jsonError(404, `Unknown feed: ${feedName}`, acceptEncoding))

        return withCors(json(result, 200, acceptEncoding))
      }

      // GET /xrpc/dev.hatk.searchRecords?collection=<nsid>&q=<query>&limit=N&cursor=C
      if (url.pathname === coreXrpc('searchRecords')) {
        const collection = url.searchParams.get('collection')
        const q = url.searchParams.get('q')
        if (!collection) return withCors(jsonError(400, 'Missing collection parameter', acceptEncoding))
        if (!q) return withCors(jsonError(400, 'Missing q parameter', acceptEncoding))
        if (!getSchema(collection)) return withCors(jsonError(404, `Unknown collection: ${collection}`, acceptEncoding))

        const limit = parseInt(url.searchParams.get('limit') || '20')
        const cursor = url.searchParams.get('cursor') || undefined
        const fuzzy = url.searchParams.get('fuzzy') !== 'false'

        const result = await searchRecords(collection, q, { limit, cursor, fuzzy })

        const uris = result.records.map((r: any) => r.uri)
        const items = await resolveRecords(uris)
        return withCors(json({ items, cursor: result.cursor }, 200, acceptEncoding))
      }

      // GET /xrpc/dev.hatk.describeFeeds
      if (url.pathname === coreXrpc('describeFeeds')) {
        return withCors(json({ feeds: listFeeds() }, 200, acceptEncoding))
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
              type: col.sqlType,
              required: col.notNull,
            })),
          }
        })
        return withCors(json({ collections: collectionInfo }, 200, acceptEncoding))
      }

      // GET /xrpc/dev.hatk.describeLabels
      if (url.pathname === coreXrpc('describeLabels')) {
        return withCors(json({ definitions: getLabelDefinitions() }, 200, acceptEncoding))
      }

      // GET /xrpc/dev.hatk.getPreferences — get all preferences for authenticated user
      if (url.pathname === coreXrpc('getPreferences')) {
        if (!viewer) return withCors(jsonError(401, 'Authentication required', acceptEncoding))
        const prefs = await getPreferences(viewer.did)
        return withCors(json({ preferences: prefs }, 200, acceptEncoding))
      }

      // POST /xrpc/dev.hatk.putPreference — set a single preference
      if (url.pathname === coreXrpc('putPreference') && request.method === 'POST') {
        if (!viewer) return withCors(jsonError(401, 'Authentication required', acceptEncoding))
        const body = JSON.parse(await request.text())
        if (!body.key || typeof body.key !== 'string')
          return withCors(jsonError(400, 'Missing or invalid key', acceptEncoding))
        if (body.value === undefined) return withCors(jsonError(400, 'Missing value', acceptEncoding))
        await putPreference(viewer.did, body.key, body.value)
        return withCors(json({ success: true }, 200, acceptEncoding))
      }

      // ── Admin Repo Management ──

      // POST /admin/repos/add — enqueue DIDs for backfill
      if (url.pathname === '/admin/repos/add' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const { dids } = JSON.parse(await request.text())
        if (!Array.isArray(dids)) return withCors(jsonError(400, 'Missing dids array', acceptEncoding))
        for (const did of dids) {
          await setRepoStatus(did, 'pending')
          triggerAutoBackfill(did)
        }
        return withCors(json({ added: dids.length }, 200, acceptEncoding))
      }

      // POST /admin/labels/rescan — retroactively apply label rules
      if (url.pathname === '/admin/labels/rescan' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const result = await rescanLabels(collections)
        return withCors(json(result, 200, acceptEncoding))
      }

      // ── Admin Endpoints ──

      // GET /admin/whoami — check if current viewer is admin
      if (url.pathname === '/admin/whoami') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        return withCors(json({ did: viewer!.did, admin: true }, 200, acceptEncoding))
      }

      // GET /admin/labels/definitions — get available label definitions
      if (url.pathname === '/admin/labels/definitions') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        return withCors(json({ definitions: getLabelDefinitions() }, 200, acceptEncoding))
      }

      // POST /admin/labels — apply a label
      if (url.pathname === '/admin/labels' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const { uri, val } = JSON.parse(await request.text())
        if (!uri || !val) return withCors(jsonError(400, 'Missing uri or val', acceptEncoding))
        await insertLabels([{ src: 'admin', uri, val }])
        return withCors(json({ ok: true }, 200, acceptEncoding))
      }

      // POST /admin/labels/reset — delete all labels of a given type
      if (url.pathname === '/admin/labels/reset' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const { val } = JSON.parse(await request.text())
        if (!val) return withCors(jsonError(400, 'Missing val', acceptEncoding))
        const deleted = await deleteLabels(val)
        return withCors(json({ deleted }, 200, acceptEncoding))
      }

      // POST /admin/labels/negate — negate a label
      if (url.pathname === '/admin/labels/negate' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const { uri, val } = JSON.parse(await request.text())
        if (!uri || !val) return withCors(jsonError(400, 'Missing uri or val', acceptEncoding))
        await insertLabels([{ src: 'admin', uri, val, neg: true }])
        return withCors(json({ ok: true }, 200, acceptEncoding))
      }

      // POST /admin/takedown — takedown an account
      if (url.pathname === '/admin/takedown' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const { did } = JSON.parse(await request.text())
        if (!did) return withCors(jsonError(400, 'Missing did', acceptEncoding))
        await setRepoStatus(did, 'takendown')
        return withCors(json({ ok: true }, 200, acceptEncoding))
      }

      // POST /admin/reverse-takedown — reverse a takedown
      if (url.pathname === '/admin/reverse-takedown' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const { did } = JSON.parse(await request.text())
        if (!did) return withCors(jsonError(400, 'Missing did', acceptEncoding))
        await setRepoStatus(did, 'active')
        return withCors(json({ ok: true }, 200, acceptEncoding))
      }

      // GET /admin/search — search records or accounts
      if (url.pathname === '/admin/search') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const q = url.searchParams.get('q') || ''
        const type = url.searchParams.get('type') || 'records'
        const limit = parseInt(url.searchParams.get('limit') || '20')

        if (type === 'accounts') {
          const accounts = await searchAccounts(q, limit)
          return withCors(json({ accounts }, 200, acceptEncoding))
        }

        // No query — live firehose activity (excludes bulk backfill records)
        if (!q) {
          const offset = parseInt(url.searchParams.get('offset') || '0')
          const allResults: any[] = []
          for (const col of collections) {
            try {
              const rows = await getRecentRecords(col, limit + offset)
              if (!rows.length) continue
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
          return withCors(json({ records: page, total: allResults.length }, 200, acceptEncoding))
        }

        // URI lookup
        if (q.startsWith('at://')) {
          const rec = await getRecordByUri(q)
          if (rec) {
            const labelsMap = await queryLabelsForUris([rec.uri])
            return withCors(
              json(
                {
                  records: [{ ...reshapeRow(rec, rec?.__childData), labels: labelsMap.get(rec.uri) || [] }],
                },
                200,
                acceptEncoding,
              ),
            )
          } else {
            return withCors(json({ records: [] }, 200, acceptEncoding))
          }
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
          return withCors(json({ records: allResults.slice(0, limit) }, 200, acceptEncoding))
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
        return withCors(json({ records: allResults.slice(0, limit) }, 200, acceptEncoding))
      }

      // POST /admin/repos/resync — re-download repos
      if (url.pathname === '/admin/repos/resync' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const bodyText = await request.text()
        const { dids } = bodyText ? JSON.parse(bodyText) : ({} as { dids?: string[] })
        let repoList: string[]
        if (Array.isArray(dids) && dids.length > 0) {
          repoList = dids
        } else {
          repoList = await listActiveRepoDids()
        }
        const isTargeted = Array.isArray(dids) && dids.length > 0
        for (const did of repoList) {
          await setRepoStatus(did, 'pending')
        }
        if (isTargeted) {
          for (const did of repoList) {
            triggerAutoBackfill(did)
          }
        } else if (config.onResync) {
          config.onResync()
        } else {
          for (const did of repoList) {
            triggerAutoBackfill(did)
          }
        }
        return withCors(json({ resyncing: repoList.length }, 200, acceptEncoding))
      }

      // POST /admin/repos/remove — remove DIDs from tracking
      if (url.pathname === '/admin/repos/remove' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const { dids } = JSON.parse(await request.text())
        if (!Array.isArray(dids)) return withCors(jsonError(400, 'Missing dids array', acceptEncoding))
        for (const did of dids) {
          await removeRepo(did)
        }
        return withCors(json({ removed: dids.length }, 200, acceptEncoding))
      }

      // GET /admin/info — aggregate status + db size + collection counts
      if (url.pathname === '/admin/info') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const counts = await getRepoStatusCounts()
        const dbInfo = await getDatabaseSize()
        const collectionCounts = await getCollectionCounts()
        const mem = process.memoryUsage()
        const node = {
          rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MiB`,
          heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MiB`,
          heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MiB`,
          external: `${(mem.external / 1024 / 1024).toFixed(1)} MiB`,
        }
        const openReports = await getOpenReportCount()
        return withCors(
          json({ repos: counts, duckdb: dbInfo, node, collections: collectionCounts, openReports }, 200, acceptEncoding),
        )
      }

      // GET /admin/reports — list reports
      if (url.pathname === '/admin/reports' && request.method === 'GET') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const status = url.searchParams.get('status') || 'open'
        const label = url.searchParams.get('label') || undefined
        const limit = parseInt(url.searchParams.get('limit') || '50')
        const offset = parseInt(url.searchParams.get('offset') || '0')
        const result = await queryReports({ status, label, limit, offset })
        return withCors(json(result, 200, acceptEncoding))
      }

      // POST /admin/reports/resolve — resolve or dismiss a report
      if (url.pathname === '/admin/reports/resolve' && request.method === 'POST') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const { id, action } = JSON.parse(await request.text())
        if (!id || !action) return withCors(jsonError(400, 'Missing id or action', acceptEncoding))
        if (action !== 'resolve' && action !== 'dismiss')
          return withCors(jsonError(400, 'Action must be resolve or dismiss', acceptEncoding))

        const report = await resolveReport(id, action === 'resolve' ? 'resolved' : 'dismissed', viewer!.did)
        if (!report) return withCors(jsonError(404, 'Report not found or already resolved', acceptEncoding))

        if (action === 'resolve') {
          await insertLabels([{ src: 'admin', uri: report.subjectUri, val: report.label }])
        }
        return withCors(json({ ok: true }, 200, acceptEncoding))
      }

      // GET /admin/info/:did — repo status info
      if (url.pathname.startsWith('/admin/info/did:')) {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const did = url.pathname.slice('/admin/info/'.length)
        const status = await getRepoStatus(did)
        if (!status) return withCors(jsonError(404, 'Repo not found', acceptEncoding))
        const retryInfo = await getRepoRetryInfo(did)
        return withCors(
          json(
            {
              did,
              status,
              retry_count: retryInfo?.retryCount ?? 0,
              retry_after: retryInfo?.retryAfter ?? 0,
            },
            200,
            acceptEncoding,
          ),
        )
      }

      // GET /admin/repos — paginated repo listing
      if (url.pathname === '/admin/repos' && request.method === 'GET') {
        const denied = requireAdmin(viewer, acceptEncoding)
        if (denied) return denied
        const limit = parseInt(url.searchParams.get('limit') || '50')
        const offset = parseInt(url.searchParams.get('offset') || '0')
        const status = url.searchParams.get('status') || undefined
        const q = url.searchParams.get('q') || undefined
        const result = await listReposPaginated({ limit, offset, status, q })
        return withCors(json(result, 200, acceptEncoding))
      }

      // ── Public Repo Endpoints (used by hatk clients for auto-sync) ──

      // POST /repos/add — enqueue DIDs for backfill (public)
      if (url.pathname === '/repos/add' && request.method === 'POST') {
        const { dids } = JSON.parse(await request.text())
        if (!Array.isArray(dids)) return withCors(jsonError(400, 'Missing dids array', acceptEncoding))
        for (const did of dids) {
          await setRepoStatus(did, 'pending')
          triggerAutoBackfill(did)
        }
        return withCors(json({ added: dids.length }, 200, acceptEncoding))
      }

      // GET /info/:did — repo status info (public)
      if (url.pathname.startsWith('/info/did:')) {
        const did = url.pathname.slice('/info/'.length)
        const status = await getRepoStatus(did)
        if (!status) return withCors(jsonError(404, 'Repo not found', acceptEncoding))
        const retryInfo = await getRepoRetryInfo(did)
        return withCors(
          json(
            {
              did,
              status,
              retry_count: retryInfo?.retryCount ?? 0,
              retry_after: retryInfo?.retryAfter ?? 0,
            },
            200,
            acceptEncoding,
          ),
        )
      }

      // --- OAuth Endpoints ---

      // OAuth well-known endpoints
      if (url.pathname === '/.well-known/oauth-authorization-server' && oauth) {
        return withCors(json(getAuthServerMetadata(oauth.issuer, oauth), 200, acceptEncoding))
      }
      if (url.pathname === '/.well-known/oauth-protected-resource' && oauth) {
        return withCors(json(getProtectedResourceMetadata(oauth.issuer, oauth), 200, acceptEncoding))
      }
      if (url.pathname === '/oauth/jwks' && oauth) {
        return withCors(json(getJwks(), 200, acceptEncoding))
      }
      if ((url.pathname === '/oauth/client-metadata.json' || url.pathname === '/oauth-client-metadata.json') && oauth) {
        return withCors(json(getClientMetadata(oauth.issuer, oauth), 200, acceptEncoding))
      }

      // Dev-only: create a session cookie for any DID (for testing)
      if (url.pathname === '/__dev/login' && devMode && oauth) {
        const did = url.searchParams.get('did')
        if (!did) return withCors(jsonError(400, 'did required', acceptEncoding))
        const handle = await getRepoHandle(did) ?? did
        const cookieValue = await createSessionCookie({ did, handle })
        const secure = url.protocol === 'https:'
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': sessionCookieHeader(cookieValue, secure),
          },
        })
      }

      // OAuth Login (server-initiated, no DPoP required)
      if (url.pathname === '/oauth/login' && oauth) {
        const handle = url.searchParams.get('handle') || ''
        const prompt = url.searchParams.get('prompt') || undefined
        const pds = url.searchParams.get('pds') || undefined
        if (!handle && prompt !== 'create') return withCors(jsonError(400, 'handle required', acceptEncoding))
        try {
          const redirectUrl = await serverLogin(oauth, handle, { prompt, pds })
          return new Response(null, {
            status: 302,
            headers: { Location: redirectUrl, 'Set-Cookie': clearSessionCookieHeader() },
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Login failed'
          return withCors(jsonError(400, message, acceptEncoding))
        }
      }

      // OAuth PAR
      if (url.pathname === '/oauth/par' && request.method === 'POST' && oauth) {
        const rawBody = await request.text()
        let body: Record<string, string>
        if (request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(rawBody))
        } else {
          body = JSON.parse(rawBody)
        }
        const dpopHeader = request.headers.get('dpop')
        if (!dpopHeader) return withCors(jsonError(400, 'DPoP header required', acceptEncoding))
        try {
          const result = await handlePar(oauth, body, dpopHeader, `${requestOrigin}/oauth/par`)
          return withCors(json(result, 200, acceptEncoding))
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          return withCors(jsonError(400, message, acceptEncoding))
        }
      }

      // OAuth Authorize
      if (url.pathname === '/oauth/authorize' && oauth) {
        const requestUri = url.searchParams.get('request_uri')
        if (!requestUri) return withCors(jsonError(400, 'request_uri required', acceptEncoding))
        const oauthRequest = await getOAuthRequest(requestUri)
        if (!oauthRequest) return withCors(jsonError(400, 'Invalid or expired request_uri', acceptEncoding))
        const redirectUrl = buildAuthorizeRedirect(oauth, oauthRequest)
        return new Response(null, { status: 302, headers: { Location: redirectUrl } })
      }

      // OAuth Callback (PDS redirects here after user approves)
      // Skip if iss matches our own issuer — that's the client-side redirect, let the SPA handle it
      if (url.pathname === '/oauth/callback' && oauth) {
        const iss = url.searchParams.get('iss')
        if (iss !== oauth.issuer) {
          const code = url.searchParams.get('code')
          const state = url.searchParams.get('state')
          if (!code) return withCors(jsonError(400, 'Missing code', acceptEncoding))
          const result = await handleCallback(oauth, code, state, iss)
          const isSecure = requestOrigin.startsWith('https')
          const handle = await getRepoHandle(result.did) ?? result.did
          const cookie = await createSessionCookie({ did: result.did, handle })
          // Server-initiated login stores redirectUri as '/' — redirect cleanly without code/iss params
          const redirectTo = result.clientRedirectUri.startsWith('/?code=') ? '/' : result.clientRedirectUri
          return new Response(null, {
            status: 302,
            headers: [
              ['Location', redirectTo],
              ['Set-Cookie', sessionCookieHeader(cookie, isSecure)],
            ],
          })
        }
        // Client-side callback — fall through to SPA
      }

      // Session cookie logout
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        return new Response(null, {
          status: 200,
          headers: { 'Set-Cookie': clearSessionCookieHeader() },
        })
      }

      // OAuth Token
      if (url.pathname === '/oauth/token' && request.method === 'POST' && oauth) {
        const rawBody = await request.text()
        let body: Record<string, string>
        if (request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(rawBody))
        } else {
          body = JSON.parse(rawBody)
        }
        const dpopHeader = request.headers.get('dpop')
        if (!dpopHeader) return withCors(jsonError(400, 'DPoP header required', acceptEncoding))
        const result = await handleToken(oauth, body, dpopHeader, `${requestOrigin}/oauth/token`)
        return withCors(json(result, 200, acceptEncoding))
      }

      // POST /xrpc/dev.hatk.createRecord — proxy write to user's PDS
      if (url.pathname === coreXrpc('createRecord') && request.method === 'POST' && oauth) {
        if (!viewer) return withCors(jsonError(401, 'Authentication required', acceptEncoding))
        const body = JSON.parse(await request.text())
        try {
          const result = await pdsCreateRecord(oauth, viewer, body)
          return withCors(json(result, 200, acceptEncoding))
        } catch (err: any) {
          if (err instanceof ScopeMissingProxyError) return scopeMissingResponse(acceptEncoding, viewer?.handle)
          if (err instanceof ProxyError) return withCors(json({ error: err.message, ...(viewer?.handle ? { handle: viewer.handle } : {}) }, err.status, acceptEncoding))
          throw err
        }
      }

      // POST /xrpc/dev.hatk.deleteRecord — proxy delete to user's PDS
      if (url.pathname === coreXrpc('deleteRecord') && request.method === 'POST' && oauth) {
        if (!viewer) return withCors(jsonError(401, 'Authentication required', acceptEncoding))
        const body = JSON.parse(await request.text())
        try {
          const result = await pdsDeleteRecord(oauth, viewer, body)
          return withCors(json(result, 200, acceptEncoding))
        } catch (err: any) {
          if (err instanceof ScopeMissingProxyError) return scopeMissingResponse(acceptEncoding, viewer?.handle)
          if (err instanceof ProxyError) return withCors(json({ error: err.message, ...(viewer?.handle ? { handle: viewer.handle } : {}) }, err.status, acceptEncoding))
          throw err
        }
      }

      // POST /xrpc/dev.hatk.putRecord — proxy create-or-update to user's PDS
      if (url.pathname === coreXrpc('putRecord') && request.method === 'POST' && oauth) {
        if (!viewer) return withCors(jsonError(401, 'Authentication required', acceptEncoding))
        const body = JSON.parse(await request.text())
        try {
          const result = await pdsPutRecord(oauth, viewer, body)
          return withCors(json(result, 200, acceptEncoding))
        } catch (err: any) {
          if (err instanceof ScopeMissingProxyError) return scopeMissingResponse(acceptEncoding, viewer?.handle)
          if (err instanceof ProxyError) return withCors(json({ error: err.message, ...(viewer?.handle ? { handle: viewer.handle } : {}) }, err.status, acceptEncoding))
          throw err
        }
      }

      // POST /xrpc/dev.hatk.uploadBlob — proxy blob upload to user's PDS
      if (url.pathname === coreXrpc('uploadBlob') && request.method === 'POST' && oauth) {
        if (!viewer) return withCors(jsonError(401, 'Authentication required', acceptEncoding))
        const contentType = request.headers.get('content-type') || 'application/octet-stream'
        const rawBody = new Uint8Array(await request.arrayBuffer())
        try {
          const result = await pdsUploadBlob(oauth, viewer, rawBody, contentType)
          return withCors(json(result, 200, acceptEncoding))
        } catch (err: any) {
          if (err instanceof ScopeMissingProxyError) return scopeMissingResponse(acceptEncoding, viewer?.handle)
          if (err instanceof ProxyError) return withCors(json({ error: err.message, ...(viewer?.handle ? { handle: viewer.handle } : {}) }, err.status, acceptEncoding))
          throw err
        }
      }

      // GET /admin — serve admin UI from hatk package
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        const adminPath = join(import.meta.dirname, '../public/admin.html')
        try {
          const content = await readFile(adminPath)
          return withCors(file(content, 'text/html'))
        } catch {
          return withCors(new Response('Admin page not found', { status: 404 }))
        }
      }

      // GET /admin/admin-auth.js — serve bundled OAuth client
      if (url.pathname === '/admin/admin-auth.js') {
        const authPath = join(import.meta.dirname, '../public/admin-auth.js')
        try {
          const content = await readFile(authPath)
          return withCors(file(content, 'application/javascript'))
        } catch {
          return notFound()
        }
      }

      // GET /_health
      if (url.pathname === '/_health') {
        return withCors(json({ status: 'ok' }, 200, acceptEncoding))
      }

      // GET /og/* — OpenGraph image routes
      if (url.pathname.startsWith('/og/')) {
        const png = await handleOpengraphRequest(url.pathname)
        if (png) return withCors(file(png, 'image/png', 'public, max-age=300'))
      }

      // GET/POST /xrpc/{nsid} — custom XRPC handlers (matched by full NSID from folder structure)
      if (url.pathname.startsWith('/xrpc/')) {
        const method = url.pathname.slice('/xrpc/'.length)
        const limit = parseInt(url.searchParams.get('limit') || '20')
        const cursor = url.searchParams.get('cursor') || undefined

        const params: Record<string, string> = {}
        for (const [key, value] of url.searchParams) {
          params[key] = value
        }

        // Parse request body for POST (procedures)
        let input: unknown
        if (request.method === 'POST') {
          try {
            input = JSON.parse(await request.text())
          } catch {
            input = {}
          }
        }

        try {
          const result = await executeXrpc(method, params, cursor, limit, viewer, input)
          if (result) return withCors(json(result, 200, acceptEncoding))
        } catch (err: any) {
          if (err instanceof ScopeMissingProxyError) return scopeMissingResponse(acceptEncoding, viewer?.handle)
          if (err instanceof InvalidRequestError) {
            return withCors(jsonError(err.status, err.errorName || err.message, acceptEncoding))
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
          return withCors(file(content, 'text/plain'))
        } catch {
          // fall through
        }
      }

      // Static file serving
      if (publicDir) {
        try {
          const filePath = join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname)
          const content = await readFile(filePath)
          return withCors(file(content, MIME[extname(filePath)] || 'text/plain'))
        } catch {}

        // SSR or SPA fallback — serve index.html for client-side routes
        try {
          const template = await readFile(join(publicDir, 'index.html'), 'utf-8')
          const ogMeta = buildOgMeta(url.pathname, requestOrigin)

          // Try SSR first
          ;(globalThis as any).__hatk_viewer = viewer
          let renderedHtml: string | null
          try {
            renderedHtml = await renderPage(template, request, ogMeta)
          } finally {
            ;(globalThis as any).__hatk_viewer = null
          }
          if (renderedHtml) {
            return withCors(file(Buffer.from(renderedHtml), 'text/html'))
          }

          // SPA fallback — inject OG meta only
          let html = template
          if (ogMeta) {
            html = html.replace('</head>', `${ogMeta}\n</head>`)
          }
          return withCors(file(Buffer.from(html), 'text/html'))
        } catch {}
      }

      return notFound()
    } catch (err: any) {
      error = err.message
      return withCors(jsonError(500, err.message, acceptEncoding))
    } finally {
      if ((isXrpc || isAdmin) && elapsed) {
        emit('server', 'request', {
          method: request.method,
          path: url.pathname,
          duration_ms: elapsed(),
          collection: url.searchParams.get('collection') || undefined,
          query: url.searchParams.get('q') || undefined,
          error,
        })
      }
    }
  }
}

// Backward-compatible wrapper
export function startServer(
  port: number,
  collections: string[],
  publicDir: string | null,
  oauth: OAuthConfig | null,
  admins: string[] = [],
  resolveViewer?: (request: Request) => { did: string } | null,
  onResync?: () => void,
): import('node:http').Server {
  const handler = createHandler({ collections, publicDir, oauth, admins, resolveViewer, onResync })
  return serve(handler, port)
}
