---
title: Labels
description: Apply moderation labels to records as they're indexed.
---

Labels are metadata tags that get applied to records for moderation or categorization. They follow the AT Protocol labeling spec (a standard way for services to annotate content with things like "explicit" or "nsfw"). Hatk evaluates label rules automatically each time a record is indexed.

## Defining a label

Create a file in `server/` that exports `defineLabel()` with a `definition` and an `evaluate` function:

```typescript
// server/labels/explicit.ts
import { defineLabel } from '$hatk'

const EXPLICIT_PATTERNS = [/\(explicit\)/i, /\[explicit\]/i, /\bexplicit version\b/i]

export default defineLabel({
  definition: {
    identifier: 'explicit',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'warn',
    locales: [
      { lang: 'en', name: 'Explicit', description: 'Track contains explicit content' },
    ],
  },

  async evaluate(ctx) {
    if (ctx.record.collection !== 'fm.teal.alpha.feed.play') return []

    const trackName = ctx.record.value.trackName || ''
    const isExplicit = EXPLICIT_PATTERNS.some((p) => p.test(trackName))

    return isExplicit ? ['explicit'] : []
  },
})
```

The `evaluate` function runs for every indexed record. Return an array of label identifier strings to apply, or `[]` to skip. Labels are stored in the `_labels` table automatically.

## Evaluate context

The `evaluate` function receives a context with:

| Field | Description |
| --- | --- |
| `ctx.db.query(sql, params?)` | Run a SQL query against SQLite |
| `ctx.db.run(sql, params?)` | Execute a SQL statement |
| `ctx.record.uri` | AT URI of the record |
| `ctx.record.cid` | Content hash of the record |
| `ctx.record.did` | DID (decentralized identifier) of the author |
| `ctx.record.collection` | Collection NSID (e.g. `fm.teal.alpha.feed.play`) |
| `ctx.record.value` | The record's fields as an object |

You can query the database in `evaluate` for more complex rules:

```typescript
async evaluate(ctx) {
  if (ctx.record.collection !== 'fm.teal.alpha.feed.play') return []

  const rows = await ctx.db.query(
    `SELECT 1 FROM explicit_tracks WHERE isrc = ? LIMIT 1`,
    [ctx.record.value.isrc],
  )

  return rows.length > 0 ? ['explicit'] : []
},
```

## Label definition fields

| Field | Type | Description |
| --- | --- | --- |
| `identifier` | string | Unique label ID |
| `severity` | `'alert'` \| `'inform'` \| `'none'` | How urgently to surface the label |
| `blurs` | `'media'` \| `'content'` \| `'none'` | What to blur when label is applied |
| `defaultSetting` | `'warn'` \| `'hide'` \| `'ignore'` | Default user-facing behavior |
| `locales` | array | Localized name and description |

## Hydrating labels in responses

Labels stored in `_labels` can be included in feed and query responses. The `ctx.labels()` helper queries active labels for a set of record URIs:

```typescript
async hydrate(ctx) {
  const uris = ctx.items.map((item) => item.uri)
  const labelMap = await ctx.labels(uris)

  return ctx.items.map((item) => ({
    ...item,
    labels: labelMap.get(item.uri) || [],
  }))
},
```

`ctx.labels()` returns a `Map<string, Label[]>`. Expired and negated labels are automatically filtered out.
