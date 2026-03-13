# Switch config.yaml to hatk.config.ts — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `config.yaml` with `hatk.config.ts` so users get type safety and autocompletion when configuring hatk.

**Architecture:** Add `defineConfig` identity function for type inference. Rewrite `loadConfig` to use dynamic `import()` instead of YAML parsing. Update all call sites (main.ts, cli.ts, test.ts, vite-plugin.ts) and the `hatk new` scaffolder.

**Tech Stack:** TypeScript, dynamic `import()`, no new dependencies.

**Note:** The `yaml` package stays in dependencies — `test.ts` uses it for loading YAML fixture files in `loadFixtures()`. Only `config.ts` stops using it.

---

### Task 1: Rewrite config.ts — add defineConfig, make loadConfig async

**Files:**
- Modify: `packages/hatk/src/config.ts`

**Step 1: Rewrite config.ts**

Replace the entire file. Remove `readFileSync` and `YAML` imports. Add `defineConfig`. Make `loadConfig` async with `import()`.

```typescript
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'

export interface LabelLocale {
  lang: string
  name: string
  description: string
}

export interface LabelDefinition {
  identifier: string
  severity: 'alert' | 'inform' | 'none'
  blurs: 'media' | 'content' | 'none'
  defaultSetting: 'warn' | 'hide' | 'ignore'
  locales?: LabelLocale[]
}

export interface OAuthClientConfig {
  client_id: string
  client_name: string
  redirect_uris: string[]
  scope?: string
}

export interface OAuthConfig {
  issuer: string
  scopes: string[]
  clients: OAuthClientConfig[]
}

export interface BackfillConfig {
  signalCollections?: string[] // defaults to top-level collections
  repos?: string[] // pin specific DIDs to backfill
  fullNetwork: boolean
  parallelism: number
  fetchTimeout: number // seconds
  maxRetries: number // max retry attempts for failed repos (default 5)
}

export interface HatkConfig {
  relay: string
  plc: string // PLC directory URL for DID resolution
  port: number
  database: string // DuckDB file path (replaces :memory:)
  publicDir: string | null // static file directory (null to disable)
  collections: string[] // optional — auto-derived from lexicons if empty
  backfill: BackfillConfig
  ftsRebuildInterval: number // rebuild FTS index every N writes (lower = fresher search)
  oauth: OAuthConfig | null
  admins: string[] // DIDs allowed to access /admin/* endpoints
}

/** Identity function that provides type inference for hatk config files. */
export function defineConfig(config: Partial<HatkConfig>): Partial<HatkConfig> {
  return config
}

/** Derive HTTP URL from relay WebSocket URL (ws://host → http://host) */
export function relayHttpUrl(relay: string): string {
  return relay.replace(/^ws(s?):\/\//, 'http$1://')
}

export async function loadConfig(configPath: string): Promise<HatkConfig> {
  const resolved = resolve(configPath)

  if (!existsSync(resolved)) {
    console.error(`Config file not found: ${resolved}`)
    console.error(`hatk now uses hatk.config.ts instead of config.yaml.`)
    console.error(`Create a hatk.config.ts file or run 'hatk new' to scaffold a project.`)
    process.exit(1)
  }

  const configDir = dirname(resolved)
  const mod = await import(resolved)
  const parsed: Partial<HatkConfig> & Record<string, any> = mod.default || {}

  const backfillRaw = parsed.backfill || ({} as Partial<BackfillConfig>)
  const env = process.env

  const database = env.DATABASE || parsed.database
  const config: HatkConfig = {
    relay: env.RELAY || parsed.relay || 'ws://localhost:2583',
    plc: env.DID_PLC_URL || parsed.plc || 'https://plc.directory',
    port: parseInt(env.PORT || '') || parsed.port || 3000,
    database: database ? resolve(configDir, database) : ':memory:',
    publicDir: parsed.publicDir === null ? null : resolve(configDir, (parsed as any).public || parsed.publicDir || './public'),
    collections: parsed.collections || [],
    backfill: {
      signalCollections: backfillRaw.signalCollections || undefined,
      repos: env.BACKFILL_REPOS ? env.BACKFILL_REPOS.split(',').map((s) => s.trim()) : backfillRaw.repos || undefined,
      fullNetwork: env.BACKFILL_FULL_NETWORK ? env.BACKFILL_FULL_NETWORK === 'true' : backfillRaw.fullNetwork || false,
      parallelism: parseInt(env.BACKFILL_PARALLELISM || '') || backfillRaw.parallelism || 3,
      fetchTimeout: parseInt(env.BACKFILL_FETCH_TIMEOUT || '') || backfillRaw.fetchTimeout || 300,
      maxRetries: parseInt(env.BACKFILL_MAX_RETRIES || '') || backfillRaw.maxRetries || 5,
    },
    ftsRebuildInterval: parseInt(env.FTS_REBUILD_INTERVAL || '') || parsed.ftsRebuildInterval || 5000,
    oauth: null,
    admins: env.ADMINS ? env.ADMINS.split(',').map((s) => s.trim()) : parsed.admins || [],
  }

  const oauthRaw = parsed.oauth
  if (oauthRaw) {
    config.oauth = {
      issuer: process.env.OAUTH_ISSUER || oauthRaw.issuer || `http://127.0.0.1:${config.port}`,
      scopes: oauthRaw.scopes || ['atproto'],
      clients: oauthRaw.clients || [],
    }
  }

  return config
}
```

**Step 2: Verify the file compiles**

Run: `cd packages/hatk && npx tsc --noEmit src/config.ts`

---

### Task 2: Update main.ts — await loadConfig, change default path

**Files:**
- Modify: `packages/hatk/src/main.ts:34,40`

**Step 1: Update the config path default and await loadConfig**

Change line 34 from:
```typescript
const configPath = process.argv[2] || 'config.yaml'
```
to:
```typescript
const configPath = process.argv[2] || 'hatk.config.ts'
```

Change line 40 from:
```typescript
const config = loadConfig(configPath)
```
to:
```typescript
const config = await loadConfig(configPath)
```

**Step 2: Verify it compiles**

Run: `cd packages/hatk && npx tsc --noEmit src/main.ts`

---

### Task 3: Update cli.ts — all config.yaml references to hatk.config.ts, await loadConfig

**Files:**
- Modify: `packages/hatk/src/cli.ts`

There are 8 references to `config.yaml` in cli.ts. Change all of them:

**Step 1: Update `hatk new` scaffolder (line 378)**

Change the file creation from writing `config.yaml` to writing `hatk.config.ts`:

```typescript
  writeFileSync(
    join(dir, 'hatk.config.ts'),
    `import { defineConfig } from 'hatk'

export default defineConfig({
  relay: 'ws://localhost:2583',
  plc: 'http://localhost:2582',
  port: 3000,
  database: 'data/hatk.db',
  admins: [],
  backfill: {
    parallelism: 10,
  },
})
`,
  )
```

**Step 2: Update Dockerfile template (line 988)**

Change:
```
CMD ["node", "--max-old-space-size=512", "node_modules/@hatk/hatk/dist/main.js", "config.yaml"]
```
to:
```
CMD ["node", "--max-old-space-size=512", "node_modules/@hatk/hatk/dist/main.js", "hatk.config.ts"]
```

**Step 3: Update scaffolding output message (line 1297)**

Change:
```typescript
  console.log(`  config.yaml`)
```
to:
```typescript
  console.log(`  hatk.config.ts`)
```

**Step 4: Update `hatk dev` command (line 1740)**

Change:
```typescript
      execSync(`npx tsx ${mainPath} config.yaml`, {
```
to:
```typescript
      execSync(`npx tsx ${mainPath} hatk.config.ts`, {
```

**Step 5: Update `hatk reset` command (line 1763)**

Change:
```typescript
  const config = loadConfig(resolve('config.yaml'))
```
to:
```typescript
  const config = await loadConfig(resolve('hatk.config.ts'))
```

**Step 6: Update `hatk schema` command (line 1925)**

Change:
```typescript
  const config = loadConfig(resolve('config.yaml'))
```
to:
```typescript
  const config = await loadConfig(resolve('hatk.config.ts'))
```

**Step 7: Update `hatk start` command (line 1963)**

Change:
```typescript
    execSync(`npx tsx ${mainPath} config.yaml`, { stdio: 'inherit', cwd: process.cwd() })
```
to:
```typescript
    execSync(`npx tsx ${mainPath} hatk.config.ts`, { stdio: 'inherit', cwd: process.cwd() })
```

**Step 8: Verify it compiles**

Run: `cd packages/hatk && npx tsc --noEmit src/cli.ts`

---

### Task 4: Update test.ts — await loadConfig, change default path

**Files:**
- Modify: `packages/hatk/src/test.ts:54-74`

**Step 1: Update findConfigPath to look for hatk.config.ts**

Change lines 57-61 from:
```typescript
function findConfigPath(): string {
  const explicit = process.env.APPVIEW_CONFIG
  if (explicit) return resolve(explicit)
  return resolve('config.yaml')
}
```
to:
```typescript
function findConfigPath(): string {
  const explicit = process.env.APPVIEW_CONFIG
  if (explicit) return resolve(explicit)
  return resolve('hatk.config.ts')
}
```

**Step 2: Update createTestContext to await loadConfig**

Change line 74 from:
```typescript
  const config = loadConfig(configPath)
```
to:
```typescript
  const config = await loadConfig(configPath)
```

**Step 3: Verify it compiles**

Run: `cd packages/hatk && npx tsc --noEmit src/test.ts`

---

### Task 5: Update vite-plugin.ts — change spawned server argument

**Files:**
- Modify: `packages/hatk/src/vite-plugin.ts:71`

**Step 1: Change config.yaml to hatk.config.ts**

Change line 71 from:
```typescript
      serverProcess = spawn('npx', ['tsx', 'watch', ...watchArgs, mainPath, 'config.yaml'], {
```
to:
```typescript
      serverProcess = spawn('npx', ['tsx', 'watch', ...watchArgs, mainPath, 'hatk.config.ts'], {
```

**Step 2: Verify it compiles**

Run: `cd packages/hatk && npx tsc --noEmit src/vite-plugin.ts`

---

### Task 6: Add package export for defineConfig and HatkConfig

**Files:**
- Modify: `packages/hatk/package.json`

**Step 1: Add config export to package.json exports field**

Add this entry to the `"exports"` object:
```json
    "./config": "./dist/config.js",
```

This allows users to write `import { defineConfig } from 'hatk/config'` (or the package could also re-export from a root entry if one exists).

**Note:** Since the package name is `@hatk/hatk` and users write `import { defineConfig } from 'hatk'` (which is a different package or alias), check how the project resolves this. The scaffolded `hatk.config.ts` uses `from 'hatk'` — if `hatk` is an alias for `@hatk/hatk`, the export should work. If not, the import path in the scaffold template may need to be `from '@hatk/hatk/config'`.

---

### Task 7: Update documentation

**Files:**
- Modify: `docs/site/src/content/docs/getting-started/configuration.mdx`

**Step 1: Rewrite the docs page for TypeScript config**

Replace the entire file with TypeScript-based configuration documentation. Change the YAML example to a TypeScript `defineConfig()` example. Update the frontmatter description. Keep all the options reference (relay, plc, port, database, etc.) and env var documentation intact.

Key changes:
- Title/description: reference `hatk.config.ts` instead of `config.yaml`
- Complete example: TypeScript with `defineConfig()` instead of YAML
- All option docs stay the same, just the format changes

---

### Task 8: Full build verification

**Step 1: Run full TypeScript check**

Run: `cd packages/hatk && npx tsc --noEmit`
Expected: No errors.

**Step 2: Search for any remaining config.yaml references**

Run: `grep -r "config\.yaml" packages/hatk/src/`
Expected: No results (test.ts still uses YAML for fixtures but doesn't reference `config.yaml` as a filename).

**Step 3: Verify the build**

Run: `cd packages/hatk && npm run build`
Expected: Clean build, dist/ output.
