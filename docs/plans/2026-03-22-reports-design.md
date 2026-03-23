# User Reports Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let authenticated users report accounts/records by selecting a label, and give admins a queue to review and act on those reports.

**Architecture:** New `_reports` SQLite table + db helper functions, a `dev.hatk.createReport` XRPC endpoint registered as a core handler, three admin REST endpoints in server.ts, and a new "Reports" tab in admin.html.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), vanilla HTML/CSS/JS admin UI

---

### Task 1: Create the `_reports` table in database init

**Files:**
- Modify: `packages/hatk/src/database/db.ts:67-127` (inside `initDatabase`, after the `_preferences` table creation)

**Step 1: Add the table creation SQL**

After the `_preferences` table block (line ~123) and before the OAuth DDL line, add:

```typescript
  // Reports table (user-submitted moderation reports)
  await run(`CREATE TABLE IF NOT EXISTS _reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_uri TEXT NOT NULL,
    subject_did TEXT NOT NULL,
    label TEXT NOT NULL,
    reason TEXT,
    reported_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_by TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL
  )`)
  await run(`CREATE INDEX IF NOT EXISTS idx_reports_status ON _reports(status)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_reports_subject_uri ON _reports(subject_uri)`)
```

**Step 2: Verify the app boots**

Run: `cd packages/hatk && npx vite build`
Expected: Build succeeds

---

### Task 2: Add report database helper functions

**Files:**
- Modify: `packages/hatk/src/database/db.ts` (add new exported functions at the end, before the final closing brace or after the last export)

**Step 1: Add the helper functions**

Add these exports to `db.ts`:

```typescript
export async function insertReport(report: {
  subjectUri: string
  subjectDid: string
  label: string
  reason?: string
  reportedBy: string
}): Promise<{ id: number }> {
  const createdAt = new Date().toISOString()
  await run(
    `INSERT INTO _reports (subject_uri, subject_did, label, reason, reported_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [report.subjectUri, report.subjectDid, report.label, report.reason || null, report.reportedBy, createdAt],
  )
  const rows = await all<{ id: number }>(`SELECT last_insert_rowid() as id`)
  return { id: rows[0].id }
}

export async function queryReports(opts: {
  status?: string
  label?: string
  limit?: number
  offset?: number
}): Promise<{ reports: any[]; total: number }> {
  const conditions: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (opts.status) {
    conditions.push(`r.status = $${idx++}`)
    params.push(opts.status)
  }
  if (opts.label) {
    conditions.push(`r.label = $${idx++}`)
    params.push(opts.label)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit || 50
  const offset = opts.offset || 0

  const countRows = await all<{ count: number }>(`SELECT COUNT(*) as count FROM _reports r ${where}`, params)
  const total = Number(countRows[0]?.count || 0)

  const rows = await all(
    `SELECT r.*, rp.handle as reported_by_handle FROM _reports r LEFT JOIN _repos rp ON r.reported_by = rp.did ${where} ORDER BY r.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  )

  return { reports: rows, total }
}

export async function resolveReport(
  id: number,
  action: 'resolved' | 'dismissed',
  resolvedBy: string,
): Promise<{ subjectUri: string; label: string } | null> {
  const rows = await all<{ subject_uri: string; label: string; status: string }>(
    `SELECT subject_uri, label, status FROM _reports WHERE id = $1`,
    [id],
  )
  if (!rows.length) return null
  if (rows[0].status !== 'open') return null

  await run(`UPDATE _reports SET status = $1, resolved_by = $2, resolved_at = $3 WHERE id = $4`, [
    action,
    resolvedBy,
    new Date().toISOString(),
    id,
  ])
  return { subjectUri: rows[0].subject_uri, label: rows[0].label }
}

export async function getOpenReportCount(): Promise<number> {
  const rows = await all<{ count: number }>(`SELECT COUNT(*) as count FROM _reports WHERE status = 'open'`)
  return Number(rows[0]?.count || 0)
}
```

**Step 2: Verify build**

Run: `cd packages/hatk && npx vite build`
Expected: Build succeeds

---

### Task 3: Register `dev.hatk.createReport` XRPC handler

**Files:**
- Modify: `packages/hatk/src/server.ts:27` (add imports)
- Modify: `packages/hatk/src/server.ts:167-203` (inside the `if (oauth)` block, add the new handler)

**Step 1: Add imports**

Add `insertReport` to the existing import from `'./database/db.ts'` (line 6-27):

```typescript
import {
  // ... existing imports ...
  insertReport,
} from './database/db.ts'
```

**Step 2: Add the handler**

Inside the `if (oauth) {` block (after the existing `dev.hatk.uploadBlob` handler, around line 202), add:

```typescript
    registerCoreXrpcHandler('dev.hatk.createReport', async (_params, _cursor, _limit, viewer, input) => {
      if (!viewer) throw new InvalidRequestError('Authentication required')
      const body = input as { subject?: any; label?: string; reason?: string }
      if (!body.subject) throw new InvalidRequestError('Missing subject')
      if (!body.label || typeof body.label !== 'string') throw new InvalidRequestError('Missing or invalid label')

      // Validate label exists in definitions
      const defs = getLabelDefinitions()
      if (!defs.some((d) => d.identifier === body.label)) {
        throw new InvalidRequestError(`Unknown label: ${body.label}`)
      }

      // Validate reason length
      if (body.reason && body.reason.length > 2000) {
        throw new InvalidRequestError('Reason must be 2000 characters or less')
      }

      // Determine subject URI and DID
      let subjectUri: string
      let subjectDid: string
      if (body.subject.uri) {
        // Record report: { uri, cid }
        subjectUri = body.subject.uri
        // Extract DID from at:// URI
        const match = body.subject.uri.match(/^at:\/\/(did:[^/]+)/)
        if (!match) throw new InvalidRequestError('Invalid subject URI')
        subjectDid = match[1]
      } else if (body.subject.did) {
        // Account report: { did }
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
```

**Step 3: Verify build**

Run: `cd packages/hatk && npx vite build`
Expected: Build succeeds

---

### Task 4: Add admin report endpoints

**Files:**
- Modify: `packages/hatk/src/server.ts` (add imports + admin routes)

**Step 1: Add imports**

Add `queryReports`, `resolveReport`, `getOpenReportCount` to the import from `'./database/db.ts'`:

```typescript
import {
  // ... existing imports ...
  queryReports,
  resolveReport,
  getOpenReportCount,
} from './database/db.ts'
```

**Step 2: Add the GET /admin/reports endpoint**

After the existing `GET /admin/repos` handler (around line 670), add:

```typescript
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
```

**Step 3: Add the POST /admin/reports/resolve endpoint**

Right after the GET handler above:

```typescript
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

        // If resolving, apply the label
        if (action === 'resolve') {
          await insertLabels([{ src: 'admin', uri: report.subjectUri, val: report.label }])
        }
        return withCors(json({ ok: true }, 200, acceptEncoding))
      }
```

**Step 4: Add openReports to the GET /admin/info response**

In the existing `/admin/info` handler (around line 619-636), modify the return to include the open report count. Change:

```typescript
        return withCors(
          json({ repos: counts, duckdb: dbInfo, node, collections: collectionCounts }, 200, acceptEncoding),
        )
```

to:

```typescript
        const openReports = await getOpenReportCount()
        return withCors(
          json({ repos: counts, duckdb: dbInfo, node, collections: collectionCounts, openReports }, 200, acceptEncoding),
        )
```

**Step 5: Verify build**

Run: `cd packages/hatk && npx vite build`
Expected: Build succeeds

---

### Task 5: Add Reports tab to admin UI

**Files:**
- Modify: `packages/hatk/public/admin.html`

**Step 1: Add the Reports tab button to desktop nav**

Find the `<nav class="tabs">` element (around line 1202) and add the Reports button:

```html
        <nav class="tabs">
          <button class="tab active" data-tab="overview">Overview</button>
          <button class="tab" data-tab="repos">Repos</button>
          <button class="tab" data-tab="content">Content</button>
          <button class="tab" data-tab="reports">Reports</button>
        </nav>
```

**Step 2: Add the Reports button to mobile bottom nav**

Find the `<div class="bottom-nav-track">` element (around line 1284) and add:

```html
          <button class="bnav-btn" data-tab="reports">Reports</button>
```

**Step 3: Add the Reports tab panel**

After the content tab panel closing `</div>` (before `<!-- Bottom nav (mobile) -->`), add:

```html
        <!-- Reports -->
        <div class="tab-panel" id="panel-reports">
          <div class="search-bar">
            <select class="search-input" id="reports-status" style="max-width: 200px">
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
            </select>
            <select class="search-input" id="reports-label-filter" style="max-width: 200px">
              <option value="">All labels</option>
            </select>
          </div>
          <div id="reports-results"></div>
        </div>
```

**Step 4: Add the tab activation case**

In the `activateTab` function (around line 1462), add after `if (tab === 'content') loadContent()`:

```javascript
        if (tab === 'reports') loadReports()
```

**Step 5: Add the loadReports function and rendering**

Before the closing `</script>` tag, add:

```javascript
      // ── Reports ──

      const reportsPage = { limit: 50, offset: 0 }

      function populateReportsLabelFilter() {
        const select = document.getElementById('reports-label-filter')
        select.innerHTML = '<option value="">All labels</option>' +
          labelDefinitions.map(d => `<option value="${d.identifier}">${d.identifier}</option>`).join('')
      }

      document.getElementById('reports-status').addEventListener('change', () => {
        reportsPage.offset = 0
        loadReports()
      })
      document.getElementById('reports-label-filter').addEventListener('change', () => {
        reportsPage.offset = 0
        loadReports()
      })

      async function loadReports() {
        populateReportsLabelFilter()
        const status = document.getElementById('reports-status').value
        const label = document.getElementById('reports-label-filter').value
        const container = document.getElementById('reports-results')
        container.innerHTML = '<div class="loading">Loading</div>'
        try {
          let url = `/admin/reports?status=${status}&limit=${reportsPage.limit}&offset=${reportsPage.offset}`
          if (label) url += `&label=${encodeURIComponent(label)}`
          const result = await api(url)
          renderReports(result.reports || [], result.total)
        } catch (e) {
          container.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`
        }
      }

      function renderReports(reports, total) {
        const container = document.getElementById('reports-results')
        if (!reports.length) {
          container.innerHTML = '<div class="empty-state">No reports found</div>'
          return
        }

        const showPagination = total != null && total > reportsPage.limit
        const paginationHtml = showPagination ? `
          <div class="pagination">
            <span>${reportsPage.offset + 1}\u2013${Math.min(reportsPage.offset + reportsPage.limit, total)} of ${total.toLocaleString()}</span>
            <div class="pagination-buttons">
              <button class="btn btn-sm" data-reports-page="prev" ${reportsPage.offset === 0 ? 'disabled' : ''}>Prev</button>
              <button class="btn btn-sm" data-reports-page="next" ${reportsPage.offset + reportsPage.limit >= total ? 'disabled' : ''}>Next</button>
            </div>
          </div>
        ` : ''

        const countLabel = total != null
          ? `${total.toLocaleString()} report${total !== 1 ? 's' : ''}`
          : `${reports.length} result${reports.length !== 1 ? 's' : ''}`

        const isOpen = document.getElementById('reports-status').value === 'open'

        container.innerHTML = `
          <div class="card">
            <div class="result-count">${countLabel}</div>
            ${reports.map(r => {
              const reporterDisplay = r.reported_by_handle ? `@${escapeHtml(r.reported_by_handle)}` : escapeHtml(r.reported_by)
              const date = new Date(r.created_at).toLocaleString()
              return `<div class="record-card">
                <div class="record-header">
                  <div class="record-meta">
                    <div class="record-uri" title="${escapeHtml(r.subject_uri)}">${escapeHtml(r.subject_uri)}</div>
                    <div class="record-summary">
                      <span class="label-tag">${escapeHtml(r.label)}</span>
                      reported by ${reporterDisplay} &middot; ${date}
                    </div>
                    ${r.reason ? `<div class="record-summary" style="margin-top:0.25rem">${escapeHtml(r.reason)}</div>` : ''}
                    ${!isOpen ? `<div class="record-summary" style="margin-top:0.25rem;opacity:0.6">${escapeHtml(r.status)} ${r.resolved_by ? `by ${escapeHtml(r.resolved_by)}` : ''}</div>` : ''}
                  </div>
                  ${isOpen ? `<div class="record-actions">
                    <button class="btn btn-sm" data-action="resolve-report" data-id="${r.id}" data-resolve="resolve" style="background:var(--accent);color:white">Apply Label</button>
                    <button class="btn btn-sm" data-action="resolve-report" data-id="${r.id}" data-resolve="dismiss">Dismiss</button>
                  </div>` : ''}
                </div>
              </div>`
            }).join('')}
            ${paginationHtml}
          </div>
        `

        container.querySelectorAll('[data-reports-page="prev"]').forEach(b => {
          b.addEventListener('click', () => { reportsPage.offset = Math.max(0, reportsPage.offset - reportsPage.limit); loadReports() })
        })
        container.querySelectorAll('[data-reports-page="next"]').forEach(b => {
          b.addEventListener('click', () => { reportsPage.offset += reportsPage.limit; loadReports() })
        })

        container.querySelectorAll('[data-action="resolve-report"]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const action = btn.dataset.resolve
            try {
              await api('/admin/reports/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: parseInt(btn.dataset.id), action }),
              })
              toast(action === 'resolve' ? 'Label applied & report resolved' : 'Report dismissed', 'success')
              loadReports()
            } catch (e) {
              toast(e.message, 'error')
            }
          })
        })
      }
```

**Step 6: Add report badge to overview**

In the `loadOverview` function, after the existing status cards are rendered, add the open reports count. Find where `info` is used in `loadOverview` and add after the status cards rendering:

In the overview section, the open reports count will already be available from the `/admin/info` response as `info.openReports`. Add a card showing the count. Find the status cards rendering and append:

```javascript
          if (info.openReports > 0) {
            statusCards.innerHTML += `<div class="stat-card" style="cursor:pointer" onclick="activateTab('reports')"><div class="stat-value">${info.openReports}</div><div class="stat-label">Open Reports</div></div>`
          }
```

**Step 7: Verify build**

Run: `cd packages/hatk && npx vite build`
Expected: Build succeeds

---

### Task 6: Final verification

**Step 1: Verify the full build**

Run: `cd packages/hatk && npx vite build`
Expected: Build succeeds with no errors

**Step 2: Commit**

```bash
git add packages/hatk/src/database/db.ts packages/hatk/src/server.ts packages/hatk/public/admin.html
git commit -m "feat: add user report system with admin review queue

Users can submit reports via dev.hatk.createReport XRPC endpoint,
selecting from the app's defined labels. Admins see a Reports tab
in the admin UI to review, apply labels, or dismiss reports."
```
