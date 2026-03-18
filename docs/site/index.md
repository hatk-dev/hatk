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
  - title: Typed end-to-end
    details: Lexicons generate TypeScript types for records, queries, and feeds. Your editor catches mistakes before your users do.
  - title: SQLite by default
    details: No external database to configure. Data lives in a single file that just works — locally and in production.
  - title: OAuth built-in
    details: AT Protocol auth with session cookies. Login, logout, and viewer resolution with zero setup.
  - title: SvelteKit-first
    details: Full-stack with SSR, remote commands, and typed XRPC calls from a generated client.
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
├── lexicons/                   # AT Protocol schemas (like Prisma models)
├── hatk.config.ts              # Server configuration
└── hatk.generated.ts           # Auto-generated types from lexicons
```
