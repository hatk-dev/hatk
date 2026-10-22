/**
 * A writer's repo in a space, served the way a reference repo host serves it.
 *
 * The sync engine refuses anything it cannot verify, so a test host has to do
 * the real thing: answer getRepo with a STAR archive, listRepoOps and getRecord
 * with real CIDs, and every one of them with the MAC a host derives from the
 * request's key share and the writer's `#atproto_kem` key. The provider side is
 * `@atproto/space`'s own, so what the engine is tested against is what it will
 * meet.
 */
import { P256Keypair } from '@atproto/crypto'
import { type Cid } from '@atproto/lex-data'
import { lexToJson } from '@atproto/lex-json'
import {
  COMMIT_MAC_TYPE,
  type Commit,
  MAC_HEADER,
  RECORD_MAC_TYPE,
  RepoCommit,
  WANT_MAC_HEADER,
  computeCommitMac,
  computeRecordMac,
  decapsulate,
  formatMacHeader,
  parseWantMacHeader,
  serializeRecord,
  serializeRepo,
} from '@atproto/space'

export interface Op {
  rev: string
  collection: string
  rkey: string
  cid: string | null
  prev: string | null
  value?: Record<string, unknown>
}

interface Held {
  collection: string
  rkey: string
  value: Record<string, unknown>
  cid: Cid
  bytes: Uint8Array
}

let revCounter = 0

/** A rev that sorts after every one made before it. */
export function nextRev(): string {
  revCounter++
  return `3l${String(revCounter).padStart(11, '0')}`
}

export class FakeWriter {
  readonly records = new Map<string, Held>()
  readonly log: Op[] = []
  rev: string | null = null

  private constructor(
    readonly did: string,
    readonly space: string,
    readonly kem: P256Keypair,
  ) {}

  static async create(did: string, space: string): Promise<FakeWriter> {
    return new FakeWriter(did, space, await P256Keypair.create())
  }

  /** The `#atproto_kem` key a DID document would publish for this writer. */
  kemDid(): string {
    return this.kem.did()
  }

  /** Create or update a record, returning the op it logs (value inlined). */
  async put(collection: string, rkey: string, value: Record<string, unknown>): Promise<Op> {
    const record = { $type: collection, ...value }
    const { cid, bytes } = await serializeRecord(collection as any, rkey as any, record as any)
    const path = `${collection}/${rkey}`
    const prev = this.records.get(path)?.cid ?? null
    this.records.set(path, { collection, rkey, value: record, cid, bytes })
    this.rev = nextRev()
    const op: Op = {
      rev: this.rev,
      collection,
      rkey,
      cid: cid.toString(),
      prev: prev?.toString() ?? null,
      value: record,
    }
    this.log.push(op)
    return op
  }

  async del(collection: string, rkey: string): Promise<Op> {
    const path = `${collection}/${rkey}`
    const prev = this.records.get(path)!.cid
    this.records.delete(path)
    this.rev = nextRev()
    const op: Op = { rev: this.rev, collection, rkey, cid: null, prev: prev.toString() }
    this.log.push(op)
    return op
  }

  commit(): Commit {
    const repo = RepoCommit.fromRecords([...this.records.values()] as any)
    return repo.toCommit({ space: this.space as any, repo: this.did as any, rev: this.rev! })
  }

  private secret(headers: Headers, type: typeof COMMIT_MAC_TYPE | typeof RECORD_MAC_TYPE): Uint8Array {
    return decapsulate(this.kem, parseWantMacHeader(headers.get(WANT_MAC_HEADER) ?? undefined, type))
  }

  private commitHeaders(headers: Headers, commit: Commit): Record<string, string> {
    const mac = computeCommitMac(this.secret(headers, COMMIT_MAC_TYPE), commit)
    return { [MAC_HEADER]: formatMacHeader(COMMIT_MAC_TYPE, mac) }
  }

  /** `getRepo`: the archive, MACed for this request. */
  async getRepo(headers: Headers, commit = this.commit()): Promise<Response> {
    const held = [...this.records.values()].sort((a, b) =>
      `${a.collection}/${a.rkey}` < `${b.collection}/${b.rkey}` ? -1 : 1,
    )
    const chunks: Uint8Array[] = []
    for await (const chunk of serializeRepo(
      commit,
      held.map((h) => ({ collection: h.collection as any, rkey: h.rkey as any, bytes: h.bytes })),
    )) {
      chunks.push(chunk)
    }
    return new Response(Buffer.concat(chunks), {
      headers: { 'content-type': 'application/octet-stream', ...this.commitHeaders(headers, commit) },
    })
  }

  /**
   * `listRepoOps`: `ops` as given (the log after `since` by default), with the
   * head commit and its MAC unless `cursor` says there is more.
   */
  listRepoOps(
    headers: Headers,
    params: URLSearchParams,
    page: { ops?: Op[]; cursor?: string; commit?: Commit } = {},
  ): Response {
    const since = params.get('since')
    const ops = page.ops ?? this.log.filter((op) => !since || op.rev > since)
    if (page.cursor) return Response.json({ ops, cursor: page.cursor })
    const commit = page.commit ?? this.commit()
    return Response.json({ ops, commit: lexToJson(commit as any) }, { headers: this.commitHeaders(headers, commit) })
  }

  /** `getRecord`, MACed for this request. */
  getRecord(headers: Headers, params: URLSearchParams): Response {
    const held = this.records.get(`${params.get('collection')}/${params.get('rkey')}`)
    if (!held) return Response.json({ error: 'RecordNotFound' }, { status: 400 })
    const uri = `${this.space}/${this.did}/${held.collection}/${held.rkey}`
    const mac = computeRecordMac(this.secret(headers, RECORD_MAC_TYPE), uri, held.cid)
    return Response.json(
      { uri, cid: held.cid.toString(), value: held.value },
      { headers: { [MAC_HEADER]: formatMacHeader(RECORD_MAC_TYPE, mac) } },
    )
  }
}
