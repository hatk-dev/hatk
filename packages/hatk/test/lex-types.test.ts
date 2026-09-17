import { expect, expectTypeOf, test } from 'vitest'
import * as lexTypes from '../src/lex-types.ts'
import type {
  LexDef,
  LexProcedure,
  LexQuery,
  LexRecord,
  LexServerParams,
  MapDef,
  MapProp,
  ResolveRef,
  Row,
  StrictArg,
} from '../src/lex-types.ts'

// lex-types.ts is a type-level mapping from lexicon JSON to TypeScript with no
// runtime code at all, so its contract is exercised with `expectTypeOf`: these
// assertions fail under `tsc` if a mapping regresses (vitest's own typecheck
// mode only looks at *.test-d.ts by default). The one runtime assertion pins
// the "zero runtime" promise itself.
//
// The generator emits every lexicon `as const` (src/cli.ts), so the mapped
// properties come out `readonly` — the expected types below say so explicitly.

// --- A small registry of lexicons, `as const` so literal types survive ---

const post = {
  lexicon: 1,
  id: 'xyz.test.post',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['text', 'createdAt'],
        properties: {
          text: { type: 'string', maxLength: 300 },
          createdAt: { type: 'string', format: 'datetime' },
          likes: { type: 'integer' },
          pinned: { type: 'boolean' },
          nothing: { type: 'null' },
          kind: { type: 'token' },
          anything: { type: 'unknown' },
          parent: { type: 'cid-link' },
          raw: { type: 'bytes' },
          image: { type: 'blob', accept: ['image/*'] },
          tags: { type: 'array', items: { type: 'string' } },
          facet: { type: 'ref', ref: '#facet' },
          author: { type: 'ref', ref: 'xyz.test.actor#profile' },
          quoted: { type: 'ref', ref: 'xyz.test.actor' },
          embed: { type: 'union', refs: ['#facet', 'xyz.test.actor#profile'] },
          meta: { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'integer' } } },
          loose: { type: 'object', properties: { c: { type: 'boolean' } } },
        },
      },
    },
    facet: {
      type: 'object',
      required: ['start'],
      properties: { start: { type: 'integer' }, end: { type: 'integer' } },
    },
  },
} as const

const actor = {
  lexicon: 1,
  id: 'xyz.test.actor',
  defs: {
    main: {
      type: 'record',
      key: 'literal:self',
      record: { type: 'object', properties: { displayName: { type: 'string' } } },
    },
    profile: {
      type: 'object',
      required: ['did'],
      properties: { did: { type: 'string' }, handle: { type: 'string' } },
    },
  },
} as const

const getPosts = {
  lexicon: 1,
  id: 'xyz.test.getPosts',
  defs: {
    main: {
      type: 'query',
      parameters: {
        type: 'params',
        required: ['actor'],
        properties: {
          actor: { type: 'string' },
          limit: { type: 'integer', default: 50 },
          cursor: { type: 'string' },
        },
      },
      output: {
        encoding: 'application/json',
        schema: {
          type: 'object',
          required: ['posts'],
          properties: {
            posts: { type: 'array', items: { type: 'ref', ref: 'xyz.test.post' } },
            cursor: { type: 'string' },
            profile: { type: 'ref', ref: 'xyz.test.actor#profile' },
          },
        },
      },
    },
  },
} as const

const createPost = {
  lexicon: 1,
  id: 'xyz.test.createPost',
  defs: {
    main: {
      type: 'procedure',
      input: {
        encoding: 'application/json',
        schema: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string' }, image: { type: 'blob' } },
        },
      },
      output: {
        encoding: 'application/json',
        schema: { type: 'ref', ref: 'xyz.test.post' },
      },
    },
  },
} as const

type Post = typeof post
type Actor = typeof actor
type Reg = { 'xyz.test.post': Post; 'xyz.test.actor': Actor }

// --- Runtime ---

test('the module has no runtime exports', () => {
  // Apps import it in browser bundles; anything that survives to runtime is a bug
  expect(Object.keys(lexTypes)).toEqual([])
})

// --- MapProp: scalar kinds ---

test('MapProp maps every scalar lexicon type to its TypeScript primitive', () => {
  expectTypeOf<MapProp<{ type: 'string' }>>().toEqualTypeOf<string>()
  expectTypeOf<MapProp<{ type: 'integer' }>>().toEqualTypeOf<number>()
  expectTypeOf<MapProp<{ type: 'boolean' }>>().toEqualTypeOf<boolean>()
  expectTypeOf<MapProp<{ type: 'null' }>>().toEqualTypeOf<null>()
  expectTypeOf<MapProp<{ type: 'token' }>>().toEqualTypeOf<string>()
  expectTypeOf<MapProp<{ type: 'unknown' }>>().toEqualTypeOf<unknown>()
  expectTypeOf<MapProp<{ type: 'cid-link' }>>().toEqualTypeOf<{ $link: string }>()
  expectTypeOf<MapProp<{ type: 'bytes' }>>().toEqualTypeOf<{ $bytes: string }>()
  expectTypeOf<MapProp<{ type: 'blob' }>>().toMatchTypeOf<{ $type: 'blob'; mimeType: string; size: number }>()
  expectTypeOf<MapProp<{ type: 'array'; items: { type: 'integer' } }>>().toEqualTypeOf<number[]>()
  expectTypeOf<MapProp<{ type: 'made-up' }>>().toEqualTypeOf<unknown>()
})

test('MapProp inline objects honour required vs optional properties', () => {
  type Strict = MapProp<{
    type: 'object'
    required: readonly ['a']
    properties: { a: { type: 'string' }; b: { type: 'integer' } }
  }>
  expectTypeOf<Strict>().toEqualTypeOf<{ a: string; b?: number }>()

  type Loose = MapProp<{ type: 'object'; properties: { c: { type: 'boolean' } } }>
  expectTypeOf<Loose>().toEqualTypeOf<{ c?: boolean }>()
})

// --- LexRecord ---

test('LexRecord splits properties by the required array and resolves every ref form', () => {
  type P = LexRecord<Post, Reg>

  expectTypeOf<P['text']>().toEqualTypeOf<string>()
  expectTypeOf<P['createdAt']>().toEqualTypeOf<string>()
  expectTypeOf<P['likes']>().toEqualTypeOf<number | undefined>()
  expectTypeOf<P>().toMatchTypeOf<{ text: string; createdAt: string }>()
  // Optional keys really are optional: a record with only the required fields type-checks
  const minimal: P = { text: 'hi', createdAt: 'now' }
  expect(minimal.text).toBe('hi')

  // #local ref → def in the same lexicon
  expectTypeOf<NonNullable<P['facet']>>().toEqualTypeOf<{ readonly start: number; readonly end?: number }>()
  // nsid#def ref → def in another lexicon
  expectTypeOf<NonNullable<P['author']>>().toEqualTypeOf<{ readonly did: string; readonly handle?: string }>()
  // bare nsid ref → main def of another lexicon (a record with no required list)
  expectTypeOf<NonNullable<P['quoted']>>().toEqualTypeOf<{ readonly displayName?: string }>()
  // nested inline objects
  expectTypeOf<NonNullable<P['meta']>>().toEqualTypeOf<{ readonly a: string; readonly b?: number }>()
  expectTypeOf<NonNullable<P['loose']>>().toEqualTypeOf<{ readonly c?: boolean }>()
})

test('LexRecord unions carry a $type discriminant qualified against the owning lexicon', () => {
  type Embed = NonNullable<LexRecord<Post, Reg>['embed']>
  expectTypeOf<Embed>().toEqualTypeOf<
    | { $type: 'xyz.test.post#facet'; readonly start: number; readonly end?: number }
    | { $type: 'xyz.test.actor#profile'; readonly did: string; readonly handle?: string }
  >()

  // The discriminant narrows
  const narrow = (e: Embed) => (e.$type === 'xyz.test.post#facet' ? e.start : e.did)
  expect(narrow({ $type: 'xyz.test.post#facet', start: 1 })).toBe(1)
  expect(narrow({ $type: 'xyz.test.actor#profile', did: 'did:plc:x' })).toBe('did:plc:x')
})

test('LexRecord of a record without a required list makes every property optional', () => {
  expectTypeOf<LexRecord<Actor>>().toEqualTypeOf<{ readonly displayName?: string }>()
})

test('LexRecord is never for a lexicon whose main def is not a record', () => {
  expectTypeOf<LexRecord<typeof getPosts>>().toBeNever()
})

test('a ref to a lexicon missing from the registry maps to unknown, not never', () => {
  // Keeps a half-populated registry compiling instead of poisoning every record type
  type Orphan = MapProp<{ type: 'ref'; ref: 'xyz.test.missing' }, Reg>
  expectTypeOf<Orphan>().toEqualTypeOf<unknown>()
  expectTypeOf<MapProp<{ type: 'ref'; ref: 'xyz.test.actor#nope' }, Reg>>().toEqualTypeOf<unknown>()
  expectTypeOf<MapProp<{ type: 'ref'; ref: '#nope' }, Reg, Post>>().toEqualTypeOf<unknown>()
})

// --- ResolveRef / MapDef ---

test('ResolveRef and MapDef normalize record, object and bare-properties defs', () => {
  expectTypeOf<ResolveRef<'#facet', Reg, Post>>().toEqualTypeOf<{ readonly start: number; readonly end?: number }>()
  expectTypeOf<ResolveRef<'xyz.test.actor', Reg, Post>>().toEqualTypeOf<{ readonly displayName?: string }>()
  expectTypeOf<MapDef<{ properties: { x: { type: 'string' } } }, Reg, Post>>().toEqualTypeOf<{ x?: string }>()
  expectTypeOf<MapDef<{ type: 'string' }, Reg, Post>>().toEqualTypeOf<unknown>()
})

// --- LexQuery ---

test('LexQuery params respect required and outputs wrap record refs in the wire row shape', () => {
  type Q = LexQuery<typeof getPosts, Reg>

  expectTypeOf<Q['params']>().toEqualTypeOf<{
    readonly actor: string
    readonly limit?: number
    readonly cursor?: string
  }>()

  type Out = Q['output']
  expectTypeOf<Out['cursor']>().toEqualTypeOf<string | undefined>()
  // A ref to a record def arrives flattened with uri/did alongside the fields
  type WirePost = Out['posts'][number]
  expectTypeOf<WirePost>().toMatchTypeOf<{ uri: string; did: string; handle?: string; text: string }>()
  // Blobs are rewritten to a URL (or absent) on the wire
  expectTypeOf<WirePost['image']>().toEqualTypeOf<string | undefined>()
  // A ref to an object def stays a plain object
  expectTypeOf<NonNullable<Out['profile']>>().toEqualTypeOf<{ readonly did: string; readonly handle?: string }>()
})

test('LexQuery of a non-query lexicon is never', () => {
  expectTypeOf<LexQuery<Post>>().toBeNever()
})

// --- LexProcedure ---

test('LexProcedure exposes input with schema mapping and output with wire mapping', () => {
  type P = LexProcedure<typeof createPost, Reg>

  expectTypeOf<P['params']>().toEqualTypeOf<{}>()
  expectTypeOf<P['input']>().toEqualTypeOf<{
    readonly text: string
    readonly image?: { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }
  }>()
  // output schema is a bare ref to a record → wire row
  expectTypeOf<P['output']>().toMatchTypeOf<{ uri: string; did: string; text: string; createdAt: string }>()
  expectTypeOf<P['output']['image']>().toEqualTypeOf<string | undefined>()
})

test('LexProcedure without input or output types them as void', () => {
  const bare = { lexicon: 1, id: 'xyz.test.ping', defs: { main: { type: 'procedure' } } } as const
  type P = LexProcedure<typeof bare>
  expectTypeOf<P['input']>().toEqualTypeOf<void>()
  expectTypeOf<P['output']>().toEqualTypeOf<void>()
})

// --- LexDef / LexServerParams / helpers ---

test('LexDef extracts a named def with wire mapping', () => {
  expectTypeOf<LexDef<Post, 'facet', Reg>>().toEqualTypeOf<{ readonly start: number; readonly end?: number }>()
  expectTypeOf<LexDef<Post, 'missing', Reg>>().toBeNever()
})

test('LexServerParams treats params with a default as present on the server side', () => {
  type S = LexServerParams<typeof getPosts, Reg>
  expectTypeOf<S>().toEqualTypeOf<{ readonly actor: string; readonly limit: number; readonly cursor?: string }>()
  // and falls back to a loose string map when the lexicon declares no params
  expectTypeOf<LexServerParams<typeof createPost>>().toEqualTypeOf<Record<string, string>>()
})

test('StrictArg rejects properties the output schema does not declare at the call site', () => {
  // This is how ctx.ok(value) catches a handler returning more than its lexicon
  // declares: the extra key is mapped to never, so the literal fails to type-check.
  type Declared = { a: string }
  const ok = <T>(value: StrictArg<T, Declared>) => value
  expect(ok({ a: 'x' })).toEqual({ a: 'x' })
  // @ts-expect-error `extra` is not declared by the output schema
  ok({ a: 'x', extra: 1 })
})

test('Row wraps a record value with its repo metadata', () => {
  expectTypeOf<Row<{ text: string }>>().toEqualTypeOf<{
    uri: string
    cid: string
    did: string
    // Present only on a record read out of a permissioned space; public repo
    // data carries no space and the field is left off the wire entirely.
    space?: string
    handle?: string
    indexed_at?: string
    value: { text: string }
  }>()
})
