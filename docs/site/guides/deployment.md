---
title: Deployment
description: Deploy hatk apps to Railway with SQLite, volumes, and production debugging.
---

## Railway

### Dockerfile

Include `sqlite3` in the container for production debugging:

```dockerfile
FROM node:25-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates xz-utils sqlite3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vp build
RUN npm prune --omit=dev
ENV NODE_ENV=production
CMD ["node", "--experimental-strip-types", "node_modules/@hatk/hatk/dist/main.js", "hatk.config.ts"]
```

### Volume

Mount a Railway volume at `/data` for the SQLite database:

```bash
railway volume create -m /data
```

Set the database path in `hatk.config.ts`:

```ts
export default defineConfig({
  databaseEngine: "sqlite",
  database: process.env.NODE_ENV === "production" ? "/data/app.db" : "data/app.db",
});
```

### Health checks

If setup scripts run long imports on startup, increase the health check timeout in `railway.toml`:

```toml
[deploy]
healthcheckPath = "/_health"
healthcheckTimeout = 600
```

### SSH debugging

Railway SSH doesn't reliably support piped stdin or shell metacharacters. Use the base64 script pattern to run queries on prod:

```bash
# Write a shell script locally
cat > /tmp/query.sh <<'EOF'
sqlite3 /data/app.db "SELECT COUNT(*) FROM [my.collection];"
EOF

# Base64 encode and execute via SSH
B64=$(base64 < /tmp/query.sh | tr -d '\n')
railway ssh "sh -c \"echo $B64 | base64 -d | sh\""
```

For multi-line SQL, use heredocs inside the script:

```bash
cat > /tmp/query.sh <<'EOF'
sqlite3 /data/app.db <<'EOSQL'
EXPLAIN QUERY PLAN
SELECT t.uri FROM [my.collection] t
ORDER BY t.some_field DESC LIMIT 50;
EOSQL
EOF
```

Use bracket quoting `[table.name]` instead of double quotes for table names to avoid escaping issues.

## SQLite production notes

### Custom indexes

hatk auto-creates indexes on `indexed_at DESC`, `did`, child table `parent_uri`, and child table text columns. For app-specific queries, add custom indexes in a setup script:

```ts
// server/setup/create-indexes.ts
import { defineSetup } from "$hatk";

export default defineSetup(async (ctx) => {
  const { db } = ctx;
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_plays_played_time
     ON "fm.teal.alpha.feed.play"(played_time DESC)`,
  );
});
```

Setup scripts run on every startup. `CREATE INDEX IF NOT EXISTS` makes them idempotent.

### Datetime comparisons

SQLite's `datetime()` returns space-separated format (`2026-03-16 12:00:00`) while hatk stores ISO timestamps with `T` separator (`2026-03-16T12:00:00Z`). String comparison breaks because `T` > space in ASCII.

```sql
-- WRONG: matches too many rows
WHERE played_time >= datetime('now', '-4 hours')

-- CORRECT: generates ISO format
WHERE played_time >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 hours')
```

### Query performance tips

Use `EXPLAIN QUERY PLAN` via SSH to diagnose slow queries. Watch for:

- **`SCAN` without index** — add an index on the filtered/ordered column
- **`USE TEMP B-TREE FOR ORDER BY`** — the `ORDER BY` column needs a descending index
- **Large JOINs with DISTINCT** — rewrite as `EXISTS` subqueries so SQLite can walk an index and stop at `LIMIT`

For expensive aggregation queries (trending lists, category counts), use stale-while-revalidate caching:

```ts
let cache: { data: any; expires: number } | null = null;
const TTL = 5 * 60 * 1000;

async function refresh(db) {
  const rows = await db.query(`...`);
  cache = { data: rows, expires: Date.now() + TTL };
  return rows;
}

// In handler:
if (cache) {
  if (Date.now() >= cache.expires) refresh(db); // background refresh
  return ok(cache.data); // serve stale immediately
}
return ok(await refresh(db)); // first request waits
```
