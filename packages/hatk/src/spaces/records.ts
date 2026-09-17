/**
 * The reads an app over permissioned spaces needs and should not have to write.
 *
 * Each of these is two things done in the right order — a select that carries
 * the space gate, then resolution into properly shaped rows — and an app that
 * writes them itself has to know both. Getting the first wrong serves a private
 * space to whoever asks. So they are the framework's.
 */

import { getRecordsByUris, getSchema, reshapeRow } from '../database/db.ts'
import { resolveRecords } from '../hydrate.ts'
import type { Row } from '../lex-types.ts'
import { InvalidRequestError } from '../xrpc.ts'
import { spaceFilterSql, isSpaceReadable } from './visibility.ts'
import { guardedQuerySQL } from './guard.ts'

/**
 * Every record of one collection in one space the viewer may read, oldest
 * first.
 *
 * A space outside the viewer's scope matches no rows, so the result is empty
 * rather than refused; `requireSpace` is the explicit refusal for a page that
 * should say "members only" instead of showing nothing.
 */
export async function spaceRecords<R = unknown>(collection: string, space: string): Promise<Row<R>[]> {
  if (!getSchema(collection)) return []
  const gate = spaceFilterSql('t', 2)
  const rows = (await guardedQuerySQL(
    `SELECT t.uri FROM "${collection}" t WHERE t.space = $1 AND ${gate.sql} ORDER BY t.indexed_at ASC`,
    [space, ...gate.params],
  )) as { uri: string }[]
  return resolveRecords(rows.map((r) => r.uri)) as Promise<Row<R>[]>
}

/**
 * Every record of one collection where `field` is one of `values`, oldest
 * first — the many-rows counterpart of `ctx.lookup`, which keeps one per key.
 *
 * Gated like every other read: a space row appears only inside a scope that
 * names its space, and a public row always.
 */
export async function records<R = unknown>(collection: string, field: string, values: string[]): Promise<Row<R>[]> {
  const schema = getSchema(collection)
  if (!schema || values.length === 0) return []
  const known = new Set(schema.columns.map((c) => c.name))
  known.add('did')
  // The field goes into SQL by name; a name the schema does not know is
  // either a typo or an attempt, and both are refused the same way.
  if (!known.has(field)) throw new InvalidRequestError(`Unknown field ${field} on ${collection}`)
  const placeholders = values.map((_, i) => `$${i + 1}`).join(',')
  const gate = spaceFilterSql('t', values.length + 1)
  const rows = (await guardedQuerySQL(
    `SELECT t.uri FROM "${collection}" t WHERE t.${field} IN (${placeholders}) AND ${gate.sql} ORDER BY t.indexed_at ASC`,
    [...values, ...gate.params],
  )) as { uri: string }[]
  return resolveRecords(rows.map((r) => r.uri)) as Promise<Row<R>[]>
}

/**
 * Refuse the way the space itself would.
 *
 * A viewer the space's authority does not admit gets `NotAuthorized`, which
 * is the ordinary shape of "not a member" — the same answer their own browser
 * would have had from a refused credential.
 */
export function requireSpace(space: string): void {
  if (!isSpaceReadable(space)) throw new InvalidRequestError('Not a member of this space', 'NotAuthorized')
}

// Re-exported so a handler can shape a row the way a read shaped it.
export { getRecordsByUris, reshapeRow }
