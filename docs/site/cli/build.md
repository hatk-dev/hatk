---
title: Build & Deploy
description: Build your Hatk server for production.
---

## `hatk build`

Build the frontend for production using Vite.

```bash
hatk build
```

Compiles and bundles the SvelteKit frontend in `app/` into optimized production assets.

## Deployment

To run in production:

1. Build the frontend:

   ```bash
   hatk build
   ```

2. Start the server:

   ```bash
   hatk start
   ```

3. Configure environment variables for production:
   ```bash
   RELAY=wss://bsky.network \
   DATABASE=data/hatk.db \
   PORT=3000 \
   hatk start
   ```

See [Configuration](/getting-started/configuration) for all available environment variables.

## SQLite in production

hatk uses SQLite for all data storage. The `DATABASE` environment variable sets the path to the database file. In production, make sure this path points to a persistent volume.

### Railway

[Railway](https://railway.app) is a good fit for hatk apps. To deploy:

1. Push your project to a Git repository
2. Create a new Railway project linked to that repo
3. Add a persistent volume mounted at `/data`
4. Set environment variables:

   ```
   DATABASE=/data/hatk.db
   RELAY=wss://bsky.network
   PORT=3000
   ```

5. Set the start command to `hatk start`

Railway will build and deploy automatically on push. The SQLite database file persists across deploys via the mounted volume.
