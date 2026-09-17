/**
 * Sync state for permissioned spaces: which spaces this instance follows, and
 * how far each writer's repo in them has been read.
 *
 * Deliberately separate from `_repos`, which is firehose and backfill
 * bookkeeping keyed by DID alone. A writer's position is per space — the same
 * account can hold a repo in several, at different revisions — so a DID is not
 * a key here.
 */

import { querySQL, runSQL } from '../database/db.ts'

export interface SpaceWatch {
  space: string
  authority: string
  spaceType: string
  /** The account whose session last minted a credential for this space, if any. */
  readerDid: string | null
  /** Expiry of the current `registerNotify` registration, ISO 8601. */
  registeredUntil: string | null
  lastError: string | null
}

export interface SpaceRepo {
  space: string
  did: string
  /** The PDS holding this writer's repo — their own, not the authority's. */
  pds: string | null
  /** The revision this writer's repo had been read to. */
  rev: string | null
}

interface WatchRow {
  space: string
  authority: string
  space_type: string
  reader_did: string | null
  registered_until: string | null
  last_error: string | null
}

interface RepoRow {
  space: string
  did: string
  pds: string | null
  rev: string | null
}

const toWatch = (row: WatchRow): SpaceWatch => ({
  space: row.space,
  authority: row.authority,
  spaceType: row.space_type,
  readerDid: row.reader_did,
  registeredUntil: row.registered_until,
  lastError: row.last_error,
})

const WATCH_COLS = 'space, authority, space_type, reader_did, registered_until, last_error'

export async function listSpaceWatches(): Promise<SpaceWatch[]> {
  const rows = (await querySQL(`SELECT ${WATCH_COLS} FROM _space_watch ORDER BY space`)) as WatchRow[]
  return rows.map(toWatch)
}

export async function getSpaceWatch(space: string): Promise<SpaceWatch | null> {
  const rows = (await querySQL(`SELECT ${WATCH_COLS} FROM _space_watch WHERE space = $1`, [space])) as WatchRow[]
  return rows[0] ? toWatch(rows[0]) : null
}

/**
 * Start following a space, or refresh what is known about one already followed.
 *
 * Never clears `reader_did` or `registered_until`: a second call to watch an
 * existing space is a re-assertion of interest, not a reset of its progress.
 */
export async function putSpaceWatch(input: { space: string; authority: string; spaceType: string }): Promise<void> {
  const existing = await getSpaceWatch(input.space)
  if (existing) {
    await runSQL(`UPDATE _space_watch SET authority = $1, space_type = $2, updated_at = $3 WHERE space = $4`, [
      input.authority,
      input.spaceType,
      new Date().toISOString(),
      input.space,
    ])
    return
  }
  await runSQL(
    `INSERT INTO _space_watch (space, authority, space_type, reader_did, registered_until, last_error, updated_at)
     VALUES ($1, $2, $3, NULL, NULL, NULL, $4)`,
    [input.space, input.authority, input.spaceType, new Date().toISOString()],
  )
}

export async function updateSpaceWatch(
  space: string,
  patch: { readerDid?: string | null; registeredUntil?: string | null; lastError?: string | null },
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  let idx = 1
  if (patch.readerDid !== undefined) {
    sets.push(`reader_did = $${idx++}`)
    params.push(patch.readerDid)
  }
  if (patch.registeredUntil !== undefined) {
    sets.push(`registered_until = $${idx++}`)
    params.push(patch.registeredUntil)
  }
  if (patch.lastError !== undefined) {
    sets.push(`last_error = $${idx++}`)
    params.push(patch.lastError)
  }
  if (sets.length === 0) return
  sets.push(`updated_at = $${idx++}`)
  params.push(new Date().toISOString())
  params.push(space)
  await runSQL(`UPDATE _space_watch SET ${sets.join(', ')} WHERE space = $${idx}`, params)
}

export async function deleteSpaceWatch(space: string): Promise<void> {
  await runSQL(`DELETE FROM _space_watch WHERE space = $1`, [space])
  await runSQL(`DELETE FROM _space_repos WHERE space = $1`, [space])
}

export async function listSpaceRepos(space: string): Promise<SpaceRepo[]> {
  const rows = (await querySQL(`SELECT space, did, pds, rev FROM _space_repos WHERE space = $1 ORDER BY did`, [
    space,
  ])) as RepoRow[]
  return rows
}

export async function getSpaceRepo(space: string, did: string): Promise<SpaceRepo | null> {
  const rows = (await querySQL(`SELECT space, did, pds, rev FROM _space_repos WHERE space = $1 AND did = $2`, [
    space,
    did,
  ])) as RepoRow[]
  return rows[0] ?? null
}

export async function putSpaceRepo(input: SpaceRepo): Promise<void> {
  await runSQL(`INSERT OR REPLACE INTO _space_repos (space, did, pds, rev, synced_at) VALUES ($1, $2, $3, $4, $5)`, [
    input.space,
    input.did,
    input.pds,
    input.rev,
    new Date().toISOString(),
  ])
}

export async function deleteSpaceRepo(space: string, did: string): Promise<void> {
  await runSQL(`DELETE FROM _space_repos WHERE space = $1 AND did = $2`, [space, did])
}
