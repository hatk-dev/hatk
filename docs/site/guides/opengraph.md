---
title: OpenGraph Images
description: Generate dynamic OpenGraph images for link previews.
---

Hatk generates dynamic OpenGraph images so your pages get rich previews when shared. You define a `generate` function that returns a virtual DOM tree, and Hatk renders it to a 1200x630 PNG using [Satori](https://github.com/vercel/satori).

## Defining an OG route

Create a file in `server/og/` that exports `defineOG()` with a path pattern and a generate function:

```typescript
// server/og/artist.ts
import { defineOG } from '$hatk'

export default defineOG('/og/artist/:artist', async (ctx) => {
  const { db, params, fetchImage } = ctx

  const rows = await db.query(
    `SELECT CAST(COUNT(*) AS INTEGER) AS play_count
     FROM "fm.teal.alpha.feed.play__artists"
     WHERE artist_name = ?`,
    [params.artist],
  )
  const stats = rows[0] || { play_count: 0 }

  return {
    element: {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: '100%',
          height: '100%',
          background: '#070a11',
          color: 'white',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
        },
        children: [
          { type: 'div', props: { children: params.artist, style: { fontSize: 58, fontWeight: 700 } } },
          { type: 'div', props: { children: `${stats.play_count} plays`, style: { fontSize: 28, color: '#94a3b8', marginTop: '16px' } } },
        ],
      },
    },
    meta: { title: params.artist },
  }
})
```

## How it works

The `path` field uses Express-style route parameters. The `/og` prefix is significant:

- `GET /og/artist/radiohead` serves the generated PNG
- `GET /artist/radiohead` (the page route) automatically gets `og:image` meta tags injected pointing to the OG image URL

This keeps page routes and OG routes in sync. You don't need to add meta tags manually.

## Generate context

The `generate` function receives an `OpengraphContext` with:

| Field | Description |
| --- | --- |
| `db.query(sql, params?)` | Run SQL queries against SQLite |
| `params` | URL path parameters (e.g. `{ artist: 'Radiohead' }`) |
| `fetchImage(url)` | Fetch a remote image and return it as a base64 data URL for use in `img` elements |
| `lookup(collection, field, values)` | Look up records by field value |
| `count(collection, field, values)` | Count records by field value |
| `labels(uris)` | Query labels for record URIs |
| `blobUrl(did, cid)` | Resolve a blob reference to a URL |

## Return value

Return an `OpengraphResult`:

| Field | Required | Description |
| --- | --- | --- |
| `element` | Yes | A Satori virtual DOM tree |
| `options` | No | Override `width` (default 1200), `height` (default 630), or provide custom `fonts` |
| `meta` | No | `title` and `description` for the injected meta tags |

## Virtual DOM

Satori uses a React-like virtual DOM. Elements are plain objects with `type` and `props` containing `style` and `children`:

```typescript
{
  type: 'div',
  props: {
    style: { display: 'flex', flexDirection: 'column', gap: '16px' },
    children: [
      { type: 'div', props: { children: 'Hello', style: { fontSize: 48 } } },
      { type: 'img', props: { src: imageDataUrl, width: 300, height: 300 } },
    ],
  },
}
```

All layouts must use `display: 'flex'`. See the [Satori docs](https://github.com/vercel/satori#css) for supported CSS properties.

## Using `fetchImage`

Remote images must be converted to base64 data URLs before Satori can render them:

```typescript
const artUrl = await ctx.fetchImage('https://example.com/image.jpg')
// Returns "data:image/jpeg;base64,..." or null on failure
```

Then pass it as the `src` on an `img` element.

## Caching

Generated images are cached in memory for 5 minutes (up to 200 entries). A default Inter font is bundled; custom fonts can be provided via `options.fonts`.
