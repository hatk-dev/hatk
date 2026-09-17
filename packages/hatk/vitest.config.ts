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
      // (stmts 27.2 / branches 23.9 / funcs 34.2 / lines 28.3).
      // Raise these as coverage improves; never lower them.
      thresholds: {
        statements: 26,
        branches: 22,
        functions: 32,
        lines: 27,
      },
    },
  },
})
