---
title: Scaffolding
description: Create projects and generate code with the Hatk CLI.
---

## `hatk new`

Create a new Hatk project with the standard directory structure.

```bash
hatk new <name> [--svelte]
```

| Option     | Description                                               |
| ---------- | --------------------------------------------------------- |
| `<name>`   | Project directory name (required)                         |
| `--svelte` | Include a Svelte frontend with `src/routes` and `src/lib` |

The command creates the project directory with `config.yaml`, `lexicons/`, `feeds/`, `xrpc/`, `labels/`, `jobs/`, `og/`, `seeds/`, `public/`, `test/`, and the core framework lexicons under `lexicons/dev/hatk/`.

## `hatk generate`

Generate lexicons, handlers, and other project files.

### Lexicons

```bash
hatk generate record <nsid>     # Record schema (e.g. fm.teal.alpha.feed.play)
hatk generate query <nsid>      # Query endpoint (GET)
hatk generate procedure <nsid>  # Procedure endpoint (POST)
```

Creates a JSON lexicon file at `lexicons/<nsid-as-path>.json` with the appropriate schema template and automatically regenerates TypeScript types.

### Handlers

```bash
hatk generate feed <name>       # Feed generator in feeds/
hatk generate xrpc <nsid>       # XRPC handler in xrpc/
hatk generate label <name>      # Label definition in labels/
hatk generate og <name>         # OpenGraph image route in og/
hatk generate job <name>        # Periodic job in jobs/
```

Each generator creates the handler file and a corresponding test file in the `test/` directory.

### Types

```bash
hatk generate types
```

Regenerate `hatk.generated.ts` from your current lexicon schemas. This runs automatically when generating new lexicons.

## `hatk destroy`

Remove a previously generated file and its test.

```bash
hatk destroy <type> <name>
```

Where `<type>` is one of: `feed`, `xrpc`, `label`, `og`, `job`.

## `hatk resolve`

Fetch a lexicon schema from the AT Protocol network by its NSID.

```bash
hatk resolve <nsid>
```

Downloads the lexicon JSON and any referenced definitions, saving them to your `lexicons/` directory.
