/**
 * Refusing hand-written SQL that would serve a private space to everyone.
 *
 * Every read hatk owns applies the space gate. The one it does not own is raw
 * SQL from an app's own handlers — a feed, a query, a hydration step — and
 * nothing can inject a predicate into a string somebody else wrote. So the
 * open question was who remembers to add it. The honest answer is nobody: a
 * feed written today over public data becomes a leak the day somebody adds a
 * space type that writes into the same collection, and the feed never changed.
 *
 * This turns that silent leak into a loud, deterministic error. hatk knows at
 * boot exactly which tables can hold a space row — the collections the
 * configured space types declare — so a raw query naming one of those tables
 * without the gate is refused, by name, with the helper that fixes it.
 *
 * A guard rail rather than the boundary. Detection is a token match on the
 * quoted table name and on the gate's own SQL; it is meant to catch the
 * mistake in development on the first run, not to survive an adversary. The
 * gate applied by the helpers is the boundary. On an instance that indexes no
 * space the set is empty and this is a Set lookup that never matches.
 */

import { querySQL } from '../database/db.ts'

/** Tables that can hold a row from a permissioned space. Empty unless spaces are configured. */
let spaceBacked = new Set<string>()

export function setSpaceBackedCollections(collections: Iterable<string>): void {
  spaceBacked = new Set(collections)
}

export function spaceBackedCollections(): ReadonlySet<string> {
  return spaceBacked
}

/**
 * The gate's own predicate, in either of the shapes `spaceFilterSql` emits:
 * `t.space IS NULL` when nothing is readable, and
 * `(t.space IS NULL OR t.space IN (...))` when something is. A query that
 * selects one space with `t.space = $1` does not contain this and is refused —
 * correctly, because naming a space is not the same as being allowed to read
 * it.
 */
const GATE_TOKEN = /\bspace\s+is\s+null\b/i

export class UngatedSpaceQueryError extends Error {
  constructor(readonly table: string) {
    super(
      `Raw SQL reads "${table}", which permissioned spaces write into, without the space gate. ` +
        `Records in it are private to the space's members. Apply ctx.spaceFilter(alias, nextParam) ` +
        `to the query, read through ctx.paginate or the typed helpers, or use ctx.db.unfiltered ` +
        `if this result is never served to a viewer.`,
    )
    this.name = 'UngatedSpaceQueryError'
  }
}

/** Throw if `sql` names a space-backed table and carries no gate. */
export function assertGatedSql(sql: string): void {
  if (spaceBacked.size === 0) return
  if (GATE_TOKEN.test(sql)) return
  for (const collection of spaceBacked) {
    if (sql.includes(`"${collection}"`)) throw new UngatedSpaceQueryError(collection)
  }
}

/** `querySQL` for app-facing contexts: the same query, refused when it would leak. */
export async function guardedQuerySQL(sql: string, params: unknown[] = []): Promise<unknown[]> {
  // Async so a refusal is a rejected promise like any other query failure,
  // rather than a synchronous throw a caller awaiting the result never sees.
  assertGatedSql(sql)
  return querySQL(sql, params)
}

/**
 * `querySQL` with the guard deliberately off.
 *
 * Its own name rather than an option, so that every place an app reads a
 * space-backed table without the gate says so where it does it and can be
 * found with grep. For results that are never served to a viewer: an admin
 * rollup, a count, a maintenance pass.
 */
export function unfilteredQuerySQL(sql: string, params: unknown[] = []): Promise<unknown[]> {
  return querySQL(sql, params)
}
