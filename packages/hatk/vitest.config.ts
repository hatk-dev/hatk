import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/templates/**', 'src/lexicons/**', 'src/dev-entry.ts', 'src/test.ts'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: './coverage',
      // Floor set just under the measured baseline on 2026-09-16
      // (stmts 94.2 / branches 89.4 / funcs 91.1 / lines 95.5).
      // Raise these as coverage improves; never lower them.
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 90,
        lines: 94,
      },
    },
  },
})
