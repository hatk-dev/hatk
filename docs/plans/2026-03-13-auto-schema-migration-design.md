# Auto-Schema Migration Design

**Goal:** When a developer changes a lexicon, hatk automatically migrates the database schema on startup and re-syncs affected data. No migration files, no manual commands.

## How It Works

On every startup, after `initDatabase` creates any missing tables but before setup hooks or indexing:

1. For each collection table, query the DB for its current columns
   - SQLite: `PRAGMA table_info(tableName)`
   - DuckDB: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ?`

2. Compare against `generateTableSchema()` output from the current lexicons

3. Emit changes:
   - **New column in lexicon** → `ALTER TABLE ADD COLUMN name TYPE [DEFAULT NULL]`
   - **Column removed from lexicon** → `ALTER TABLE DROP COLUMN name`
   - **Column type changed** → drop column + re-add with new type
   - **New child/union table** → already handled by `CREATE TABLE IF NOT EXISTS`
   - **Child/union table removed** → `DROP TABLE IF EXISTS`

4. Apply same logic to child tables and union branch tables

5. Log every change:
   ```
   [migration] added column "rating" INTEGER to "fm.teal.alpha.feed.play"
   [migration] dropped column "old_field" from "fm.teal.alpha.feed.play"
   ```

6. No automatic re-sync for column changes — existing data is already indexed, and new fields won't exist in old network records. But if any collection table is **empty** (newly added collection), mark all repos as `pending` so the backfill cycle picks up records for the new collection.

## What This Means for Developers

- Change a lexicon field → restart dev server → schema updates automatically → data re-syncs
- Add a new collection → restart → table created → backfill picks it up
- Remove a collection → restart → warning logged, run `hatk destroy collection` to clean up
- No migration files, no migration history, no `hatk migrate` command

## Edge Cases

- **SQLite ALTER TABLE limitations**: SQLite doesn't support `DROP COLUMN` before 3.35.0. `better-sqlite3` bundles SQLite 3.45+, so this is fine.
- **Indexes**: If a ref column is added, the corresponding index is created. If removed, the index is dropped with the column.
- **FTS**: FTS indexes are rebuilt on every startup anyway, so schema changes are automatically reflected.
- **Data loss on column drop/type change**: Acceptable because data comes from the AT Protocol network and is recoverable via backfill. Log clearly so developers understand what happened.

## Implementation Location

Add a `migrateSchema()` function in `database/db.ts` called from `initDatabase` after DDL execution. It receives the `TableSchema[]` and compares against the live database state.
