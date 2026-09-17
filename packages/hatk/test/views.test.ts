import { beforeAll, expect, test } from 'vitest'
import { storeLexicons } from '../src/database/schema.ts'
import { discoverViews, getDefaultView, getViewDef } from '../src/views.ts'

// A view def is discovered purely from lexicon shape, and feeds pick the
// default view for a collection by name. Two conventions are in play — an
// inline view that embeds the record under a `#main` ref, and a bsky-style
// defs file whose `profileView` is matched to the `profile` record by name —
// and both have to produce hydration instructions a renderer can follow.

const NS = 'xyz.viewtest'

const lexicons = new Map<string, any>([
  [
    `${NS}.play`,
    {
      lexicon: 1,
      id: `${NS}.play`,
      defs: {
        main: {
          type: 'record',
          key: 'tid',
          record: {
            type: 'object',
            properties: { title: { type: 'string' }, thumbnail: { type: 'blob' }, artwork: { type: 'blob' } },
          },
        },
        // Listed before playView on purpose: a *Basic variant must never be
        // chosen as the default just because it was seen first.
        playViewBasic: {
          type: 'object',
          properties: { play: { type: 'ref', ref: '#main' }, title: { type: 'string' } },
        },
        playView: {
          type: 'object',
          properties: {
            play: { type: 'ref', ref: '#main' },
            author: { type: 'ref', ref: `${NS}.profile` },
            related: { type: 'ref', ref: `${NS}.play#playViewBasic` },
            labels: { type: 'array', items: { type: 'ref', ref: 'com.atproto.label.defs#label' } },
            playCount: { type: 'integer' },
            indexedAt: { type: 'string', format: 'datetime' },
          },
        },
        // No `View` in the name: ignored even though it is an object.
        stats: { type: 'object', properties: { count: { type: 'integer' } } },
      },
    },
  ],
  [
    `${NS}.profile`,
    {
      lexicon: 1,
      id: `${NS}.profile`,
      defs: {
        main: {
          type: 'record',
          key: 'literal:self',
          record: {
            type: 'object',
            properties: {
              displayName: { type: 'string' },
              avatar: { type: 'blob' },
              banner: { type: 'blob' },
              thumbnail: { type: 'blob' },
            },
          },
        },
      },
    },
  ],
  [
    `${NS}.defs`,
    {
      lexicon: 1,
      id: `${NS}.defs`,
      defs: {
        profileView: {
          type: 'object',
          properties: {
            did: { type: 'string', format: 'did' },
            handle: { type: 'string', format: 'handle' },
            indexedAt: { type: 'string', format: 'datetime' },
            displayName: { type: 'string' },
            avatar: { type: 'string', format: 'uri' },
            followerCount: { type: 'integer' },
            viewer: { type: 'ref', ref: '#viewerState' },
            labels: { type: 'array', items: { type: 'ref', ref: 'com.atproto.label.defs#label' } },
          },
        },
        profileViewDetailed: {
          type: 'object',
          properties: { did: { type: 'string' }, bio: { type: 'string' } },
        },
        viewerState: { type: 'object', properties: { muted: { type: 'boolean' } } },
        // No record lexicon named `${NS}.widget` exists, so this cannot be attached.
        widgetView: { type: 'object', properties: { id: { type: 'string' } } },
        // `${NS}.search` exists but is a query, not a record.
        searchView: { type: 'object', properties: { id: { type: 'string' } } },
        // A view with no properties has nothing to hydrate.
        emptyView: { type: 'object' },
      },
    },
  ],
  [`${NS}.search`, { lexicon: 1, id: `${NS}.search`, defs: { main: { type: 'query' } } }],
  // No defs at all: must be skipped without throwing.
  [`${NS}.blank`, { lexicon: 1, id: `${NS}.blank` }],
])

beforeAll(() => {
  storeLexicons(lexicons)
  discoverViews()
})

test('an inline view is keyed to its record collection with the record field noted', () => {
  const view = getViewDef(`${NS}.play#playView`)!
  expect(view).toMatchObject({ nsid: `${NS}.play#playView`, collection: `${NS}.play`, name: 'playView' })
  expect(view.recordField).toBe('play')
  // Inline views do not flatten the record, so record blobs are not view blobs.
  expect(view.blobFields.size).toBe(0)
  // The record field itself is not a hydration instruction.
  expect(view.fields.find((f) => f.fieldName === 'play')).toBeUndefined()
})

test('a ref to another record becomes a join, keyed by did for self records', () => {
  const view = getViewDef(`${NS}.play#playView`)!
  const author = view.fields.find((f) => f.fieldName === 'author')
  expect(author).toMatchObject({ kind: 'ref', collection: `${NS}.profile`, joinField: 'did' })
  // The joined record's blobs are named with their CDN presets.
  expect((author as any).blobFields).toEqual(
    new Map([
      ['avatar', 'avatar'],
      ['banner', 'banner'],
      ['thumbnail', 'feed_thumbnail'],
    ]),
  )

  // A ref with a fragment joins on the lexicon before the `#`, by uri for tid records.
  const related = view.fields.find((f) => f.fieldName === 'related')
  expect(related).toMatchObject({ kind: 'ref', collection: `${NS}.play`, joinField: 'uri' })
})

test('label arrays and plain scalars are classified with their type and format', () => {
  const view = getViewDef(`${NS}.play#playView`)!
  expect(view.fields.find((f) => f.fieldName === 'labels')).toEqual({ kind: 'labels', fieldName: 'labels' })
  expect(view.fields.find((f) => f.fieldName === 'playCount')).toMatchObject({ kind: 'scalar', type: 'integer' })
  expect(view.fields.find((f) => f.fieldName === 'indexedAt')).toMatchObject({
    kind: 'scalar',
    type: 'string',
    format: 'datetime',
  })
})

test('the default view for a collection is the bare *View, not a Basic or Detailed variant', () => {
  expect(getDefaultView(`${NS}.play`)?.name).toBe('playView')
  expect(getViewDef(`${NS}.play#playViewBasic`)).toBeDefined()
  expect(getDefaultView(`${NS}.profile`)?.name).toBe('profileView')
  expect(getViewDef(`${NS}.defs#profileViewDetailed`)?.collection).toBe(`${NS}.profile`)
})

test('a defs-file view is matched to the record with the same name in its namespace', () => {
  const view = getViewDef(`${NS}.defs#profileView`)!
  expect(view).toMatchObject({ collection: `${NS}.profile`, name: 'profileView', recordField: null })
  // Flattened views carry the record's own blobs, with presets by field name.
  expect(view.blobFields).toEqual(
    new Map([
      ['avatar', 'avatar'],
      ['banner', 'banner'],
      ['thumbnail', 'feed_thumbnail'],
    ]),
  )
})

test('a flattened view only lists fields that need hydrating', () => {
  const view = getViewDef(`${NS}.defs#profileView`)!
  const names = view.fields.map((f) => f.fieldName)
  // Envelope fields come from the row; record fields come from the record.
  expect(names).not.toContain('did')
  expect(names).not.toContain('handle')
  expect(names).not.toContain('indexedAt')
  expect(names).not.toContain('displayName')
  expect(names).not.toContain('avatar')
  // What is left is computed, viewer-specific or labels.
  expect(view.fields.find((f) => f.fieldName === 'followerCount')).toMatchObject({ kind: 'scalar', type: 'integer' })
  expect(view.fields.find((f) => f.fieldName === 'viewer')).toEqual({
    kind: 'scalar',
    fieldName: 'viewer',
    type: 'ref',
  })
  expect(view.fields.find((f) => f.fieldName === 'labels')).toEqual({ kind: 'labels', fieldName: 'labels' })
})

test('defs that are not views, or that match no record, are not registered', () => {
  expect(getViewDef(`${NS}.play#stats`)).toBeUndefined()
  expect(getViewDef(`${NS}.defs#viewerState`)).toBeUndefined()
  expect(getViewDef(`${NS}.defs#widgetView`)).toBeUndefined()
  expect(getViewDef(`${NS}.defs#searchView`)).toBeUndefined()
  expect(getViewDef(`${NS}.defs#emptyView`)).toBeUndefined()
  expect(getDefaultView(`${NS}.search`)).toBeUndefined()
  expect(getDefaultView('xyz.nothing')).toBeUndefined()
})

test('an unknown record blob gets the full-size preset', () => {
  // `artwork` matches no named preset, so it falls back to feed_fullsize.
  const view = getViewDef(`${NS}.play#playView`)!
  const related = view.fields.find((f) => f.fieldName === 'related') as any
  expect(related.blobFields.get('artwork')).toBe('feed_fullsize')
  expect(related.blobFields.get('thumbnail')).toBe('feed_thumbnail')
})

test('rediscovering rebuilds the registry from scratch instead of appending', () => {
  discoverViews()
  expect(getDefaultView(`${NS}.play`)?.name).toBe('playView')
  expect(getViewDef(`${NS}.play#playView`)?.fields).toHaveLength(5)
})
