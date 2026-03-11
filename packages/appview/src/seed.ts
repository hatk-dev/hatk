import { loadLexicons } from './schema.ts'
import { validateRecord } from '@bigmoves/lexicon'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

export type Session = { did: string; accessJwt: string; handle: string }
export type BlobRef = { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }
export type SeedOpts = { pds?: string; password?: string; lexicons?: string }

export function seed<R extends Record<string, unknown> = Record<string, unknown>>(opts?: SeedOpts) {
  const pdsUrl = opts?.pds || process.env.PDS_URL || 'http://localhost:2583'
  const password = opts?.password || process.env.SEED_PASSWORD || 'password'
  const lexiconsDir = resolve(opts?.lexicons || 'lexicons')
  const lexiconArray = [...loadLexicons(lexiconsDir).values()]

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

  async function createRecord<K extends keyof R & string>(
    session: Session,
    collection: K,
    record: R[K] extends Record<string, unknown> ? R[K] : Record<string, unknown>,
    opts: { rkey: string },
  ): Promise<{ uri: string; cid: string }> {
    const error = validateRecord(lexiconArray, collection, record)
    if (error) {
      throw new Error(`[seed] validation error in ${collection}: ${error.path ? error.path + ': ' : ''}${error.message}`)
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
    const { uri, cid } = (await res.json()) as { uri: string; cid: string }
    console.log(`[seed] [${session.handle}] ${collection} → ${uri}`)
    return { uri, cid }
  }

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
