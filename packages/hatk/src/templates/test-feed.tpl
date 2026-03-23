import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestContext } from '@hatk/hatk/test'

let ctx: Awaited<ReturnType<typeof createTestContext>>

beforeAll(async () => {
  ctx = await createTestContext()
  await ctx.loadFixtures()
})

afterAll(async () => ctx?.close())

describe('{{name}} feed', () => {
  test('returns results', async () => {
    const feed = ctx.loadFeed('{{name}}')
    const result = await feed.generate(ctx.feedContext({ limit: 10 }))
    expect(result).toBeDefined()
  })
})
