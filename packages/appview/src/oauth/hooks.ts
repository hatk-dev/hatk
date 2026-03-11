import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { log } from '../logger.ts'
import { setRepoStatus } from '../db.ts'
import { triggerAutoBackfill } from '../indexer.ts'

/** onLogin hook: called after each successful OAuth login. */
export type OnLoginCtx = {
  did: string
  ensureRepo: (did: string) => Promise<void>
}

type OnLoginHook = (ctx: OnLoginCtx) => Promise<void>

let onLoginHook: OnLoginHook | null = null

/** Load on-login hook from the exercise's hooks/ directory. */
export async function loadOnLoginHook(hooksDir: string): Promise<void> {
  const tsPath = resolve(hooksDir, 'on-login.ts')
  const jsPath = resolve(hooksDir, 'on-login.js')
  const path = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null
  if (!path) return
  const mod = await import(path)
  onLoginHook = mod.default
  log('[oauth] on-login hook loaded')
}

async function ensureRepo(did: string): Promise<void> {
  await setRepoStatus(did, 'pending')
  triggerAutoBackfill(did)
}

/** Fire the onLogin hook if loaded. Errors are logged but don't block login. */
export async function fireOnLoginHook(did: string): Promise<void> {
  if (!onLoginHook) return
  try {
    await onLoginHook({ did, ensureRepo })
  } catch (err: any) {
    console.error('[oauth] onLogin hook error:', err.message)
  }
}
