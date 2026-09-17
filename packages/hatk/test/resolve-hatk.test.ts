import { expect, test, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// App server files import `$hatk` and `$hatk/client`, which Vite rewrites in
// the browser but plain Node does not. The hook maps just those two names onto
// the generated entry points in the project root and leaves every other
// specifier to the default resolver — capturing it here is the only way to
// exercise it without altering module resolution for the whole test process.

const registerHooks = vi.hoisted(() => vi.fn())
vi.mock('node:module', () => ({ registerHooks }))

const { registerHatkResolveHook } = await import('../src/resolve-hatk.ts')

function installedResolver() {
  registerHooks.mockClear()
  registerHatkResolveHook()
  expect(registerHooks).toHaveBeenCalledTimes(1)
  return registerHooks.mock.calls[0][0].resolve as (
    specifier: string,
    context: unknown,
    next: (s: string, c: unknown) => unknown,
  ) => any
}

test('$hatk resolves to hatk.generated.ts in the current working directory', () => {
  const resolveHook = installedResolver()
  const next = vi.fn()
  const result = resolveHook('$hatk', {}, next)
  expect(result).toEqual({ url: pathToFileURL(resolve('hatk.generated.ts')).href, shortCircuit: true })
  expect(next).not.toHaveBeenCalled()
})

test('$hatk/client resolves to the client entry point, not the server one', () => {
  const resolveHook = installedResolver()
  const result = resolveHook('$hatk/client', {}, vi.fn())
  expect(result).toEqual({ url: pathToFileURL(resolve('hatk.generated.client.ts')).href, shortCircuit: true })
})

test('every other specifier is delegated to the next resolver untouched', () => {
  const resolveHook = installedResolver()
  const context = { parentURL: 'file:///app/server/feed.ts' }
  const next = vi.fn(() => ({ url: 'file:///resolved.js' }))
  expect(resolveHook('./local.ts', context, next)).toEqual({ url: 'file:///resolved.js' })
  expect(resolveHook('$hatkish', context, next)).toEqual({ url: 'file:///resolved.js' })
  expect(next).toHaveBeenCalledWith('./local.ts', context)
  expect(next).toHaveBeenCalledWith('$hatkish', context)
})
