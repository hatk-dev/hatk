import { defineQuery } from '$hatk'

export default defineQuery('{{name}}', async (ctx) => {
  const { ok, db, params, packCursor, unpackCursor } = ctx
  const limit = params.limit ?? 30
  const cursor = params.cursor

  const conditions: string[] = []
  const sqlParams: (string | number)[] = []
  let paramIdx = 1

  if (cursor) {
    const parsed = unpackCursor(cursor)
    if (parsed) {
      conditions.push(`(s.indexed_at < $${paramIdx} OR (s.indexed_at = $${paramIdx + 1} AND s.cid < $${paramIdx + 2}))`)
      sqlParams.push(parsed.primary, parsed.primary, parsed.cid)
      paramIdx += 3
    }
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const rows = (await db.query(
    `SELECT s.* FROM "your.collection.here" s ${where} ORDER BY s.indexed_at DESC, s.cid DESC LIMIT $${paramIdx}`,
    sqlParams.concat([limit + 1]),
  )) as {
    uri: string
    cid: string
    did: string
    indexed_at: string
  }[]

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  const lastRow = rows[rows.length - 1]

  return ok({
    items: rows,
    cursor: hasMore && lastRow ? packCursor(lastRow.indexed_at, lastRow.cid) : undefined,
  })
})
