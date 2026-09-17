import { expect, test } from 'vitest'
import { parseCarFrame, parseCarStream } from '../src/car.ts'
import { cidToString } from '../src/cid.ts'
import { CidLink, buildCar, cborEncode, cidFor } from './firehose-frame.ts'

// Two parsers read the same CARv1 layout: `parseCarFrame` over an in-memory
// commit frame, and `parseCarStream` over a streamed `getRepo` body that may be
// tens of MB. They must agree on roots and blocks, and the streaming one must
// cope with chunk boundaries landing anywhere — inside a varint, inside a CID,
// or inside block data.

function block(value: any): { cid: CidLink; bytes: Uint8Array } {
  const bytes = cborEncode(value)
  return { cid: cidFor(bytes), bytes }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function varint(n: number): Uint8Array {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return new Uint8Array(out)
}

/** Split bytes into a ReadableStream of fixed-size chunks. */
function streamOf(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let pos = 0
  return new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(pos, pos + chunkSize))
      pos += chunkSize
    },
  })
}

function sampleCar() {
  const a = block({ text: 'first' })
  const b = block({ text: 'second', n: 2 })
  const root = block({ did: 'did:plc:x', rev: 'r', version: 3 })
  return { car: buildCar(root.cid, [a, b, root]), a, b, root }
}

// --- parseCarFrame ---

test('parseCarFrame returns the header roots and indexes every block by CID', () => {
  const { car, a, b, root } = sampleCar()
  const parsed = parseCarFrame(car)

  expect(parsed.roots).toEqual([root.cid.toString()])
  expect(parsed.blocks.size).toBe(3)
  expect(parsed.blocks.get(a.cid.toString())).toEqual(a.bytes)
  expect(parsed.blocks.get(b.cid.toString())).toEqual(b.bytes)
  expect(parsed.blocks.get(root.cid.toString())).toEqual(root.bytes)
})

test('parseCarFrame block data is a view over the CAR buffer rather than a copy', () => {
  // The lazy map exists so a 90MB CAR is not duplicated on the heap
  const { car, a } = sampleCar()
  const data = parseCarFrame(car).blocks.get(a.cid.toString())!
  expect(data.buffer).toBe(car.buffer)
})

test('parseCarFrame accepts header roots encoded as raw CID bytes', () => {
  // Some writers emit roots as a plain byte string instead of a tag-42 link
  const a = block({ x: 1 })
  const header = cborEncode({ version: 1, roots: [a.cid.bytes] })
  const body = concat([a.cid.bytes, a.bytes])
  const car = concat([varint(header.length), header, varint(body.length), body])

  expect(parseCarFrame(car).roots).toEqual([a.cid.toString()])
})

test('parseCarFrame tolerates a header with no roots', () => {
  const header = cborEncode({ version: 1 })
  const car = concat([varint(header.length), header])
  const parsed = parseCarFrame(car)
  expect(parsed.roots).toEqual([])
  expect(parsed.blocks.size).toBe(0)
})

test('parseCarFrame reads a CIDv0 block key', () => {
  // CIDv0 is a bare sha256 multihash: 0x12 0x20 + 32 digest bytes, no version/codec
  const digest = new Uint8Array(32).fill(0xab)
  const cidv0 = concat([new Uint8Array([0x12, 0x20]), digest])
  const data = cborEncode({ legacy: true })
  const header = cborEncode({ version: 1, roots: [] })
  const body = concat([cidv0, data])
  const car = concat([varint(header.length), header, varint(body.length), body])

  const parsed = parseCarFrame(car)
  expect(parsed.blocks.size).toBe(1)
  const [[cid, bytes]] = Array.from(parsed.blocks)
  expect(cid).toBe(cidToString(cidv0))
  expect(bytes).toEqual(data)
})

test('parseCarFrame rejects a CID version it cannot lay out', () => {
  const header = cborEncode({ version: 1, roots: [] })
  const badCid = new Uint8Array([0x02, 0x71, 0x12, 0x01, 0x00])
  const body = concat([badCid, cborEncode(1)])
  const car = concat([varint(header.length), header, varint(body.length), body])
  expect(() => parseCarFrame(car)).toThrow('Unsupported CID version: 2')
})

test('parseCarFrame stops at a zero-length block sentinel', () => {
  const { car, a } = sampleCar()
  const withSentinel = concat([car, varint(0), new Uint8Array([0xde, 0xad])])
  const parsed = parseCarFrame(withSentinel)
  expect(parsed.blocks.size).toBe(3)
  expect(parsed.blocks.get(a.cid.toString())).toEqual(a.bytes)
})

// --- LazyBlockMap ---

test('LazyBlockMap iterates blocks as [cid, bytes] pairs', () => {
  const { car, a, b, root } = sampleCar()
  const entries = Array.from(parseCarFrame(car).blocks)
  expect(entries.map(([cid]) => cid).sort()).toEqual([a.cid.toString(), b.cid.toString(), root.cid.toString()].sort())
  for (const [, bytes] of entries) expect(bytes).toBeInstanceOf(Uint8Array)
})

test('LazyBlockMap delete removes the index entry and shrinks size', () => {
  const { car, a } = sampleCar()
  const { blocks } = parseCarFrame(car)
  expect(blocks.delete(a.cid.toString())).toBe(true)
  expect(blocks.delete(a.cid.toString())).toBe(false)
  expect(blocks.size).toBe(2)
  expect(blocks.get(a.cid.toString())).toBeUndefined()
})

test('LazyBlockMap get returns undefined for a CID that is not in the CAR', () => {
  const { car } = sampleCar()
  expect(parseCarFrame(car).blocks.get('bafyreinotthere')).toBeUndefined()
})

test('LazyBlockMap free drops the buffer so nothing can be read afterwards', () => {
  const { car, a } = sampleCar()
  const { blocks } = parseCarFrame(car)
  blocks.free()
  expect(blocks.size).toBe(0)
  expect(blocks.get(a.cid.toString())).toBeUndefined()
  expect(Array.from(blocks)).toEqual([])
})

// --- parseCarStream ---

test('parseCarStream yields the same roots and blocks as parseCarFrame', async () => {
  const { car, a, b, root } = sampleCar()
  const streamed = await parseCarStream(streamOf(car, 4096))

  expect(streamed.roots).toEqual([root.cid.toString()])
  expect(streamed.byteLength).toBe(car.length)
  expect(streamed.blocks.size).toBe(3)
  expect(streamed.blocks.get(a.cid.toString())).toEqual(a.bytes)
  expect(streamed.blocks.get(b.cid.toString())).toEqual(b.bytes)
})

test('parseCarStream produces the same result whichever byte the chunks split on', async () => {
  const { car } = sampleCar()
  const reference = await parseCarStream(streamOf(car, car.length))
  for (const chunk of [1, 2, 3, 7, 13, 33]) {
    const parsed = await parseCarStream(streamOf(car, chunk))
    expect(parsed.roots).toEqual(reference.roots)
    expect(Array.from(parsed.blocks.keys()).sort()).toEqual(Array.from(reference.blocks.keys()).sort())
    for (const [cid, bytes] of reference.blocks) expect(parsed.blocks.get(cid)).toEqual(bytes)
  }
})

test('parseCarStream copies block data out of its working buffer', async () => {
  // Each block must own its bytes so the reusable read buffer can be reclaimed
  const { car, a } = sampleCar()
  const { blocks } = await parseCarStream(streamOf(car, 8))
  const data = blocks.get(a.cid.toString())!
  expect(data.byteLength).toBe(a.bytes.length)
  expect(data.buffer.byteLength).toBe(a.bytes.length)
})

test('parseCarStream grows its buffer for a block larger than the initial allocation', async () => {
  const big = block({ payload: 'z'.repeat(200 * 1024) })
  const car = buildCar(big.cid, [big])
  const { blocks, byteLength } = await parseCarStream(streamOf(car, 16 * 1024))
  expect(byteLength).toBe(car.length)
  expect(blocks.get(big.cid.toString())).toEqual(big.bytes)
})

test('parseCarStream compacts across many blocks without losing any', async () => {
  // Enough 1KB blocks to push the read cursor past the buffer midpoint several
  // times, so the shift-to-front path runs with data straddling the boundary.
  const blocks = Array.from({ length: 200 }, (_, i) => block({ i, pad: 'p'.repeat(1000) }))
  const car = buildCar(blocks[0].cid, blocks)
  const parsed = await parseCarStream(streamOf(car, 1500))
  expect(parsed.blocks.size).toBe(200)
  for (const b of blocks) expect(parsed.blocks.get(b.cid.toString())).toEqual(b.bytes)
})

test('parseCarStream stops at a zero-length block sentinel', async () => {
  const { car, a } = sampleCar()
  const withSentinel = concat([car, varint(0), cborEncode('junk')])
  const parsed = await parseCarStream(streamOf(withSentinel, 64))
  expect(parsed.blocks.size).toBe(3)
  expect(parsed.blocks.get(a.cid.toString())).toEqual(a.bytes)
})

test('parseCarStream rejects an empty stream', async () => {
  await expect(parseCarStream(streamOf(new Uint8Array(0), 16))).rejects.toThrow('Empty CAR stream')
})

test('parseCarStream rejects a stream cut off inside the header', async () => {
  const { car } = sampleCar()
  const [headerLen] = [car[0]]
  const truncated = car.slice(0, 1 + Math.floor(headerLen / 2))
  await expect(parseCarStream(streamOf(truncated, 4))).rejects.toThrow('Truncated CAR header')
})

test('parseCarStream rejects a stream cut off inside a block', async () => {
  // A download that dies mid-repo must surface as an error, not a partial repo
  // that backfill would record as complete.
  const { car } = sampleCar()
  const truncated = car.slice(0, car.length - 5)
  await expect(parseCarStream(streamOf(truncated, 4))).rejects.toThrow('Truncated CAR block')
})

test('parseCarStream rejects a runaway length varint instead of allocating for it', async () => {
  // Six continuation bytes exceed the 35-bit ceiling; a corrupt stream must
  // fail here rather than be trusted as a multi-gigabyte block length.
  const runaway = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0x00])
  await expect(parseCarStream(streamOf(runaway, 3))).rejects.toThrow('Varint too long')
})

test('parseCarStream rejects a stream that ends in the middle of a length varint', async () => {
  // A single continuation byte after the last block promises more bytes that never arrive
  const { car } = sampleCar()
  const cutMidVarint = concat([car, new Uint8Array([0x80])])
  await expect(parseCarStream(streamOf(cutMidVarint, 5))).rejects.toThrow('Unexpected end of varint')
})
