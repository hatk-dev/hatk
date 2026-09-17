import { defineQuery } from '$hatk'

export default defineQuery('{{name}}', async (ctx) => {
  const { ok, db, params, packCursor, unpackCursor, spaceFilter } = ctx
  const limit = params.limit ?? 30
  const cursor = params.cursor

  const conditions: string[] = []
  const sqlParams: (string | number)[] = []
  let paramIdx = 1

  // Which permissioned spaces this viewer may be shown. Typed helpers like
  // ctx.lookup and ctx.getRecords apply this already; hand-written SQL cannot,
  // because nothing can inject a predicate into a string you wrote. Drop it and
  // a collection any space writes into is served to whoever asks.
  //
  // Outside a viewer's scope it is `s.space IS NULL` and binds nothing, so on an
  // instance that indexes no space it costs one test on an indexed column.
  const spaces = spaceFilter('s', paramIdx)
  conditions.push(spaces.sql)
  sqlParams.push(...spaces.params)
  paramIdx = spaces.nextIdx

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
