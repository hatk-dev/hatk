import { expect, test } from 'vitest'
import { walkMst } from '../src/mst.ts'
import { CidLink, cborEncode, cidFor } from './firehose-frame.ts'

// Backfill reads every record in a repo by walking its MST, so the walk has to
// reconstruct prefix-compressed keys exactly and emit them in key order — a
// wrong prefix length would file a record under the wrong collection.

interface Entry {
  p: number
  k: Uint8Array | string
  v: CidLink | null
  t: CidLink | null
}

class Blocks {
  map = new Map<string, Uint8Array>()
  put(value: any): CidLink {
    const bytes = cborEncode(value)
    const cid = cidFor(bytes)
    this.map.set(cid.toString(), bytes)
    return cid
  }
  get(cid: string): Uint8Array | undefined {
    return this.map.get(cid)
  }
}

const enc = new TextEncoder()

function entry(p: number, k: string, v: CidLink | null, t: CidLink | null = null): Entry {
  return { p, k: enc.encode(k), v, t }
}

function record(blocks: Blocks, name: string): CidLink {
  return blocks.put({ name })
}

test('a single node with no prefix compression yields its entries in order', () => {
  const blocks = new Blocks()
  const a = record(blocks, 'a')
  const b = record(blocks, 'b')
  const root = blocks.put({
    l: null,
    e: [entry(0, 'app.bsky.feed.post/aaa', a), entry(0, 'app.bsky.feed.post/bbb', b)],
  })

  expect(Array.from(walkMst(blocks, root.toString()))).toEqual([
    { path: 'app.bsky.feed.post/aaa', cid: a.toString() },
    { path: 'app.bsky.feed.post/bbb', cid: b.toString() },
  ])
})

test('keys are rebuilt from the previous key prefix plus the suffix', () => {
  const blocks = new Blocks()
  const a = record(blocks, 'a')
  const b = record(blocks, 'b')
  const c = record(blocks, 'c')
  // Real nodes share the collection prefix: the second entry stores only the
  // rkey tail and p = length of the shared prefix with the previous key.
  const root = blocks.put({
    l: null,
    e: [
      entry(0, 'app.bsky.feed.post/3k2a', a),
      entry(19, '3k2b', b), // 'app.bsky.feed.post/'.length === 19
      entry(9, 'graph.follow/3k2c', c), // shares only 'app.bsky.'
    ],
  })

  expect(Array.from(walkMst(blocks, root.toString())).map((e) => e.path)).toEqual([
    'app.bsky.feed.post/3k2a',
    'app.bsky.feed.post/3k2b',
    'app.bsky.graph.follow/3k2c',
  ])
})

test('left and right subtrees are visited around their parent entries in key order', () => {
  const blocks = new Blocks()
  const first = record(blocks, 'first')
  const mid = record(blocks, 'mid')
  const between = record(blocks, 'between')
  const last = record(blocks, 'last')

  const left = blocks.put({ l: null, e: [entry(0, 'a/1', first)] })
  // A right subtree hangs off an entry and inherits that entry's key as its prefix
  const right = blocks.put({ l: null, e: [entry(2, '2', between)] })
  const root = blocks.put({
    l: left,
    e: [entry(0, 'b/1', mid, right), entry(0, 'c/1', last)],
  })

  expect(Array.from(walkMst(blocks, root.toString())).map((e) => e.path)).toEqual(['a/1', 'b/1', 'b/2', 'c/1'])
})

test('entries with no value CID are used for key context but not yielded', () => {
  const blocks = new Blocks()
  const v = record(blocks, 'v')
  const root = blocks.put({
    l: null,
    e: [entry(0, 'coll/aaa', null), entry(5, 'bbb', v)],
  })
  expect(Array.from(walkMst(blocks, root.toString()))).toEqual([{ path: 'coll/bbb', cid: v.toString() }])
})

test('a node whose block is missing is skipped rather than throwing', () => {
  // Partial CARs (a commit diff) reference subtrees that are not included; the
  // walk must yield what it can and leave the rest to the caller.
  const blocks = new Blocks()
  const v = record(blocks, 'v')
  const missing = cidFor(cborEncode({ not: 'stored' }))
  const root = blocks.put({ l: missing, e: [entry(0, 'x/1', v, missing)] })

  expect(Array.from(walkMst(blocks, root.toString()))).toEqual([{ path: 'x/1', cid: v.toString() }])
  expect(Array.from(walkMst(blocks, missing.toString()))).toEqual([])
})

test('a key already decoded as a string is accepted alongside byte keys', () => {
  const blocks = new Blocks()
  const v = record(blocks, 'v')
  const root = blocks.put({ l: null, e: [{ p: 0, k: 'coll/str', v, t: null }] })
  expect(Array.from(walkMst(blocks, root.toString()))).toEqual([{ path: 'coll/str', cid: v.toString() }])
})

test('a node with no entry list yields nothing', () => {
  const blocks = new Blocks()
  const root = blocks.put({ l: null })
  expect(Array.from(walkMst(blocks, root.toString()))).toEqual([])
})
