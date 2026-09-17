import { defineFeed } from '$hatk'

export default defineFeed({
  collection: 'your.collection.here',
  label: '{{Name}}',

  async generate(ctx) {
    // ctx.paginate applies the permissioned-space gate for you, so this page
    // shows a member the spaces they may read and everyone else the public
    // rows alone. A feed that builds its own SQL instead has to carry
    // ctx.spaceFilter itself.
    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      `SELECT uri, cid, indexed_at FROM "your.collection.here"`,
    )

    return ctx.ok({ uris: rows.map((r) => r.uri), cursor })
  },
})
