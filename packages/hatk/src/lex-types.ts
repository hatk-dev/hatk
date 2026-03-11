// lex-types.ts — Type-level lexicon → TypeScript mapping
// Zero codegen, zero runtime, zero deps.
// Import lexicon JSON + apply these types = fully typed records.

// --- Lexicon runtime value types ---

export type LexBlob = {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

export type LexBytes = { $bytes: string }

export type LexCidLink = { $link: string }

// --- Framework envelope ---
// Row<T> is the shape reshapeRow produces: metadata + record value.
// Used by query/procedure outputs where record refs appear on the wire.

export type Row<T = unknown> = {
  uri: string
  cid: string
  did: string
  handle?: string
  indexed_at?: string
  value: T
}

export type RecordBase = { uri: string; cid: string; did: string }

export type FlatRow<T = unknown> = {
  uri: string
  did: string
  handle?: string
} & T

// --- Branded output type ---
// Used by defineQuery/defineProcedure to enforce strict return types.
// Excess property checking applies to object literals passed as function args,
// so ctx.ok(value) catches extra properties that plain return statements miss.

declare const __checked: unique symbol
export type Checked<T> = T & { readonly [__checked]: true }

// --- Core property mapper ---
// Maps a single lexicon property definition to its TypeScript type.
// Reg = registry of all lexicons (for cross-lexicon ref resolution)
// Self = the current lexicon document (for #local ref resolution)

export type MapProp<P, Reg = {}, Self = {}> = P extends { type: 'string' }
  ? string
  : P extends { type: 'integer' }
    ? number
    : P extends { type: 'boolean' }
      ? boolean
      : P extends { type: 'null' }
        ? null
        : P extends { type: 'token' }
          ? string
          : P extends { type: 'unknown' }
            ? unknown
            : P extends { type: 'cid-link' }
              ? LexCidLink
              : P extends { type: 'bytes' }
                ? LexBytes
                : P extends { type: 'blob' }
                  ? LexBlob
                  : P extends { type: 'array'; items: infer I }
                    ? MapProp<I, Reg, Self>[]
                    : P extends {
                          type: 'object'
                          required: infer Req extends readonly string[]
                          properties: infer Props
                        }
                      ? Prettify<
                          { [K in keyof Props as K extends Req[number] ? K : never]: MapProp<Props[K], Reg, Self> } & {
                            [K in keyof Props as K extends Req[number] ? never : K]?: MapProp<Props[K], Reg, Self>
                          }
                        >
                      : P extends { type: 'object'; properties: infer Props }
                        ? { [K in keyof Props]?: MapProp<Props[K], Reg, Self> }
                        : P extends { type: 'ref'; ref: infer R extends string }
                          ? ResolveRef<R, Reg, Self>
                          : P extends { type: 'union'; refs: readonly (infer R)[] }
                            ? R extends string
                              ? ResolveUnionMember<R, Reg, Self>
                              : never
                            : unknown

// --- Union member resolution ---
// Adds $type discriminant to each union branch for type narrowing.
// #local → "$lexiconId#local", nsid#def → "nsid#def", nsid → "nsid"

type QualifyRef<R extends string, Self> = R extends `#${infer Def}`
  ? Self extends { id: infer Id extends string }
    ? `${Id}#${Def}`
    : string
  : R

type ResolveUnionMember<R extends string, Reg, Self> =
  ResolveRef<R, Reg, Self> extends infer Resolved
    ? Resolved extends Record<string, any>
      ? Prettify<{ $type: QualifyRef<R, Self> } & Resolved>
      : unknown
    : never

// --- Ref resolution ---
// Handles three ref formats:
//   #local    → look up def in current lexicon
//   nsid#def  → look up def in another lexicon via registry
//   nsid      → look up main def in another lexicon via registry

export type ResolveRef<R extends string, Reg, Self> = R extends `#${infer Def}`
  ? Self extends { defs: Record<string, any> }
    ? Def extends keyof Self['defs']
      ? MapDef<Self['defs'][Def], Reg, Self>
      : unknown
    : unknown
  : R extends `${infer NSID}#${infer Def}`
    ? NSID extends keyof Reg
      ? Reg[NSID] extends { defs: Record<string, any> }
        ? Def extends keyof Reg[NSID]['defs']
          ? MapDef<Reg[NSID]['defs'][Def], Reg, Reg[NSID]>
          : unknown
        : unknown
      : unknown
    : R extends keyof Reg
      ? Reg[R] extends { defs: { main: infer Main } }
        ? MapDef<Main, Reg, Reg[R]>
        : unknown
      : unknown

// --- Definition mapper ---
// A def can be a record (has .record.properties), an object (has .properties),
// or a raw object shape. This normalizes all three.

export type MapDef<D, Reg, Self> = D extends {
  type: 'record'
  record: { required: infer Req extends readonly string[]; properties: infer Props }
}
  ? Prettify<
      { [K in keyof Props as K extends Req[number] ? K : never]: MapProp<Props[K], Reg, Self> } & {
        [K in keyof Props as K extends Req[number] ? never : K]?: MapProp<Props[K], Reg, Self>
      }
    >
  : D extends { type: 'record'; record: { properties: infer Props } }
    ? { [K in keyof Props]?: MapProp<Props[K], Reg, Self> }
    : D extends { type: 'object'; required: infer Req extends readonly string[]; properties: infer Props }
      ? Prettify<
          { [K in keyof Props as K extends Req[number] ? K : never]: MapProp<Props[K], Reg, Self> } & {
            [K in keyof Props as K extends Req[number] ? never : K]?: MapProp<Props[K], Reg, Self>
          }
        >
      : D extends { type: 'object'; properties: infer Props }
        ? { [K in keyof Props]?: MapProp<Props[K], Reg, Self> }
        : D extends { properties: infer Props }
          ? { [K in keyof Props]?: MapProp<Props[K], Reg, Self> }
          : unknown

// --- Row-aware mapping for query/procedure outputs ---
// Convention: refs to record-type defs get wrapped in Row<T> because
// reshapeRow wraps stored records in { uri, cid, did, value: {...} }.
// Object defs (views, params) are mapped normally but their refs recurse.

type MapDefWired<D, Reg, Self> = D extends {
  type: 'record'
  record: { required: infer Req extends readonly string[]; properties: infer Props }
}
  ? FlatRow<
      Prettify<
        { [K in keyof Props as K extends Req[number] ? K : never]: MapPropWired<Props[K], Reg, Self> } & {
          [K in keyof Props as K extends Req[number] ? never : K]?: MapPropWired<Props[K], Reg, Self>
        }
      >
    >
  : D extends { type: 'record'; record: { properties: infer Props } }
    ? FlatRow<{ [K in keyof Props]?: MapPropWired<Props[K], Reg, Self> }>
    : D extends { type: 'object'; required: infer Req extends readonly string[]; properties: infer Props }
      ? Prettify<
          { [K in keyof Props as K extends Req[number] ? K : never]: MapPropWired<Props[K], Reg, Self> } & {
            [K in keyof Props as K extends Req[number] ? never : K]?: MapPropWired<Props[K], Reg, Self>
          }
        >
      : D extends { type: 'object'; properties: infer Props }
        ? { [K in keyof Props]?: MapPropWired<Props[K], Reg, Self> }
        : D extends { properties: infer Props }
          ? { [K in keyof Props]?: MapPropWired<Props[K], Reg, Self> }
          : unknown

type ResolveRefWired<R extends string, Reg, Self> = R extends `#${infer Def}`
  ? Self extends { defs: Record<string, any> }
    ? Def extends keyof Self['defs']
      ? MapDefWired<Self['defs'][Def], Reg, Self>
      : unknown
    : unknown
  : R extends `${infer NSID}#${infer Def}`
    ? NSID extends keyof Reg
      ? Reg[NSID] extends { defs: Record<string, any> }
        ? Def extends keyof Reg[NSID]['defs']
          ? MapDefWired<Reg[NSID]['defs'][Def], Reg, Reg[NSID]>
          : unknown
        : unknown
      : unknown
    : R extends keyof Reg
      ? Reg[R] extends { defs: { main: infer Main } }
        ? MapDefWired<Main, Reg, Reg[R]>
        : unknown
      : unknown

type MapPropWired<P, Reg = {}, Self = {}> = P extends { type: 'string' }
  ? string
  : P extends { type: 'integer' }
    ? number
    : P extends { type: 'boolean' }
      ? boolean
      : P extends { type: 'null' }
        ? null
        : P extends { type: 'token' }
          ? string
          : P extends { type: 'unknown' }
            ? unknown
            : P extends { type: 'cid-link' }
              ? LexCidLink
              : P extends { type: 'bytes' }
                ? LexBytes
                : P extends { type: 'blob' }
                  ? string | undefined
                  : P extends { type: 'array'; items: infer I }
                    ? MapPropWired<I, Reg, Self>[]
                    : P extends {
                          type: 'object'
                          required: infer Req extends readonly string[]
                          properties: infer Props
                        }
                      ? Prettify<
                          {
                            [K in keyof Props as K extends Req[number] ? K : never]: MapPropWired<Props[K], Reg, Self>
                          } & {
                            [K in keyof Props as K extends Req[number] ? never : K]?: MapPropWired<Props[K], Reg, Self>
                          }
                        >
                      : P extends { type: 'object'; properties: infer Props }
                        ? { [K in keyof Props]?: MapPropWired<Props[K], Reg, Self> }
                        : P extends { type: 'ref'; ref: infer R extends string }
                          ? ResolveRefWired<R, Reg, Self>
                          : P extends { type: 'union'; refs: readonly (infer R)[] }
                            ? R extends string
                              ? ResolveRefWired<R, Reg, Self>
                              : never
                            : unknown

// --- Schema extractor ---
// Extracts properties from an output/input schema: { encoding, schema: { type: 'object', properties } }

type MapSchema<S, Reg, Self> = S extends {
  schema: { required: infer Req extends readonly string[]; properties: infer Props }
}
  ? Prettify<
      { [K in keyof Props as K extends Req[number] ? K : never]: MapProp<Props[K], Reg, Self> } & {
        [K in keyof Props as K extends Req[number] ? never : K]?: MapProp<Props[K], Reg, Self>
      }
    >
  : S extends { schema: { properties: infer Props } }
    ? { [K in keyof Props]?: MapProp<Props[K], Reg, Self> }
    : S extends { schema: { type: 'ref'; ref: infer R extends string } }
      ? ResolveRef<R, Reg, Self>
      : unknown

type MapSchemaWired<S, Reg, Self> = S extends {
  schema: { required: infer Req extends readonly string[]; properties: infer Props }
}
  ? Prettify<
      { [K in keyof Props as K extends Req[number] ? K : never]: MapPropWired<Props[K], Reg, Self> } & {
        [K in keyof Props as K extends Req[number] ? never : K]?: MapPropWired<Props[K], Reg, Self>
      }
    >
  : S extends { schema: { properties: infer Props } }
    ? { [K in keyof Props]?: MapPropWired<Props[K], Reg, Self> }
    : S extends { schema: { type: 'ref'; ref: infer R extends string } }
      ? ResolveRefWired<R, Reg, Self>
      : unknown

// --- Entry points ---

// Record: extract typed record properties from a record-type lexicon.
// Pure schema — no envelope fields. Use Row<T> from the framework for the wire shape.
export type LexRecord<L, Reg = {}> = L extends {
  defs: { main: { type: 'record'; record: { required: infer Req extends readonly string[]; properties: infer Props } } }
}
  ? Prettify<
      { [K in keyof Props as K extends Req[number] ? K : never]: MapProp<Props[K], Reg, L> } & {
        [K in keyof Props as K extends Req[number] ? never : K]?: MapProp<Props[K], Reg, L>
      }
    >
  : L extends { defs: { main: { type: 'record'; record: { properties: infer Props } } } }
    ? Prettify<{ [K in keyof Props]?: MapProp<Props[K], Reg, L> }>
    : never

// Query: extract params + output from a query-type lexicon.
// Params respect `required` array. Outputs use wired mapping: refs to records → Row<T>.
export type LexQuery<L, Reg = {}> = L extends { defs: { main: { type: 'query' } } }
  ? {
      params: L extends {
        defs: { main: { parameters: { required: infer Req extends readonly string[]; properties: infer P } } }
      }
        ? Prettify<MapParamsWithRequired<P, Req, Reg, L>>
        : L extends { defs: { main: { parameters: { properties: infer P } } } }
          ? { [K in keyof P]?: MapProp<P[K], Reg, L> }
          : {}
      output: L extends { defs: { main: { output: infer O } } } ? MapSchemaWired<O, Reg, L> : void
    }
  : never

// Procedure: extract params + input + output from a procedure-type lexicon.
// Outputs use wired mapping: refs to records → Row<T>.
export type LexProcedure<L, Reg = {}> = L extends { defs: { main: { type: 'procedure' } } }
  ? {
      params: L extends {
        defs: { main: { parameters: { required: infer Req extends readonly string[]; properties: infer P } } }
      }
        ? Prettify<MapParamsWithRequired<P, Req, Reg, L>>
        : L extends { defs: { main: { parameters: { properties: infer P } } } }
          ? { [K in keyof P]?: MapProp<P[K], Reg, L> }
          : {}
      input: L extends { defs: { main: { input: infer I } } } ? MapSchema<I, Reg, L> : void
      output: L extends { defs: { main: { output: infer O } } } ? MapSchemaWired<O, Reg, L> : void
    }
  : never

// Def: extract a named non-main def from a lexicon (e.g., #playView, #artist)
// Uses wired mapping so view defs that reference records get Row<T> wrapping,
// matching the actual wire format.
export type LexDef<L, Def extends string, Reg = {}> = L extends { defs: Record<string, any> }
  ? Def extends keyof L['defs']
    ? Prettify<MapDefWired<L['defs'][Def], Reg, L>>
    : never
  : never

// --- Utility ---

export type Prettify<T> = { [K in keyof T]: T[K] } & {}

// Strict argument type — maps excess keys to `never`, causing a compile error.
// Used by ok() in defineQuery/defineProcedure to catch extra properties.
export type StrictArg<T, U> = T & Record<Exclude<keyof T, keyof U>, never>

// Split properties into required + optional based on `required` array.
// Used for client-facing params (callers can omit params with server-side defaults).
type MapParamsWithRequired<Props, Req extends readonly string[], Reg, Self> = {
  [K in keyof Props as K extends Req[number] ? K : never]: MapProp<Props[K], Reg, Self>
} & { [K in keyof Props as K extends Req[number] ? never : K]?: MapProp<Props[K], Reg, Self> }

// Server-side params: also treats params with `default` as required (framework applies them).
type HasDefault<Props> = { [K in keyof Props]: Props[K] extends { default: any } ? K : never }[keyof Props]
export type WithDefaults<Props, Req extends readonly string[], Reg, Self> = {
  [K in keyof Props as K extends Req[number] | HasDefault<Props> ? K : never]: MapProp<Props[K], Reg, Self>
} & { [K in keyof Props as K extends Req[number] | HasDefault<Props> ? never : K]?: MapProp<Props[K], Reg, Self> }

// Extract server-side params from a lexicon (defaults treated as required).
// Used by Ctx<K> in generated types so handlers see defaulted params as non-optional.
export type LexServerParams<L, Reg = {}> = L extends {
  defs: { main: { parameters: { required: infer Req extends readonly string[]; properties: infer P } } }
}
  ? Prettify<WithDefaults<P, Req, Reg, L>>
  : L extends { defs: { main: { parameters: { properties: infer P } } } }
    ? { [K in keyof P]?: MapProp<P[K], Reg, L> }
    : Record<string, string>
