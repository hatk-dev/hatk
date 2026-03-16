---
title: Labels
description: Define labels for content moderation and metadata.
---

Labels are metadata tags applied to records for moderation, categorization, or informational purposes. They follow the [AT Protocol labeling spec](https://atproto.com/specs/label).

## Defining labels

Create label definitions in the `labels/` directory:

```bash
hatk generate label explicit
```

Each label module exports a `definition` describing the label and an `evaluate` function that decides when to apply it. Label rules run automatically each time a record is indexed — if `evaluate` returns label identifiers, they're stored in the `_labels` table.

Here's an example that marks `fm.teal.alpha.feed.play` records as explicit when the track name contains common explicit content indicators:

```typescript
import type { LabelRuleContext } from 'hatk/labels'

const EXPLICIT_PATTERNS = [/\(explicit\)/i, /\[explicit\]/i, /\bexplicit version\b/i]

export default {
  definition: {
    identifier: 'explicit',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'warn',
    locales: [
      {
        lang: 'en',
        name: 'Explicit',
        description: 'Track contains explicit content',
      },
    ],
  },

  async evaluate(ctx: LabelRuleContext) {
    if (ctx.record.collection !== 'fm.teal.alpha.feed.play') return []

    const trackName = ctx.record.value.trackName || ''
    const isExplicit = EXPLICIT_PATTERNS.some((p) => p.test(trackName))

    return isExplicit ? ['explicit'] : []
  },
}
```

You can also query the database in `evaluate` for more complex rules — for example, checking an external blocklist table:

```typescript
async evaluate(ctx: LabelRuleContext) {
  if (ctx.record.collection !== 'fm.teal.alpha.feed.play') return []

  const rows = await ctx.db.query(
    `SELECT 1 FROM explicit_tracks WHERE isrc = $1 LIMIT 1`,
    [ctx.record.value.isrc],
  )

  return rows.length > 0 ? ['explicit'] : []
},
```

## `LabelDefinition`

| Field            | Type                                 | Description                        |
| ---------------- | ------------------------------------ | ---------------------------------- |
| `identifier`     | string                               | Unique label ID                    |
| `severity`       | `'alert'` \| `'inform'` \| `'none'`  | How urgently to surface the label  |
| `blurs`          | `'media'` \| `'content'` \| `'none'` | What to blur when label is applied |
| `defaultSetting` | `'warn'` \| `'hide'` \| `'ignore'`   | Default user-facing behavior       |
| `locales`        | array                                | Localized name and description     |

## Evaluation context

The `evaluate` function receives a `LabelRuleContext` with:

| Field               | Type     | Description                          |
| ------------------- | -------- | ------------------------------------ |
| `db.query`          | function | Run SQL queries against DuckDB       |
| `db.run`            | function | Execute SQL statements               |
| `record.uri`        | string   | AT URI of the record being evaluated |
| `record.cid`        | string   | CID of the record                    |
| `record.did`        | string   | DID of the record author             |
| `record.collection` | string   | Collection NSID                      |
| `record.value`      | object   | The record's fields                  |

Label rules run automatically when records are indexed. Return an array of label identifier strings to apply, or an empty array to skip.

---

## Hydrating labels in responses

Labels are stored in a `_labels` table and can be included in feed and query responses during hydration. The `HydrateContext` provides a `labels()` helper that queries active labels for a set of record URIs.

### Using `ctx.labels()` in a hydrate function

```typescript
import { defineFeed } from '../hatk.generated.ts'

export default defineFeed({
  collection: 'fm.teal.alpha.feed.play',
  label: 'Recent',

  async generate(ctx) {
    const rows = await ctx.db.query(
      `SELECT uri, cid, indexed_at FROM "fm.teal.alpha.feed.play"
       ORDER BY indexed_at DESC LIMIT $1`,
      [ctx.limit + 1],
    )
    const hasMore = rows.length > ctx.limit
    if (hasMore) rows.pop()
    const last = rows[rows.length - 1]
    return ctx.ok({
      uris: rows.map((r) => r.uri),
      cursor: hasMore && last ? ctx.packCursor(last.indexed_at, last.cid) : undefined,
    })
  },

  async hydrate(ctx) {
    const uris = ctx.items.map((item) => item.uri)
    const labelMap = await ctx.labels(uris)

    return ctx.items.map((item) => ({
      ...item,
      labels: labelMap.get(item.uri) || [],
    }))
  },
})
```

The `ctx.labels()` method returns a `Map<string, Label[]>` where each label has:

| Field | Type           | Description                            |
| ----- | -------------- | -------------------------------------- |
| `src` | string         | DID of the label creator               |
| `uri` | string         | AT URI of the labeled resource         |
| `val` | string         | Label identifier (e.g. `"explicit"`)   |
| `neg` | boolean        | If true, this negates a previous label |
| `cts` | string         | Timestamp when the label was created   |
| `exp` | string \| null | Expiration timestamp                   |

Only active labels are returned — expired labels and labels that have been negated are automatically filtered out.

### Adding labels to a view lexicon

To include labels in your view's response type, add a field that references `com.atproto.label.defs#label`:

```json
{
  "playView": {
    "type": "object",
    "required": ["record"],
    "properties": {
      "record": {
        "type": "ref",
        "ref": "fm.teal.alpha.feed.play"
      },
      "labels": {
        "type": "array",
        "items": { "type": "ref", "ref": "com.atproto.label.defs#label" }
      }
    }
  }
}
```

This gives you a typed `labels` field on the view. You then populate it in your hydrate function using `ctx.labels()` as shown above.
