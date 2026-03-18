# Cloudflare Target Design

## Goal

Add `target: 'cloudflare'` to hatk so apps can deploy to Cloudflare Workers + Containers with D1 as the database. Same hatk project, different deployment target.

## Audience

hatk users who want edge deployment, scale-to-zero, or prefer Cloudflare over Railway/VPS.

## Architecture

When `hatk.config.ts` has `target: 'cloudflare'`, `hatk build` produces two deployment artifacts plus a generated Cloudflare config:

```
dist/
├── worker/          # Cloudflare Worker
│   └── index.ts     # Fetch handler: XRPC + SvelteKit SSR + OAuth + admin
├── container/       # Cloudflare Container (Node process)
│   └── index.ts     # Firehose subscription + backfill + label evaluation
└── wrangler.jsonc   # Generated config (D1 binding, Service Binding, Container)
```

### Component Split

| Component | Runtime | Responsibilities |
|-----------|---------|-----------------|
| **Worker** | Cloudflare Worker | XRPC handlers, SvelteKit SSR, OAuth, admin API |
| **Container** | Cloudflare Container | Firehose, backfill, label evaluation |
| **D1** | Shared | All data storage (SQLite-compatible) |

### Communication

Worker → Container via **Service Binding RPC**. The Worker calls methods on the Container directly as function calls (near-zero latency, no HTTP overhead):

- `env.CONTAINER.resync(did)` — trigger backfill for a single repo
- `env.CONTAINER.resyncAll()` — trigger full re-enumeration
- `env.CONTAINER.getStatus()` — backfill progress

No Container → Worker communication needed.

---

## D1 Database Adapter

New file: `packages/hatk/src/database/adapters/d1.ts`

Implements the existing `DatabasePort` interface using Cloudflare's D1 binding API. No changes to the interface itself.

### Query Execution

- **`query(sql, params)`** — `d1.prepare(sql).bind(...params).all()`
- **`execute(sql, params)`** — `d1.prepare(sql).bind(...params).run()`
- **`executeMultiple(sql)`** — Split by `;`, run as `d1.batch([...])`

### Transactions

D1 has no `BEGIN/COMMIT/ROLLBACK`. The adapter fakes it:

1. `beginTransaction()` — start buffering statements
2. `execute()` during a transaction — append to buffer instead of executing
3. `commit()` — flush buffer as `d1.batch([...])` (atomic — all succeed or all fail)
4. `rollback()` — clear the buffer

This preserves the same atomicity guarantee as real transactions.

### Bulk Insert

The existing `BulkInserter` interface stays the same. The D1 implementation:

1. `append(values)` — generate an INSERT statement, add to batch buffer
2. `flush()` — send buffer as `d1.batch([...])`, clear buffer
3. Buffer size tuned to stay under D1's CPU limits per batch

No prepared statements or native appenders — all dynamic SQL generation.

### Dialect

D1 is SQLite under the hood. Reuse the SQLite dialect's type map and placeholder style. No new dialect flags — the D1 adapter handles its own constraints internally.

### FTS

D1 supports FTS5. The existing SQLite search port should work with D1 as-is.

---

## Config

```ts
// hatk.config.ts
export default defineConfig({
  target: 'cloudflare', // new field, default: 'node'
  // ... everything else stays the same
})
```

No other config changes. The `database` path field is ignored when target is `cloudflare` (D1 binding is configured in wrangler.jsonc).

---

## Worker Entry

Standard Cloudflare Workers fetch handler:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. Initialize D1 adapter from env.DB binding
    // 2. Try XRPC routes (same handlers, D1-backed ctx)
    // 3. Try admin routes (resync → env.CONTAINER.resync(did) via RPC)
    // 4. Fall through to SvelteKit for everything else
  }
}
```

XRPC handlers don't change — they receive `ctx` with `ctx.db.query()` backed by D1 instead of SQLite. OAuth is pure JS crypto, no native deps.

SvelteKit uses `@sveltejs/adapter-cloudflare` instead of `adapter-node`.

### Admin Resync Change

The only behavioral difference from the Node target: admin resync calls `env.CONTAINER.resync(did)` over RPC instead of `triggerAutoBackfill(did)` in-process.

---

## Container Entry

A standard Node process (Cloudflare Containers support Node). Essentially the current `main.ts` minus the HTTP server:

- Connects to firehose relay via WebSocket
- Processes commits, validates records, writes to D1
- Runs backfill loop for pending repos
- Exposes RPC methods for the Worker to call

No CPU/memory limits like Workers — it's a real container.

---

## Build Step

`hatk build` with `target: 'cloudflare'`:

1. Run `@sveltejs/adapter-cloudflare` for SvelteKit
2. Bundle XRPC handlers + OAuth into Worker entry
3. Bundle firehose + backfill into Container entry
4. Generate `wrangler.jsonc` with D1 binding, Service Binding to Container

User deploys with `npx wrangler deploy`.

---

## Known Limitations

- **D1 size limit**: 10GB per database. Cannot be increased. Sufficient for most hatk apps, but large-scale indexing may hit this. Document as a constraint of the Cloudflare target.
- **Backfill speed**: D1 writes are ~30ms (HTTP) vs sub-ms (local SQLite). Backfill will be noticeably slower on Cloudflare.
- **No horizontal sharding**: Single D1 database. Cloudflare's recommended pattern is per-tenant sharding, but that doesn't apply to firehose indexing.

---

## Implementation Scope

| Component | Estimated Lines | Description |
|-----------|----------------|-------------|
| D1 adapter | ~400 | `DatabasePort` implementation with batch transactions, bulk inserter |
| Dialect update | ~20 | Minimal — reuse SQLite dialect |
| Adapter factory | ~20 | Add `d1` engine selection |
| Worker entry | ~150 | Fetch handler wiring XRPC + SvelteKit + OAuth |
| Container entry | ~100 | Firehose + backfill + RPC methods |
| Build command | ~200 | `--target cloudflare` output generation + wrangler.jsonc |
| Config | ~10 | `target` field in `HatkConfig` |
| **Total** | **~900** | |
