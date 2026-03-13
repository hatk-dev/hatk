# Auto-Schema Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a developer changes a lexicon, hatk automatically migrates the database schema on startup and re-syncs affected data — no migration files, no manual commands.

**Architecture:** Add a `migrateSchema()` function in `database/db.ts` that runs after `initDatabase` creates tables but before setup hooks. It compares each collection's current DB columns against `generateTableSchema()` output and emits `ALTER TABLE` statements. If any columns changed, all repos are marked for re-sync.

**Tech Stack:** SQLite (`PRAGMA table_info`), DuckDB (`information_schema.columns`), existing `TableSchema`/`SqlDialect` types

---

### Task 1: Add introspection methods to SqlDialect

**Files:**
- Modify: `packages/hatk/src/database/dialect.ts`

**Step 1: Add `introspectColumns` to `SqlDialect` interface**

Add a method that returns the SQL query to get column names and types for a given table. The query should return rows with `column_name` and `data_type` fields.

```typescript
// Add to SqlDialect interface:
/** SQL to get columns for a table. Receives table name as $1/?. Returns rows with column_name, data_type. */
introspectColumnsQuery(tableName: string): string
```

**Step 2: Implement for DuckDB**

```typescript
// In DUCKDB_DIALECT:
introspectColumnsQuery: (tableName: string) =>
  `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableName}'`,
```

**Step 3: Implement for SQLite**

SQLite's `PRAGMA table_info` returns `name` and `type` columns. Wrap it to match the expected shape:

```typescript
// In SQLITE_DIALECT:
introspectColumnsQuery: (tableName: string) =>
  `PRAGMA table_info("${tableName}")`,
```

Note: SQLite PRAGMA returns `name` and `type` instead of `column_name` and `data_type`. The migration function will need to normalize these.

**Step 4: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 2: Write migrateSchema function — column introspection

**Files:**
- Modify: `packages/hatk/src/database/db.ts`

**Step 1: Add the `migrateSchema` function signature and column fetching**

Add after `initDatabase`. This function queries each collection table for its current columns and compares against the expected schema.

```typescript
interface MigrationChange {
  table: string
  action: 'add' | 'drop' | 'retype'
  column: string
  type?: string
}

export async function migrateSchema(tableSchemas: TableSchema[]): Promise<MigrationChange[]> {
  const changes: MigrationChange[] = []

  for (const schema of tableSchemas) {
    if (schema.columns.length === 0) continue // generic JSON storage, skip

    const tableName = schema.collection
    const existingCols = await getExistingColumns(tableName)
    if (existingCols.size === 0) continue // table just created, nothing to migrate

    // Compare columns (next task)
  }

  return changes
}
```

**Step 2: Add `getExistingColumns` helper**

This queries the DB and returns a Map of column name → type, normalizing across SQLite/DuckDB.

```typescript
async function getExistingColumns(tableName: string): Promise<Map<string, string>> {
  const cols = new Map<string, string>()
  try {
    const query = dialect.introspectColumnsQuery(tableName)
    const rows = await all(query)
    for (const row of rows) {
      // SQLite PRAGMA returns { name, type }, DuckDB returns { column_name, data_type }
      const name = (row.column_name || row.name) as string
      const type = ((row.data_type || row.type) as string).toUpperCase()
      cols.set(name, type)
    }
  } catch {
    // Table doesn't exist yet
  }
  return cols
}
```

**Step 3: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 3: Implement column diff logic

**Files:**
- Modify: `packages/hatk/src/database/db.ts`

**Step 1: Add column comparison inside `migrateSchema`**

Replace the `// Compare columns (next task)` comment with:

```typescript
    // Expected columns: base columns (uri, cid, did, indexed_at) + schema columns
    const expectedCols = new Map<string, string>()
    expectedCols.set('uri', 'TEXT')
    expectedCols.set('cid', 'TEXT')
    expectedCols.set('did', 'TEXT')
    expectedCols.set('indexed_at', dialect.timestampType.toUpperCase())
    for (const col of schema.columns) {
      expectedCols.set(col.name, col.sqlType.toUpperCase())
    }

    // Find new columns (in expected but not in existing)
    for (const [colName, colType] of expectedCols) {
      if (!existingCols.has(colName)) {
        changes.push({ table: tableName, action: 'add', column: colName, type: colType })
      }
    }

    // Find removed columns (in existing but not in expected)
    for (const [colName] of existingCols) {
      if (!expectedCols.has(colName)) {
        changes.push({ table: tableName, action: 'drop', column: colName })
      }
    }

    // Find type changes (same name, different type)
    for (const [colName, colType] of expectedCols) {
      const existingType = existingCols.get(colName)
      if (existingType && existingType !== colType) {
        changes.push({ table: tableName, action: 'retype', column: colName, type: colType })
      }
    }
```

**Step 2: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 4: Implement child table and union table diffing

**Files:**
- Modify: `packages/hatk/src/database/db.ts`

**Step 1: Add child table migration logic**

After the main table diff in `migrateSchema`, add diffing for child tables and union branch tables. These follow the same pattern but with `parent_uri` and `parent_did` as base columns instead of `uri/cid/did/indexed_at`.

```typescript
    // Diff child tables
    for (const child of schema.children) {
      const childTable = child.tableName.replace(/"/g, '')
      const existingChildCols = await getExistingColumns(childTable)
      if (existingChildCols.size === 0) continue

      const expectedChildCols = new Map<string, string>()
      expectedChildCols.set('parent_uri', 'TEXT')
      expectedChildCols.set('parent_did', 'TEXT')
      for (const col of child.columns) {
        expectedChildCols.set(col.name, col.sqlType.toUpperCase())
      }

      for (const [colName, colType] of expectedChildCols) {
        if (!existingChildCols.has(colName)) {
          changes.push({ table: childTable, action: 'add', column: colName, type: colType })
        }
      }
      for (const [colName] of existingChildCols) {
        if (!expectedChildCols.has(colName)) {
          changes.push({ table: childTable, action: 'drop', column: colName })
        }
      }
      for (const [colName, colType] of expectedChildCols) {
        const existingType = existingChildCols.get(colName)
        if (existingType && existingType !== colType) {
          changes.push({ table: childTable, action: 'retype', column: colName, type: colType })
        }
      }
    }

    // Diff union branch tables
    for (const union of schema.unions) {
      for (const branch of union.branches) {
        const branchTable = branch.tableName.replace(/"/g, '')
        const existingBranchCols = await getExistingColumns(branchTable)
        if (existingBranchCols.size === 0) continue

        const expectedBranchCols = new Map<string, string>()
        expectedBranchCols.set('parent_uri', 'TEXT')
        expectedBranchCols.set('parent_did', 'TEXT')
        for (const col of branch.columns) {
          expectedBranchCols.set(col.name, col.sqlType.toUpperCase())
        }

        for (const [colName, colType] of expectedBranchCols) {
          if (!existingBranchCols.has(colName)) {
            changes.push({ table: branchTable, action: 'add', column: colName, type: colType })
          }
        }
        for (const [colName] of existingBranchCols) {
          if (!expectedBranchCols.has(colName)) {
            changes.push({ table: branchTable, action: 'drop', column: colName })
          }
        }
        for (const [colName, colType] of expectedBranchCols) {
          const existingType = existingBranchCols.get(colName)
          if (existingType && existingType !== colType) {
            changes.push({ table: branchTable, action: 'retype', column: colName, type: colType })
          }
        }
      }
    }
```

**Step 2: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 5: Apply ALTER TABLE statements

**Files:**
- Modify: `packages/hatk/src/database/db.ts`

**Step 1: Add `applyMigrationChanges` function**

This takes the list of changes and executes the corresponding SQL.

```typescript
async function applyMigrationChanges(changes: MigrationChange[]): Promise<void> {
  for (const change of changes) {
    const quotedTable = `"${change.table}"`
    try {
      switch (change.action) {
        case 'add':
          await run(`ALTER TABLE ${quotedTable} ADD COLUMN ${change.column} ${change.type}`)
          emit('migration', `added column "${change.column}" ${change.type} to "${change.table}"`)
          break
        case 'drop':
          await run(`ALTER TABLE ${quotedTable} DROP COLUMN ${change.column}`)
          emit('migration', `dropped column "${change.column}" from "${change.table}"`)
          break
        case 'retype':
          // Drop and re-add with new type
          await run(`ALTER TABLE ${quotedTable} DROP COLUMN ${change.column}`)
          await run(`ALTER TABLE ${quotedTable} ADD COLUMN ${change.column} ${change.type}`)
          emit('migration', `changed column "${change.column}" type to ${change.type} in "${change.table}"`)
          break
      }
    } catch (err: any) {
      emit('migration', `failed to ${change.action} column "${change.column}" on "${change.table}": ${err.message}`)
    }
  }
}
```

**Step 2: Call `applyMigrationChanges` from `migrateSchema`**

At the end of `migrateSchema`, before `return changes`:

```typescript
  if (changes.length > 0) {
    await applyMigrationChanges(changes)
  }

  return changes
```

**Step 3: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 6: Handle orphaned child/union tables

**Files:**
- Modify: `packages/hatk/src/database/db.ts`

**Step 1: Add orphaned table detection and cleanup to `migrateSchema`**

After diffing each collection's child/union tables, detect tables that exist in the DB with the collection prefix but are no longer referenced in the schema.

```typescript
  // Detect orphaned child/union tables
  for (const schema of tableSchemas) {
    if (schema.columns.length === 0) continue

    const expectedTables = new Set<string>()
    for (const child of schema.children) {
      expectedTables.add(child.tableName.replace(/"/g, ''))
    }
    for (const union of schema.unions) {
      for (const branch of union.branches) {
        expectedTables.add(branch.tableName.replace(/"/g, ''))
      }
    }

    // Query existing tables that match the collection prefix
    try {
      const rows = await all(dialect.listTablesQuery)
      for (const row of rows) {
        const name = row.table_name as string
        if (name.startsWith(schema.collection + '__') && !expectedTables.has(name)) {
          await run(`DROP TABLE IF EXISTS "${name}"`)
          emit('migration', `dropped orphaned table "${name}"`)
          changes.push({ table: name, action: 'drop', column: '*' })
        }
      }
    } catch {}
  }
```

**Step 2: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 7: Handle index creation for new ref columns

**Files:**
- Modify: `packages/hatk/src/database/db.ts`

**Step 1: Add index creation for newly added ref columns**

When a new column is added, if it's a ref column, create the corresponding index. Add this logic inside the `case 'add':` block in `applyMigrationChanges`.

```typescript
        case 'add': {
          await run(`ALTER TABLE ${quotedTable} ADD COLUMN ${change.column} ${change.type}`)
          emit('migration', `added column "${change.column}" ${change.type} to "${change.table}"`)
          // Create index for ref columns
          const schema = schemas.get(change.table)
          if (schema?.refColumns.includes(change.column)) {
            const prefix = change.table.replace(/\./g, '_')
            await run(`CREATE INDEX IF NOT EXISTS idx_${prefix}_${change.column} ON ${quotedTable}(${change.column})`)
            emit('migration', `created index for ref column "${change.column}" on "${change.table}"`)
          }
          break
        }
```

**Step 2: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 8: Trigger backfill for new empty collection tables

**Files:**
- Modify: `packages/hatk/src/database/db.ts`

**Step 1: Add empty-table detection to `migrateSchema`**

After applying ALTER changes and orphaned table cleanup, check if any collection table has zero rows. If so, mark all repos as pending so backfill picks up the new collection.

Add at the end of `migrateSchema`, before `return changes`:

```typescript
  // Check for empty collection tables — these are newly added and need backfill
  for (const schema of tableSchemas) {
    if (schema.columns.length === 0) continue
    try {
      const [row] = await all(`SELECT 1 FROM ${schema.tableName} LIMIT 1`)
      if (!row) {
        await run(`UPDATE _repos SET status = 'pending'`)
        emit('migration', `new collection "${schema.collection}" detected, marking repos for backfill`)
        break // only need to mark once
      }
    } catch {}
  }
```

**Step 2: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 9: Wire migrateSchema into main.ts

**Files:**
- Modify: `packages/hatk/src/main.ts`

**Step 1: Import migrateSchema**

Add to the existing import from `./database/db.ts`:

```typescript
import { initDatabase, getCursor, querySQL, getSqlDialect, getSchemaDump, migrateSchema } from './database/db.ts'
```

**Step 2: Call migrateSchema after initDatabase, before setup hooks**

Insert between `initDatabase` (line 89) and the schema.sql write (line 94):

```typescript
// Auto-migrate schema if lexicons changed
const migrationChanges = await migrateSchema(schemas)
if (migrationChanges.length > 0) {
  log(`[main] Applied ${migrationChanges.length} schema migration(s)`)
}
```

This runs after `initDatabase` (which creates new tables) but before setup hooks and the backfill cycle.

**Step 3: Verify the build compiles**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 10: Remove hardcoded handle migration

**Files:**
- Modify: `packages/hatk/src/database/db.ts`

**Step 1: Remove the manual handle migration from `initDatabase`**

The existing hardcoded migration for the `handle` column in `_repos` (lines 74-79) is now superseded by the general migration system. However, `_repos` is an internal table not covered by lexicon schemas. Keep it as-is for now — it doesn't conflict and handles a one-time migration for existing databases.

No code change needed. This task is a deliberate no-op to document the decision.

---

### Task 11: Manual integration test — add a column

**Step 1: In the teal template, add a field to a lexicon**

Edit `~/code/hatk-template-teal/lexicons/fm/teal/alpha/feed/play.json` and add a `rating` integer field to the record properties.

**Step 2: Restart the dev server**

Run: `cd ~/code/hatk-template-teal && npm run dev`

**Step 3: Check the logs**

Expected output should include:
```
[migration] added column "rating" INTEGER to "fm.teal.alpha.feed.play"
```

**Step 4: Verify the schema.sql file**

Run: `cat ~/code/hatk-template-teal/db/schema.sql`

The `fm.teal.alpha.feed.play` table should now include the `rating` column.

**Step 5: Revert the lexicon change**

Remove the `rating` field from the lexicon file. Restart the dev server again.

Expected output:
```
[migration] dropped column "rating" from "fm.teal.alpha.feed.play"
```

---

### Task 12: Manual integration test — remove a child table

**Step 1: In the teal template, remove the `artists` array field from the play lexicon**

This should cause the `fm.teal.alpha.feed.play__artists` table to be dropped on next startup.

**Step 2: Restart the dev server**

Expected output:
```
[migration] dropped orphaned table "fm.teal.alpha.feed.play__artists"
```

**Step 3: Revert the lexicon change**

Restore the `artists` array field. Restart — the table should be recreated automatically by `CREATE TABLE IF NOT EXISTS`.

---

### Task 13: Build and verify

**Step 1: Run the build**

Run: `cd packages/hatk && npm run build`
Expected: Clean build, no errors

**Step 2: Verify with TypeScript**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors

---

### Task 14: Commit

```bash
git add packages/hatk/src/database/db.ts packages/hatk/src/database/dialect.ts packages/hatk/src/main.ts
git commit -m "feat: auto-schema migration on startup

Diff lexicon-derived schema against actual DB columns on every startup.
Emit ALTER TABLE ADD/DROP COLUMN for changes, drop orphaned child tables,
and trigger backfill when new empty collection tables are detected."
```
