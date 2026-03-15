import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

/**
 * Register a Node.js module resolve hook so dynamic import() of server files
 * can resolve the $hatk alias to the generated entry points.
 */
export function registerHatkResolveHook(): void {
  const hatkUrl = pathToFileURL(resolve('hatk.generated.ts')).href
  const hatkClientUrl = pathToFileURL(resolve('hatk.generated.client.ts')).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '$hatk/client') return { url: hatkClientUrl, shortCircuit: true }
      if (specifier === '$hatk') return { url: hatkUrl, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}
