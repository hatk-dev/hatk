---
title: Scaffolding
description: Generate code with the Hatk CLI.
---

## Creating a project

Create a new hatk project using the Vite+ template:

```bash
vp create github:hatk-dev/hatk-template-starter
```

You'll be prompted for the target directory name.

See the [Quickstart](/getting-started/quickstart) for prerequisites and setup.

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

Where `<type>` is one of: `feed`, `xrpc`, `label`, `og`.

## `hatk resolve`

Fetch a lexicon schema from the AT Protocol network by its NSID.

```bash
hatk resolve <nsid>
```

Downloads the lexicon JSON and any referenced definitions, saving them to your `lexicons/` directory.
