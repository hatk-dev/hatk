import { defineFeed } from '$hatk'

export default defineFeed({
  collection: 'your.collection.here',
  label: '{{Name}}',

  async generate(ctx) {
    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      `SELECT uri, cid, indexed_at FROM "your.collection.here"`,
    )

    return ctx.ok({ uris: rows.map((r) => r.uri), cursor })
  },
})
