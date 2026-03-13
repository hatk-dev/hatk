# Switch from config.yaml to hatk.config.ts

## Goal

Replace `config.yaml` with `hatk.config.ts` for type safety, autocompletion, and single-language consistency. No YAML fallback.

## Design

### User-facing config file

```typescript
// hatk.config.ts
import { defineConfig } from 'hatk'

export default defineConfig({
  relay: 'ws://localhost:2583',
  port: 3000,
  database: 'data/hatk.db',
  collections: ['app.bsky.feed.post'],
  backfill: {
    parallelism: 10,
    fullNetwork: false,
  },
})
```

### `defineConfig` helper

Identity function exported from the `hatk` package. Exists solely for type inference:

```typescript
export function defineConfig(config: Partial<HatkConfig>): Partial<HatkConfig> {
  return config
}
```

Takes `Partial<HatkConfig>` so users only specify what they need; defaults fill the rest.

### Loader (`config.ts`)

`loadConfig` becomes async (dynamic import replaces `readFileSync` + YAML parse):

```typescript
export async function loadConfig(configPath?: string): Promise<HatkConfig> {
  const resolved = resolve(configPath || 'hatk.config.ts')
  const configDir = dirname(resolved)
  const mod = await import(resolved)
  const raw: Partial<HatkConfig> = mod.default
  return applyDefaultsAndEnvOverrides(raw, configDir)
}
```

- Relative paths still resolved against the config file's directory.
- Environment variable overrides preserved (essential for container deployments).
- Defaults unchanged from current behavior.

### Environment variable overrides

Same as today. Env vars take precedence over the TS config values:

| Env var | Config field |
|---|---|
| `DATABASE` | `database` |
| `RELAY` | `relay` |
| `DID_PLC_URL` | `plc` |
| `PORT` | `port` |
| `BACKFILL_REPOS` | `backfill.repos` |
| `BACKFILL_FULL_NETWORK` | `backfill.fullNetwork` |
| `BACKFILL_PARALLELISM` | `backfill.parallelism` |
| `BACKFILL_FETCH_TIMEOUT` | `backfill.fetchTimeout` |
| `BACKFILL_MAX_RETRIES` | `backfill.maxRetries` |
| `FTS_REBUILD_INTERVAL` | `ftsRebuildInterval` |
| `OAUTH_ISSUER` | `oauth.issuer` |
| `ADMINS` | `admins` |

## Changes required

### `config.ts`
- Remove `yaml` import and `readFileSync`
- `loadConfig` becomes `async`, uses `await import()` instead of YAML parse
- Add `defineConfig` export
- Input type becomes `Partial<HatkConfig>` (users specify only what they need)

### Callers of `loadConfig` (4 files)
- **`main.ts`** — already async context; change `loadConfig(configPath)` to `await loadConfig(configPath)`, update default from `'config.yaml'` to `'hatk.config.ts'`
- **`cli.ts`** — change `loadConfig(resolve('config.yaml'))` to `await loadConfig(resolve('hatk.config.ts'))` (2 call sites)
- **`test.ts`** — change to `await loadConfig(...)`, update fallback path
- **`vite-plugin.ts`** — update spawned server argument from `'config.yaml'` to `'hatk.config.ts'`

### Package exports
- Export `defineConfig` and `HatkConfig` from the package entry point so users can import them

### Dependencies
- Remove `yaml` from `package.json` dependencies

### Documentation
- Update `docs/site/src/content/docs/getting-started/configuration.mdx` to show TypeScript config instead of YAML

### Migration
- No automatic migration. Clean break from YAML.
- If `hatk.config.ts` is not found at startup, print a clear error message explaining the change.
