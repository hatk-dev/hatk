/**
 * Test data seeding helpers for populating a local PDS.
 *
 * Place a seed script at `seeds/seed.ts`. It runs during `hatk dev` to create
 * accounts and records against your local PDS. Records are validated against
 * your project's lexicons before being written.
 *
 * @example
 * ```ts
 * // seeds/seed.ts
 * import { seed } from '../hatk.generated.ts'
 *
 * const { createAccount, createRecord } = seed()
 *
 * const alice = await createAccount('alice.test')
 * const bob = await createAccount('bob.test')
 *
 * await createRecord(
 *   alice,
 *   'xyz.statusphere.status',
 *   { status: '👍', createdAt: new Date().toISOString() },
 *   { rkey: 'status1' },
 * )
 * ```
 */
import { loadLexicons } from './schema.ts'
import { validateRecord } from '@bigmoves/lexicon'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

/** Authenticated PDS session — returned by {@link seed.createAccount}. */
export type Session = { did: string; accessJwt: string; handle: string }

/** AT Protocol blob reference, as returned by `com.atproto.repo.uploadBlob`. */
export type BlobRef = { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }

/** Options for the seed helper. All fields fall back to env vars or sensible defaults. */
export type SeedOpts = { pds?: string; password?: string; lexicons?: string }

/**
 * Create a seed helper for populating a local PDS with test data.
 *
 * Returns `createAccount`, `createRecord`, and `uploadBlob` functions bound to
 * the target PDS. Records are validated against the project's lexicons before
 * being written. Generic parameter `R` maps collection NSIDs to their record types
 * for type-safe seeding.
 *
 * @typeParam R - Map of collection NSID → record type (defaults to untyped)
 * @param opts - PDS URL, password, and lexicon directory overrides
 */
export function seed<R extends Record<string, unknown> = Record<string, unknown>>(opts?: SeedOpts) {
  const pdsUrl = opts?.pds || process.env.PDS_URL || 'http://localhost:2583'
  const password = opts?.password || process.env.SEED_PASSWORD || 'password'
  const lexiconsDir = resolve(opts?.lexicons || 'lexicons')
  const lexiconArray = [...loadLexicons(lexiconsDir).values()]

  /** Create a PDS account (or reuse an existing one) and return an authenticated session. */
  async function createAccount(handle: string): Promise<Session> {
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password, email: `${handle.split('.')[0]}@test.invalid` }),
    })
    if (res.ok) {
      console.log(`[seed] created account: ${handle}`)
    } else {
      const text = await res.text()
      if (!text.includes('already') && !text.includes('taken')) {
        throw new Error(`Failed to create account ${handle}: ${text}`)
      }
      console.log(`[seed] account exists: ${handle}`)
    }

    const sessionRes = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password }),
    })
    if (!sessionRes.ok) {
      throw new Error(`Failed to create session for ${handle}: ${await sessionRes.text()}`)
    }
    const session = (await sessionRes.json()) as { did: string; accessJwt: string }
    return { ...session, handle }
  }

  /** Validate a record against its lexicon and write it to the PDS via `putRecord`. */
  async function createRecord<K extends keyof R & string>(
    session: Session,
    collection: K,
    record: R[K] extends Record<string, unknown> ? R[K] : Record<string, unknown>,
    opts: { rkey: string },
  ): Promise<{ uri: string; cid: string; commit: { cid: string; rev: string }; validationStatus: string }> {
    const error = validateRecord(lexiconArray, collection, record)
    if (error) {
      throw new Error(
        `[seed] validation error in ${collection}: ${error.path ? error.path + ': ' : ''}${error.message}`,
      )
    }

    const body: Record<string, unknown> = {
      repo: session.did,
      collection,
      rkey: opts.rkey,
      record: { $type: collection, ...record },
    }

    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessJwt}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`[seed] [${session.handle}] failed to create ${collection}: ${await res.text()}`)
    }
    const result = (await res.json()) as {
      uri: string
      cid: string
      commit: { cid: string; rev: string }
      validationStatus: string
    }
    console.log(`[seed] [${session.handle}] ${collection} → ${result.uri}`)
    return result
  }

  /** Upload a file to the PDS as a blob. MIME type is inferred from the file extension. */
  async function uploadBlob(session: Session, filePath: string): Promise<BlobRef> {
    const data = readFileSync(resolve(filePath))
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
    }
    const mimeType = mimeTypes[ext] || 'application/octet-stream'

    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType, Authorization: `Bearer ${session.accessJwt}` },
      body: data,
    })
    if (!res.ok) {
      throw new Error(`[seed] failed to upload blob ${filePath}: ${await res.text()}`)
    }
    const { blob } = (await res.json()) as { blob: BlobRef }
    console.log(`[seed] [${session.handle}] uploaded ${filePath} (${data.length} bytes)`)
    return blob
  }

  return { createAccount, createRecord, uploadBlob }
}
