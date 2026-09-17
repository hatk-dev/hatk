/**
 * Permissioned-space indexing, as a whole.
 *
 * Off unless `spaces` is configured. With it off nothing in here runs, no
 * space row can be written, and the read gate serves none — which is the state
 * every deployment that predates this is in.
 */

import type { OAuthConfig, SpacesConfig } from '../config.ts'
import { emit } from '../logger.ts'
import { log } from '../logger.ts'
import { configureSpaceEngine, reconcileAll, unwatchSpace, watchSpace } from './engine.ts'
import { configureSpaceIdentity } from './identity.ts'

export {
  collectionsForSpaceType,
  reconcileAll,
  reconcileSpace,
  syncSpaceRepo,
  unwatchSpace,
  watchSpace,
} from './engine.ts'
export { getSpaceCredential, mintSpaceCredential, isNotAuthorized, isSpaceGone } from './credential.ts'
export { listSpaceRepos, listSpaceWatches, type SpaceWatch } from './store.ts'
export { isSpaceReadable, readableSpaces, withReadableSpaces } from './visibility.ts'
export * from './uri.ts'

let sweepTimer: ReturnType<typeof setInterval> | null = null

export interface StartSpacesOptions {
  spaces: SpacesConfig
  oauth: OAuthConfig | null
  plc: string
  /** Every collection hatk has a table for. */
  collections: Set<string>
}

/**
 * Configure the engine and start the reconcile sweep.
 *
 * Returns without starting anything if the instance has no OAuth: reading a
 * space begins with a delegation token from a member's own PDS, so an instance
 * that holds no sessions has no way to obtain one and would sweep forever
 * finding nothing.
 */
export function startSpaces(opts: StartSpacesOptions): void {
  const { spaces, oauth, plc, collections } = opts
  if (!oauth) {
    log("[spaces] configured but OAuth is not — a space is read with a member's delegation, so nothing to do")
    return
  }
  if (spaces.types.length === 0) {
    log('[spaces] configured with no space types — nothing to index')
    return
  }

  configureSpaceIdentity(plc)
  configureSpaceEngine({ oauth, types: new Set(spaces.types), collections })

  const intervalMs = Math.max(30, spaces.reconcileInterval ?? 300) * 1000

  const sweep = async (): Promise<void> => {
    for (const space of spaces.watch ?? []) {
      try {
        await watchSpace(space)
      } catch (err) {
        emit('spaces', 'watch_failed', {
          space,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    await reconcileAll()
  }

  // Deferred rather than run inline: the server is already listening by the
  // time this is called, and a first sweep that has to reach several hosts
  // should not sit in front of the first request.
  setTimeout(() => void sweep().catch(() => {}), 1000).unref()

  sweepTimer = setInterval(() => void sweep().catch(() => {}), intervalMs)
  sweepTimer.unref()

  log(`[spaces] indexing ${spaces.types.join(', ')} — reconciling every ${intervalMs / 1000}s`)
}

export function stopSpaces(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}

/** Re-exported so an app's on-login hook can start following a space it just learned about. */
export { watchSpace as followSpace, unwatchSpace as unfollowSpace }
