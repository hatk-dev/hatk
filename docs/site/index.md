---
layout: home

hero:
  name: hatk
  tagline: Build AT Protocol apps with typed XRPC endpoints.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/quickstart
    - theme: alt
      text: CLI Reference
      link: /cli/

features:
  - title: Convention-driven storage
    details: Define lexicons, get tables with full-text search and pagination. No DDL to write.
  - title: File-based backend
    details: Files in server/feeds/ become feed generators. Files in server/xrpc/ become endpoints.
  - title: OAuth included
    details: Server-side AT Protocol OAuth with session cookies. Configure scopes in hatk.config.ts.
  - title: Typed from lexicons
    details: Lexicons generate TypeScript types for records, queries, feeds, and the client.
---

## Project Structure

A hatk app looks like this:

```
my-app/
├── app/                        # SvelteKit frontend
│   ├── routes/
│   │   ├── +layout.server.ts   # parseViewer(cookies)
│   │   └── +page.svelte        # Your UI
│   └── lib/
├── server/                     # Backend handlers
│   ├── feeds/                  # Feed generators
│   │   └── recent.ts           # defineFeed({ ... })
│   └── xrpc/                   # Custom XRPC endpoints
│       └── getProfile.ts       # defineQuery('...', ...)
├── seeds/
│   └── seed.ts                 # Test fixture data
├── lexicons/                   # AT Protocol schemas
├── hatk.config.ts              # Server configuration
└── hatk.generated.ts           # Auto-generated types from lexicons
```
