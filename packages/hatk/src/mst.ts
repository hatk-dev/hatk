import { cborDecode } from './cbor.ts'

/** A single entry from a Merkle Search Tree — a record path paired with its content CID. */
export interface MstEntry {
  /** Record path, e.g. "xyz.marketplace.listing/3mfniulnr7c2g" */
  path: string
  /** CID of the record's CBOR block */
  cid: string
}

/**
 * Walk an AT Protocol Merkle Search Tree (MST) in key order, yielding every record entry.
 *
 * The MST is a prefix-compressed B+ tree used by AT Protocol repositories to map
 * record paths to CIDs. Each node contains a left subtree pointer, an array of entries
 * (each with a prefix length, key suffix, value CID, and right subtree pointer), and
 * keys are reconstructed by combining the prefix of the previous key with the suffix.
 *
 * @param blocks - Block store that resolves CIDs to raw CBOR bytes
 * @param rootCid - CID of the MST root node
 * @yields {MstEntry} Record entries in lexicographic key order
 */
export function* walkMst(blocks: { get(cid: string): Uint8Array | undefined }, rootCid: string): Generator<MstEntry> {
  /** Recursively visit an MST node, reconstructing full keys from prefix-compressed entries. */
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
