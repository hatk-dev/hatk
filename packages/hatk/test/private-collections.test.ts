import { beforeEach, expect, test } from 'vitest'
import { collectionFromUri, isPrivateCollection, setPrivateCollections } from '../src/private-collections.ts'

beforeEach(() => {
  setPrivateCollections([])
})

test('no collections are private by default', () => {
  expect(isPrivateCollection('social.switchback.activity')).toBe(false)
})

test('listed collections are private', () => {
  setPrivateCollections(['social.switchback.activity'])
  expect(isPrivateCollection('social.switchback.activity')).toBe(true)
  expect(isPrivateCollection('app.bsky.actor.profile')).toBe(false)
})

test('setPrivateCollections replaces rather than accumulates', () => {
  setPrivateCollections(['a.b.c'])
  setPrivateCollections(['d.e.f'])
  expect(isPrivateCollection('a.b.c')).toBe(false)
  expect(isPrivateCollection('d.e.f')).toBe(true)
})

test('a missing collection is not private', () => {
  setPrivateCollections(['a.b.c'])
  expect(isPrivateCollection(null)).toBe(false)
  expect(isPrivateCollection(undefined)).toBe(false)
})

test('collectionFromUri extracts the collection segment', () => {
  expect(collectionFromUri('at://did:plc:abc/social.switchback.activity/3kx')).toBe('social.switchback.activity')
})

test('collectionFromUri returns undefined for a malformed uri', () => {
  expect(collectionFromUri('not-a-uri')).toBeUndefined()
  expect(collectionFromUri('at://did:plc:abc')).toBeUndefined()
  expect(collectionFromUri('at://did:plc:abc/social.switchback.activity')).toBeUndefined()
})

test('backfill never purges private collections', async () => {
  const { purgeableCollections } = await import('../src/backfill.ts')
  setPrivateCollections(['social.switchback.activity'])
  const cols = new Set(['social.switchback.activity', 'social.switchback.actor.profile'])
  expect(purgeableCollections(cols)).toEqual(['social.switchback.actor.profile'])
})
