import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestContext } from '@hatk/hatk/test'

let ctx: Awaited<ReturnType<typeof createTestContext>>

beforeAll(async () => {
  ctx = await createTestContext()
  await ctx.loadFixtures()
})

afterAll(async () => ctx?.close())

describe('{{name}}', () => {
  test('returns response', async () => {
    const handler = ctx.loadXrpc('{{name}}')
    const result = await handler.handler({ params: {} })
    expect(result).toBeDefined()
  })
})
