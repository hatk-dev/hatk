import { cborDecode } from './cbor.ts'

export interface MstEntry {
  path: string // e.g. "xyz.marketplace.listing/3mfniulnr7c2g"
  cid: string // CID of the record block
}

export function* walkMst(blocks: { get(cid: string): Uint8Array | undefined }, rootCid: string): Generator<MstEntry> {
  function* visit(cid: string, prefix: string): Generator<MstEntry, string> {
    const data = blocks.get(cid)
    if (!data) return prefix
    const { value: node } = cborDecode(data)

    // Visit left subtree
    if (node.l?.$link) yield* visit(node.l.$link, prefix)

    let lastKey = prefix
    for (const entry of node.e || []) {
      const keySuffix = entry.k instanceof Uint8Array ? new TextDecoder().decode(entry.k) : entry.k
      const prefixLen = entry.p || 0
      const fullKey = lastKey.substring(0, prefixLen) + keySuffix
      lastKey = fullKey

      if (entry.v?.$link) {
        yield { path: fullKey, cid: entry.v.$link }
      }

      // Visit right subtree
      if (entry.t?.$link) {
        yield* visit(entry.t.$link, lastKey)
      }
    }

    return lastKey
  }

  yield* visit(rootCid, '')
}
