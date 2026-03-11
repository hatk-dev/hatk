import type { Plugin } from 'vite'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

export function hatk(opts?: { port?: number }): Plugin {
  const devPort = 3000
  const backendPort = opts?.port ?? devPort + 1
  const issuer = `http://127.0.0.1:${devPort}`
  let serverProcess: ChildProcess | null = null

  return {
    name: 'vite-plugin-hatk',

    config() {
      const target = `http://127.0.0.1:${backendPort}`
      // changeOrigin: false preserves the original Host header so DPoP htu matches
      const rule = { target, changeOrigin: false }
      return {
        server: {
          host: '127.0.0.1',
          port: devPort,
          proxy: {
            '/xrpc': rule,
            '/oauth/par': rule,
            '/oauth/token': rule,
            '/oauth/jwks': rule,
            '/oauth/authorize': rule,
            '/oauth/callback': {
              ...rule,
              // Only proxy the PDS callback (iss !== our issuer) to the backend.
              // The client-side callback (iss === our issuer) should reach the SPA.
              bypass(req) {
                const url = new URL(req.url!, issuer)
                if (url.searchParams.get('iss') === issuer) return req.url!
              },
            },
            '/oauth/client-metadata.json': rule,
            '/oauth-client-metadata.json': rule,
            '/.well-known': rule,
            '/info': rule,
            '/repos': rule,
            '/og': rule,
            '/admin': rule,
            '/_health': rule,
          },
        },
        test: {
          projects: [
            {
              test: {
                name: 'unit',
                include: ['test/feeds/**/*.test.ts', 'test/xrpc/**/*.test.ts'],
              },
            },
            {
              test: {
                name: 'integration',
                include: ['test/integration/**/*.test.ts'],
              },
            },
          ],
        },
      }
    },

    configureServer(server) {
      const mainPath = resolve(import.meta.dirname!, 'main.js')
      const watchDirs = ['xrpc', 'feeds', 'labels', 'jobs', 'setup', 'lexicons'].filter((d) => existsSync(d))
      const watchArgs = watchDirs.flatMap((d) => ['--watch-path', d])
      serverProcess = spawn('npx', ['tsx', 'watch', ...watchArgs, mainPath, 'config.yaml'], {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(backendPort),
          OAUTH_ISSUER: process.env.OAUTH_ISSUER || issuer,
        },
      })

      server.httpServer?.on('close', () => {
        serverProcess?.kill()
        serverProcess = null
      })
    },

    buildEnd() {
      serverProcess?.kill()
      serverProcess = null
    },
  }
}
