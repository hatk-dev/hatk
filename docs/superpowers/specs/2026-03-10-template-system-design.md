# Template System Design

## Context

The `hatk new` command currently scaffolds a bare project with empty directories and core framework lexicons. Users building AT Protocol apps need a way to start from a working example rather than an empty shell. The Statusphere app (from the ATConf workshop) is the first template — a complete working app with custom lexicons, feeds, XRPC handlers, seeds, a Svelte frontend, and tests.

## Design

### CLI Interface

```
hatk new my-app --template statusphere
```

- `--template <name>` selects a bundled template
- Without `--template`, behaves exactly as today (bare scaffold)
- `--svelte` flag is still respected; templates can also declare `"svelte": true` in their manifest

### How It Works

1. **Scaffold first** — run the normal scaffold logic (config.yaml, package.json, docker-compose.yml, Dockerfile, core `dev.hatk.*` lexicons, tsconfig, linting config, .gitignore)
2. **Read manifest** — load `template.json` from the template directory
3. **Apply Svelte** — if manifest declares `"svelte": true`, generate SvelteKit files (same as `--svelte`)
4. **Merge config** — deep-merge template's `config` object into the generated config.yaml
5. **Merge dependencies** — add template's `dependencies` and `devDependencies` to package.json
6. **Copy files** — recursively copy all template files (except template.json) into the project, overwriting scaffold defaults where they overlap
7. **Finalize** — run `npm install`, `hatk generate types`, and `svelte-kit sync` if Svelte

### Template Location

Templates are bundled inside the hatk package at `packages/appview/templates/<name>/`. Discovered by listing directories in `templates/`.

### Template Structure

```
packages/appview/templates/statusphere/
├── template.json
├── lexicons/
│   └── xyz/statusphere/
│       ├── defs.json
│       ├── status.json
│       └── getProfile.json
├── feeds/
│   └── recent.ts
├── xrpc/
│   └── xyz/statusphere/
│       └── getProfile.ts
├── seeds/
│   └── seed.ts
├── test/
│   ├── feeds/
│   │   └── recent.test.ts
│   └── fixtures/
│       ├── _repos.yaml
│       ├── app.bsky.actor.profile.yaml
│       └── xyz.statusphere.status.yaml
└── src/
    ├── routes/
    │   ├── +page.svelte
    │   ├── +layout.svelte
    │   └── oauth/callback/+page.svelte
    ├── lib/
    │   ├── api.ts
    │   ├── auth.ts
    │   └── query.ts
    ├── app.html
    ├── app.css
    └── error.html
```

### template.json Manifest

```json
{
  "description": "Statusphere example app",
  "svelte": true,
  "dependencies": {
    "@tanstack/svelte-query": "^5"
  },
  "config": {
    "oauth": {
      "scope": "atproto repo:xyz.statusphere.status?action=create&action=delete"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Shown in help text / template listing |
| `svelte` | boolean | Auto-enable SvelteKit scaffold |
| `dependencies` | object | Merged into package.json dependencies |
| `devDependencies` | object | Merged into package.json devDependencies |
| `config` | object | Deep-merged into generated config.yaml |

### Files to Modify

- **`packages/appview/src/cli.ts`** — add `--template` flag parsing, template discovery, manifest loading, config merging, dependency merging, file copying
- **`packages/appview/templates/statusphere/`** — new directory with template files copied from exercise 10 (with NSIDs kept as `xyz.statusphere.*`, imports updated to use `hatk/` package names and `hatk.generated.ts`)

### Key Decisions

- Templates are plain file copies — no string interpolation or parameterization
- `xyz.statusphere.*` NSIDs are kept as-is (they're the app's domain, not the framework's)
- Template's config is deep-merged, not replaced — base config (relay, plc, port, database) stays intact
- If a template includes `src/`, it implies Svelte — the manifest's `"svelte": true` ensures the scaffold generates SvelteKit config files before the template's frontend files are copied on top

## Verification

1. Run `hatk new test-app` — should produce bare scaffold as before (no regression)
2. Run `hatk new test-app --template statusphere` — should produce a working Statusphere app
3. `cd test-app && npm install && hatk dev` — app should start and be functional
4. Run `hatk test` — tests should pass
