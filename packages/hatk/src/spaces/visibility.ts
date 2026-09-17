/**
 * Which permissioned spaces the read in flight is allowed to serve.
 *
 * Space records are not public data. A space's authority decides who may read
 * it, and it decides that one caller at a time — so a row indexed out of a
 * space carries an audience, and serving it to a request that has not proven
 * it belongs to that audience discloses private data no matter how the query
 * was written.
 *
 * hatk has no other per-row visibility concept. The takedown join is
 * viewer-independent and `privateCollections` is all-or-nothing, so neither
 * could carry this. The rule here is instead:
 *
 *   a row with `space IS NULL` is public repo data and always readable;
 *   a row with a space is readable only inside a scope that names that space.
 *
 * The default is an empty scope, which serves no space rows at all. That is
 * deliberate: a read path nobody remembered to scope fails closed and shows a
 * member nothing, rather than failing open and showing a stranger everything.
 * Every query over a record table applies `spaceFilterSql`; the scope is
 * established per request by whoever established the viewer.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const EMPTY: ReadonlySet<string> = new Set()

/**
 * Async-local rather than a module global: a server answers requests
 * concurrently, and one viewer's readable set must never be observable from
 * another's request while an await is outstanding.
 */
const store = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * Run `fn` with exactly these spaces readable.
 *
 * Replaces rather than extends any enclosing scope: widening what a nested read
 * may see is never what a caller means, and a scope that only ever narrows is
 * one that can be reasoned about locally.
 */
export function withReadableSpaces<T>(spaces: Iterable<string>, fn: () => T): T {
  return store.run(new Set(spaces), fn)
}

/**
 * Set the readable spaces for the rest of the current async context.
 *
 * `withReadableSpaces` wants a callback, and a request handler is a long body
 * rather than something to wrap — restructuring it around a closure to hold a
 * scope would be the tail wagging the dog. A server handler already runs in its
 * own async context per request, which is the case `enterWith` exists for.
 */
export function enterReadableSpaces(spaces: Iterable<string>): void {
  store.enterWith(new Set(spaces))
}

/** The spaces this read may serve. Empty outside any scope. */
export function readableSpaces(): ReadonlySet<string> {
  return store.getStore() ?? EMPTY
}

/** Whether a space would be served to the read in flight. */
export function isSpaceReadable(space: string | null | undefined): boolean {
  if (space == null) return true
  return readableSpaces().has(space)
}

/**
 * The space gate as a SQL predicate, for a table aliased `alias` (pass '' for
 * an unaliased table).
 *
 * `startIdx` is the next free `$N` placeholder; the returned `nextIdx` is the
 * next one after this predicate's own. With nothing readable the predicate
 * binds no parameters at all, which is the shape almost every request takes.
 */
export function spaceFilterSql(alias: string, startIdx: number): { sql: string; params: string[]; nextIdx: number } {
  const col = alias ? `${alias}.space` : 'space'
  const spaces = [...readableSpaces()]
  if (spaces.length === 0) return { sql: `${col} IS NULL`, params: [], nextIdx: startIdx }
  const placeholders = spaces.map((_, i) => `$${startIdx + i}`).join(', ')
  return {
    sql: `(${col} IS NULL OR ${col} IN (${placeholders}))`,
    params: spaces,
    nextIdx: startIdx + spaces.length,
  }
}
