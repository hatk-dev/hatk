import { test as base, expect, type Page } from '@playwright/test'
import type { TestServer } from './test.ts'
import { startTestServer } from './test.ts'

type WorkerFixtures = {
  server: TestServer
}

/** Inject __TEST_AUTH__ into a page so isLoggedIn() and viewerDid() work. */
export async function loginAs(page: Page, did: string): Promise<void> {
  await page.addInitScript((d: string) => {
    ;(window as any).__TEST_AUTH__ = { did: d }
  }, did)
}

/**
 * Extended Playwright test with an auto-started hatk server fixture.
 * The server starts once per test file (worker scope) and is shared across tests.
 */
export const test = base.extend<{}, WorkerFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture API requires the deps arg
  server: [
    async (_deps, use) => {
      const server = await startTestServer()
      await server.loadFixtures()
      await use(server)
      await server.close()
    },
    { scope: 'worker' },
  ],
})

export { expect }
