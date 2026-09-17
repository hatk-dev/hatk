/**
 * Record validation that knows about spaces.
 *
 * `@bigmoves/lexicon` checks an `at-uri` field against the shape the AT-URI
 * spec had before permissioned spaces: `at://authority/collection/rkey`. A
 * record inside a space is addressed through the space —
 * `at://authority/space/type/skey/writer/collection/rkey` — and a record that
 * points at one carries that form in an at-uri field. A reply names its thread
 * that way; a post that quotes a ride names the ride that way. The validator
 * refuses both as "invalid at-uri format", and every such record was silently
 * skipped by the indexer.
 *
 * Until the validator learns the form, this re-checks any at-uri refusal: if
 * the refused value is a space ref or a space record URI, it is put back as a
 * plain at-uri of the same length class and the record validated again, so
 * every other rule still applies. Bounded, because a record has finitely many
 * fields, and a refusal that is not about a space URI is returned unchanged.
 */

import { validateRecord } from '@bigmoves/lexicon'
import { parseSpaceRecordUri, parseSpaceRef } from '../spaces/uri.ts'

export type ValidationError = { path: string; message: string }

const AT_URI_ERROR = 'invalid at-uri format'
const PLACEHOLDER = 'at://did:plc:spaceplaceholder/app.hatk.space.ref/self'

function segmentsOf(path: string): (string | number)[] {
  // The validator writes `a.b` for objects and `a[0]` for arrays.
  return path
    .split(/\.|\[|\]/)
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s))
}

function getAt(record: unknown, path: string): unknown {
  let cur: any = record
  for (const seg of segmentsOf(path)) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

function withAt(record: any, path: string, value: unknown): any {
  const segs = segmentsOf(path)
  const clone = structuredClone(record)
  let cur: any = clone
  for (const seg of segs.slice(0, -1)) cur = cur[seg]
  cur[segs[segs.length - 1]] = value
  return clone
}

/** `validateRecord`, accepting space refs and space record URIs in at-uri fields. */
export function validateRecordWithSpaces(
  lexicons: any[],
  collection: string,
  record: Record<string, unknown>,
): ValidationError | null {
  let candidate: any = record
  for (let round = 0; round < 32; round++) {
    const error = validateRecord(lexicons, collection, candidate) as ValidationError | null
    if (!error || error.message !== AT_URI_ERROR) return error
    const value = getAt(candidate, error.path)
    if (typeof value !== 'string' || !(parseSpaceRecordUri(value) || parseSpaceRef(value))) return error
    candidate = withAt(candidate, error.path, PLACEHOLDER)
  }
  return null
}
