---
title: Seeds
description: Create test data for local development.
---

Seeds populate your local PDS with test accounts and records during development. They live at `seeds/seed.ts` and use the generated `seed()` helper.

## Minimal example

```typescript
import { seed } from '$hatk'

const { createAccount, createRecord } = seed()

const alice = await createAccount('alice.test')

await createRecord(alice, 'app.bsky.actor.profile', {
  displayName: 'Alice',
  description: 'Test user',
}, { rkey: 'self' })

await createRecord(alice, 'xyz.statusphere.status', {
  status: '🚀',
  createdAt: new Date().toISOString(),
})
```

Seeds run automatically during `hatk dev` after the PDS starts. You can also run them manually:

```bash
hatk seed       # run seeds/seed.ts
hatk reset      # wipe all data and re-seed from scratch
```

## Complete seed file

A more realistic seed file creates multiple accounts, uploads images, creates follows, and staggers timestamps so time-based feeds have data to work with:

```typescript
import { seed } from '$hatk'

const { createAccount, createRecord, uploadBlob } = seed()

const alice = await createAccount('alice.test')
const bob = await createAccount('bob.test')
const carol = await createAccount('carol.test')

// Stagger records over the last hour
const now = Date.now()
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()

// Profile with an avatar (upload returns a blob ref)
const aliceAvatar = await uploadBlob(alice, './seeds/images/alice.png')
await createRecord(
  alice,
  'app.bsky.actor.profile',
  {
    displayName: 'Alice',
    description: 'Indie and alt-pop listener',
    avatar: aliceAvatar,
  },
  { rkey: 'self' },
)

// Follows — Alice follows Bob and Carol
await createRecord(
  alice,
  'app.bsky.graph.follow',
  { subject: bob.did, createdAt: new Date().toISOString() },
  { rkey: 'bob' },
)
await createRecord(
  alice,
  'app.bsky.graph.follow',
  { subject: carol.did, createdAt: new Date().toISOString() },
  { rkey: 'carol' },
)

// App records with staggered timestamps
await createRecord(
  alice,
  'fm.teal.alpha.feed.play',
  {
    trackName: 'Blinding Lights',
    artists: [{ artistName: 'The Weeknd' }],
    releaseName: 'After Hours',
    playedTime: ago(50),
  },
  { rkey: 'blinding-lights' },
)

await createRecord(
  bob,
  'fm.teal.alpha.feed.play',
  {
    trackName: 'HUMBLE.',
    artists: [{ artistName: 'Kendrick Lamar' }],
    releaseName: 'DAMN.',
    playedTime: ago(30),
  },
  { rkey: 'humble' },
)

console.log('\n[seed] Done!')
```

## `seed()` helpers

| Function | Description |
| --- | --- |
| `createAccount(handle)` | Create a test account on the local PDS. Returns `{ did, handle }` |
| `createRecord(account, collection, record, opts?)` | Create a record. Pass `{ rkey }` in opts for a specific record key |
| `uploadBlob(account, filePath)` | Upload a file and return a blob reference for use in records |

Records are validated against your project's lexicons before being written, so you get errors at seed time if the data doesn't match your schema.

## Tips

- Use `{ rkey: 'self' }` for singleton records like profiles
- Place test images in `seeds/images/`
- Use the `ago` helper pattern to spread records across time for testing feeds and cursors
- `createAccount` reuses an existing account if the handle already exists, so re-running seeds is safe
