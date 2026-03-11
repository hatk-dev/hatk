# Template System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--template` flag to `hatk new` so users can scaffold from bundled starter apps (starting with statusphere).

**Architecture:** Templates are directories in `packages/appview/templates/<name>/` with a `template.json` manifest. The `hatk new` command runs the normal scaffold first, then overlays template files on top, merging config and dependencies from the manifest.

**Tech Stack:** Node.js fs APIs, YAML (already a dependency), JSON deep merge

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `packages/appview/src/cli.ts` | Modify | Add `--template` flag parsing, template loading, overlay logic |
| `packages/appview/templates/statusphere/template.json` | Create | Template manifest |
| `packages/appview/templates/statusphere/lexicons/` | Create | Custom lexicon schemas |
| `packages/appview/templates/statusphere/feeds/recent.ts` | Create | Feed generator |
| `packages/appview/templates/statusphere/xrpc/xyz/statusphere/getProfile.ts` | Create | XRPC handler |
| `packages/appview/templates/statusphere/seeds/seed.ts` | Create | Seed data |
| `packages/appview/templates/statusphere/test/` | Create | Tests + fixtures |
| `packages/appview/templates/statusphere/src/` | Create | SvelteKit frontend |

---

## Chunk 1: Template Infrastructure in CLI

### Task 1: Add --template flag parsing and usage text

**Files:**
- Modify: `packages/appview/src/cli.ts:39-77` (usage function)
- Modify: `packages/appview/src/cli.ts:307-315` (new command args)

- [ ] **Step 1: Update usage text**

In `usage()` (line 41), change:
```
    new <name> [--svelte]                  Create a new hatk project
```
to:
```
    new <name> [--svelte] [--template <t>] Create a new hatk project
```

- [ ] **Step 2: Parse --template flag**

After line 314 (`const withSvelte = args.includes('--svelte')`), add:
```typescript
  const templateIdx = args.indexOf('--template')
  const templateName = templateIdx !== -1 ? args[templateIdx + 1] : null
  if (templateIdx !== -1 && !templateName) {
    console.error('Usage: hatk new <name> --template <template-name>')
    process.exit(1)
  }
```

- [ ] **Step 3: Validate template exists**

After the template parsing, add:
```typescript
  let template: { description?: string; svelte?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; config?: Record<string, any> } | null = null
  let templateDir: string | null = null
  if (templateName) {
    templateDir = join(import.meta.dirname, '..', 'templates', templateName)
    if (!existsSync(templateDir)) {
      const available = readdirSync(join(import.meta.dirname, '..', 'templates')).filter(f => existsSync(join(import.meta.dirname, '..', 'templates', f, 'template.json')))
      console.error(`Unknown template: ${templateName}`)
      if (available.length) console.error(`Available templates: ${available.join(', ')}`)
      process.exit(1)
    }
    template = JSON.parse(readFileSync(join(templateDir, 'template.json'), 'utf-8'))
  }
```

- [ ] **Step 4: Add readFileSync to imports**

At line 2, add `readFileSync` to the existing import:
```typescript
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync, readFileSync, cpSync } from 'node:fs'
```

- [ ] **Step 5: Make template's svelte flag apply**

Change `const withSvelte = args.includes('--svelte')` to:
```typescript
  const withSvelte = args.includes('--svelte') || template?.svelte === true
```

Note: this line must come AFTER the template parsing, so move the `--svelte` check down.

- [ ] **Step 6: Commit**

```bash
git add packages/appview/src/cli.ts
git commit -m "feat: add --template flag parsing to hatk new"
```

---

### Task 2: Add template overlay logic

**Files:**
- Modify: `packages/appview/src/cli.ts` (after scaffold, before `execSync('npx hatk generate types'...)`)

- [ ] **Step 1: Add overlay logic before the final type generation**

Before line 1199 (`execSync('npx hatk generate types'...)`), add:
```typescript
  // Apply template overlay
  if (template && templateDir) {
    // Merge dependencies into package.json
    if (template.dependencies || template.devDependencies) {
      const pkgPath = join(dir, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (template.dependencies) Object.assign(pkg.dependencies, template.dependencies)
      if (template.devDependencies) Object.assign(pkg.devDependencies, template.devDependencies)
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    }

    // Merge config into config.yaml
    if (template.config) {
      const configPath = join(dir, 'config.yaml')
      const { parse, stringify } = await import('yaml')
      const config = parse(readFileSync(configPath, 'utf-8'))
      deepMerge(config, template.config)
      writeFileSync(configPath, stringify(config))
    }

    // Copy template files (skip template.json)
    const entries = readdirSync(templateDir)
    for (const entry of entries) {
      if (entry === 'template.json') continue
      cpSync(join(templateDir, entry), join(dir, entry), { recursive: true, force: true })
    }
  }
```

- [ ] **Step 2: Add deepMerge helper**

Add before the `usage()` function (around line 38):
```typescript
function deepMerge(target: Record<string, any>, source: Record<string, any>): void {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], source[key])
    } else {
      target[key] = source[key]
    }
  }
}
```

- [ ] **Step 3: Add cpSync to imports**

Ensure `cpSync` is in the import on line 2 (should already be there from Step 4 of Task 1).

- [ ] **Step 4: Commit**

```bash
git add packages/appview/src/cli.ts
git commit -m "feat: add template overlay logic (config merge, deps merge, file copy)"
```

---

## Chunk 2: Statusphere Template Files

### Task 3: Create template manifest and lexicons

**Files:**
- Create: `packages/appview/templates/statusphere/template.json`
- Create: `packages/appview/templates/statusphere/lexicons/xyz/statusphere/defs.json`
- Create: `packages/appview/templates/statusphere/lexicons/xyz/statusphere/status.json`
- Create: `packages/appview/templates/statusphere/lexicons/xyz/statusphere/getProfile.json`
- Create: `packages/appview/templates/statusphere/lexicons/app/bsky/actor/profile.json`

- [ ] **Step 1: Create template.json**

```json
{
  "description": "Statusphere example app",
  "svelte": true,
  "dependencies": {
    "@tanstack/svelte-query": "^5"
  },
  "config": {
    "oauth": {
      "scopes": [
        "atproto",
        "repo:xyz.statusphere.status?action=create&action=delete"
      ],
      "clients": [
        {
          "client_id": "http://127.0.0.1:3000/oauth-client-metadata.json",
          "client_name": "statusphere",
          "scope": "atproto repo:xyz.statusphere.status?action=create&action=delete",
          "redirect_uris": ["http://127.0.0.1:3000/oauth/callback"]
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Create lexicon files**

Copy the following from exercise 10 as-is (NSIDs stay as `xyz.statusphere.*`):
- `lexicons/xyz/statusphere/defs.json` — profileView and statusView definitions
- `lexicons/xyz/statusphere/status.json` — status record schema
- `lexicons/xyz/statusphere/getProfile.json` — getProfile query
- `lexicons/app/bsky/actor/profile.json` — Bluesky profile record

- [ ] **Step 3: Commit**

```bash
git add packages/appview/templates/statusphere/
git commit -m "feat: add statusphere template manifest and lexicons"
```

---

### Task 4: Create template backend files

**Files:**
- Create: `packages/appview/templates/statusphere/feeds/recent.ts`
- Create: `packages/appview/templates/statusphere/xrpc/xyz/statusphere/getProfile.ts`
- Create: `packages/appview/templates/statusphere/seeds/seed.ts`

- [ ] **Step 1: Create feeds/recent.ts**

Copy from exercise 10 but update imports: `'../appview.generated.ts'` → `'../hatk.generated.ts'`

```typescript
import { defineFeed, views, type Status, type Profile, type HydrateContext } from '../hatk.generated.ts'

export default defineFeed({
  collection: 'xyz.statusphere.status',
  label: 'Recent',

  hydrate: (ctx) => hydrateStatuses(ctx),

  async generate(ctx) {
    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      `SELECT uri, cid, indexed_at FROM "xyz.statusphere.status"`,
    )

    return ctx.ok({ uris: rows.map((r) => r.uri), cursor })
  },
})

async function hydrateStatuses(ctx: HydrateContext<Status>) {
  const dids = [...new Set(ctx.items.map((item) => item.did).filter(Boolean))]
  const profiles = await ctx.lookup<Profile>('app.bsky.actor.profile', 'did', dids)

  return ctx.items.map((item) => {
    const author = profiles.get(item.did)
    return views.statusView({
      uri: item.uri,
      status: item.value.status,
      createdAt: item.value.createdAt,
      indexedAt: item.indexed_at,
      author: views.profileView({
        did: item.did,
        handle: item.handle || item.did,
        displayName: author?.value.displayName,
        avatar: author ? ctx.blobUrl(author.did, author.value.avatar, 'avatar') : undefined,
      }),
    })
  })
}
```

- [ ] **Step 2: Create xrpc/xyz/statusphere/getProfile.ts**

Copy from exercise 10 but update imports: `'../../../appview.generated.ts'` → `'../../../hatk.generated.ts'`

```typescript
import { defineQuery, views, type Profile } from '../../../hatk.generated.ts'

export default defineQuery('xyz.statusphere.getProfile', async (ctx) => {
  const { ok, params, lookup, blobUrl } = ctx
  const actor = params.actor as string

  const profiles = await lookup<Profile>('app.bsky.actor.profile', 'did', [actor])
  const profile = profiles.get(actor)

  if (!profile) {
    return ok(views.profileView({ did: actor, handle: actor }))
  }

  return ok(views.profileView({
    did: actor,
    handle: profile.handle || actor,
    displayName: profile.value.displayName,
    description: profile.value.description,
    avatar: blobUrl(profile.did, profile.value.avatar, 'avatar'),
  }))
})
```

- [ ] **Step 3: Create seeds/seed.ts**

Copy from exercise 10 but update import: `'../appview.generated.ts'` → `'../hatk.generated.ts'`

```typescript
import { seed } from '../hatk.generated.ts'

const { createAccount, createRecord } = seed()

const alice = await createAccount('alice.test')
const bob = await createAccount('bob.test')
const carol = await createAccount('carol.test')

await createRecord(alice, 'app.bsky.actor.profile', {
  displayName: 'Alice',
  description: 'Emoji enthusiast',
}, { rkey: 'self' })

await createRecord(bob, 'app.bsky.actor.profile', {
  displayName: 'Bob',
  description: 'Coffee lover',
}, { rkey: 'self' })

await createRecord(carol, 'app.bsky.actor.profile', {
  displayName: 'Carol',
  description: 'Butterfly chaser',
}, { rkey: 'self' })

const now = Date.now()
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()

await createRecord(alice, 'xyz.statusphere.status', {
  status: '🚀',
  createdAt: ago(5),
}, { rkey: 'alice-1' })

await createRecord(alice, 'xyz.statusphere.status', {
  status: '😎',
  createdAt: ago(60),
}, { rkey: 'alice-2' })

await createRecord(bob, 'xyz.statusphere.status', {
  status: '🧑‍💻',
  createdAt: ago(10),
}, { rkey: 'bob-1' })

await createRecord(bob, 'xyz.statusphere.status', {
  status: '☕',
  createdAt: ago(120),
}, { rkey: 'bob-2' })

await createRecord(carol, 'xyz.statusphere.status', {
  status: '🦋',
  createdAt: ago(15),
}, { rkey: 'carol-1' })

await createRecord(carol, 'xyz.statusphere.status', {
  status: '💙',
  createdAt: ago(90),
}, { rkey: 'carol-2' })

console.log('\n[seed] Done!')
```

- [ ] **Step 4: Commit**

```bash
git add packages/appview/templates/statusphere/
git commit -m "feat: add statusphere template backend files"
```

---

### Task 5: Create template test files

**Files:**
- Create: `packages/appview/templates/statusphere/test/feeds/recent.test.ts`
- Create: `packages/appview/templates/statusphere/test/fixtures/_repos.yaml`
- Create: `packages/appview/templates/statusphere/test/fixtures/app.bsky.actor.profile.yaml`
- Create: `packages/appview/templates/statusphere/test/fixtures/xyz.statusphere.status.yaml`

- [ ] **Step 1: Create test/feeds/recent.test.ts**

Copy from exercise 10 but update import: `'appview/test'` → `'hatk/test'`

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestContext } from 'hatk/test'

let ctx: Awaited<ReturnType<typeof createTestContext>>

beforeAll(async () => {
  ctx = await createTestContext()
  await ctx.loadFixtures()
})

afterAll(async () => ctx?.close())

describe('recent feed', () => {
  test('returns all statuses', async () => {
    const feed = ctx.loadFeed('recent')
    const result = await feed.generate(ctx.feedContext({ limit: 10 }))
    expect(result.items).toHaveLength(6)
  })

  test('each item has required fields', async () => {
    const feed = ctx.loadFeed('recent')
    const result = await feed.generate(ctx.feedContext({ limit: 10 }))
    for (const item of result.items as any[]) {
      expect(item.uri).toMatch(/^at:\/\//)
      expect(item.status).toBeDefined()
      expect(item.createdAt).toBeDefined()
      expect(item.author).toBeDefined()
      expect(item.author.did).toBeDefined()
      expect(item.author.handle).toBeDefined()
    }
  })

  test('includes displayName from profile', async () => {
    const feed = ctx.loadFeed('recent')
    const result = await feed.generate(ctx.feedContext({ limit: 10 }))
    const aliceStatus = (result.items as any[]).find((s) => s.author.handle === 'alice.test')
    expect(aliceStatus?.author.displayName).toBe('Alice')
  })

  test('respects limit', async () => {
    const feed = ctx.loadFeed('recent')
    const result = await feed.generate(ctx.feedContext({ limit: 2 }))
    expect(result.items).toHaveLength(2)
    expect(result.cursor).toBeDefined()
  })

  test('cursor pagination returns next page', async () => {
    const feed = ctx.loadFeed('recent')
    const page1 = await feed.generate(ctx.feedContext({ limit: 3 }))
    expect(page1.items).toHaveLength(3)
    expect(page1.cursor).toBeDefined()

    const page2 = await feed.generate(ctx.feedContext({ limit: 3, cursor: page1.cursor }))
    expect(page2.items).toHaveLength(3)
    expect(page2.cursor).toBeUndefined()

    const allUris = [...(page1.items as any[]), ...(page2.items as any[])].map((s) => s.uri)
    expect(new Set(allUris).size).toBe(6)
  })

  test('returns no cursor when all results fit', async () => {
    const feed = ctx.loadFeed('recent')
    const result = await feed.generate(ctx.feedContext({ limit: 30 }))
    expect(result.items).toHaveLength(6)
    expect(result.cursor).toBeUndefined()
  })
})
```

- [ ] **Step 2: Create fixture YAML files**

Copy from exercise 10 as-is:
- `test/fixtures/_repos.yaml`
- `test/fixtures/app.bsky.actor.profile.yaml`
- `test/fixtures/xyz.statusphere.status.yaml`

- [ ] **Step 3: Commit**

```bash
git add packages/appview/templates/statusphere/test/
git commit -m "feat: add statusphere template test files and fixtures"
```

---

### Task 6: Create template frontend files

**Files:**
- Create: `packages/appview/templates/statusphere/src/routes/+page.svelte`
- Create: `packages/appview/templates/statusphere/src/routes/+layout.svelte`
- Create: `packages/appview/templates/statusphere/src/routes/oauth/callback/+page.svelte`
- Create: `packages/appview/templates/statusphere/src/lib/api.ts`
- Create: `packages/appview/templates/statusphere/src/lib/auth.ts`
- Create: `packages/appview/templates/statusphere/src/lib/query.ts`
- Create: `packages/appview/templates/statusphere/src/app.html`
- Create: `packages/appview/templates/statusphere/src/app.css`
- Create: `packages/appview/templates/statusphere/src/error.html`

- [ ] **Step 1: Create frontend files**

Copy from exercise 10 with these updates:
- `src/lib/api.ts`: `'appview/xrpc-client'` → `'hatk/xrpc-client'`, `'$appview'` → `'$hatk'`
- `src/lib/auth.ts`: `'@appview/oauth-client'` → `'@hatk/oauth-client'`
- `src/routes/+page.svelte`: `'xyz.appview.getFeed'` → `'dev.hatk.getFeed'`, `'xyz.appview.createRecord'` → `'dev.hatk.createRecord'`, `'xyz.appview.deleteRecord'` → `'dev.hatk.deleteRecord'`, `'$appview'` → `'$hatk'`
- `src/routes/+layout.svelte`: no changes needed (already uses `$lib/` imports)
- `src/app.html`: title stays as `Statusphere`
- `src/app.css`: use the statusphere styling (with `--primary: #6366f1` instead of default teal)
- `src/error.html`: title reference stays as statusphere

- [ ] **Step 2: Commit**

```bash
git add packages/appview/templates/statusphere/src/
git commit -m "feat: add statusphere template frontend files"
```

---

## Chunk 3: Verification

### Task 7: Manual verification

- [ ] **Step 1: Test bare scaffold still works**

```bash
cd /tmp && npx /Users/chadmiller/code/hatk/packages/appview/src/cli.ts new test-bare
```

Verify: directory created with standard scaffold, no template files.

- [ ] **Step 2: Test statusphere template**

```bash
cd /tmp && npx /Users/chadmiller/code/hatk/packages/appview/src/cli.ts new test-statusphere --template statusphere
```

Verify:
- Has config.yaml with OAuth settings merged in
- Has custom lexicons under `lexicons/xyz/statusphere/`
- Has `feeds/recent.ts`, `xrpc/xyz/statusphere/getProfile.ts`, `seeds/seed.ts`
- Has test files and fixtures
- Has SvelteKit frontend files in `src/`
- `package.json` includes `@tanstack/svelte-query` dependency
- `hatk.generated.ts` includes StatusView and ProfileView types

- [ ] **Step 3: Test invalid template name**

```bash
cd /tmp && npx /Users/chadmiller/code/hatk/packages/appview/src/cli.ts new test-bad --template nonexistent
```

Verify: error message listing available templates.

- [ ] **Step 4: Clean up**

```bash
rm -rf /tmp/test-bare /tmp/test-statusphere /tmp/test-bad
```
