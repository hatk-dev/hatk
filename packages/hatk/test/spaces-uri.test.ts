import { expect, test } from 'vitest'
import {
  collectionFromRecordUri,
  isSpaceUri,
  parseSpaceRecordUri,
  parseSpaceRef,
  spaceFromUri,
  spaceHostAud,
  spaceRecordUri,
  spaceRefUri,
} from '../src/spaces/uri.ts'
import { collectionFromUri } from '../src/private-collections.ts'

const AUTHORITY = 'did:plc:authority'
const SPACE = `at://${AUTHORITY}/space/test.hatk.board/self`
const WRITER = 'did:plc:writer'
const RECORD = `${SPACE}/${WRITER}/app.bsky.actor.profile/3kx`

test('parses a space ref', () => {
  expect(parseSpaceRef(SPACE)).toEqual({
    authority: AUTHORITY,
    type: 'test.hatk.board',
    skey: 'self',
  })
})

test('a record inside a space is not itself a space ref', () => {
  expect(parseSpaceRef(RECORD)).toBeNull()
})

test('rejects a space ref whose authority is a handle', () => {
  // Membership is keyed on DIDs, so a handle could never be matched against a
  // member list — an authority that is not a DID is not a space.
  expect(parseSpaceRef('at://alice.test/space/test.hatk.board/self')).toBeNull()
})

test('rejects refs with the wrong marker or arity', () => {
  expect(parseSpaceRef(`at://${AUTHORITY}/spaces/test.hatk.board/self`)).toBeNull()
  expect(parseSpaceRef(`at://${AUTHORITY}/space/test.hatk.board`)).toBeNull()
  expect(parseSpaceRef('not-a-uri')).toBeNull()
})

test('round-trips a space ref through its parts', () => {
  expect(spaceRefUri(parseSpaceRef(SPACE)!)).toBe(SPACE)
})

test('parses a record uri inside a space', () => {
  expect(parseSpaceRecordUri(RECORD)).toEqual({
    authority: AUTHORITY,
    type: 'test.hatk.board',
    skey: 'self',
    space: SPACE,
    writer: WRITER,
    collection: 'app.bsky.actor.profile',
    rkey: '3kx',
  })
})

test('builds the record uri the space itself would give back', () => {
  expect(spaceRecordUri(SPACE, WRITER, 'app.bsky.actor.profile', '3kx')).toBe(RECORD)
})

test('a repo record uri names no space', () => {
  expect(spaceFromUri(`at://${WRITER}/app.bsky.actor.profile/self`)).toBeUndefined()
  expect(parseSpaceRecordUri(`at://${WRITER}/app.bsky.actor.profile/self`)).toBeNull()
})

test('a space record uri names the space it is in', () => {
  expect(spaceFromUri(RECORD)).toBe(SPACE)
})

test('isSpaceUri covers the space and anything inside it', () => {
  expect(isSpaceUri(SPACE)).toBe(true)
  expect(isSpaceUri(RECORD)).toBe(true)
  expect(isSpaceUri(`at://${WRITER}/app.bsky.actor.profile/self`)).toBe(false)
  expect(isSpaceUri('not-a-uri')).toBe(false)
})

test('reads the collection out of either uri shape', () => {
  expect(collectionFromRecordUri(`at://${WRITER}/app.bsky.actor.profile/self`)).toBe('app.bsky.actor.profile')
  expect(collectionFromRecordUri(RECORD)).toBe('app.bsky.actor.profile')
})

test('collectionFromUri no longer reports a space record as collection "space"', () => {
  // The regression this exists for: reading segment 3 positionally returns the
  // literal marker, so every space record looked like it belonged to a
  // collection named 'space' and no collection guard could match it.
  expect(collectionFromUri(RECORD)).toBe('app.bsky.actor.profile')
  expect(collectionFromUri(RECORD)).not.toBe('space')
})

test('collection is undefined for uris with nothing in that position', () => {
  expect(collectionFromRecordUri('at://did:plc:abc')).toBeUndefined()
  expect(collectionFromRecordUri('not-a-uri')).toBeUndefined()
})

test('a record uri missing its rkey is not a space record', () => {
  expect(parseSpaceRecordUri(`${SPACE}/${WRITER}/app.bsky.actor.profile`)).toBeNull()
})

test('the delegation audience names the space host entry, not the endpoint', () => {
  expect(spaceHostAud(AUTHORITY)).toBe(`${AUTHORITY}#atproto_space_host`)
})
