---
title: CLI Overview
description: All available Hatk CLI commands.
---

The `hatk` CLI manages your entire development workflow — from scaffolding a new project to building for production.

## Getting Started

| Command           | Description               |
| ----------------- | ------------------------- |
| `hatk new <name>` | Create a new hatk project |

## Generators

| Command                          | Description                         |
| -------------------------------- | ----------------------------------- |
| `hatk generate record <nsid>`    | Generate a record lexicon           |
| `hatk generate query <nsid>`     | Generate a query lexicon            |
| `hatk generate procedure <nsid>` | Generate a procedure lexicon        |
| `hatk generate feed <name>`      | Generate a feed generator           |
| `hatk generate xrpc <nsid>`      | Generate an XRPC handler            |
| `hatk generate label <name>`     | Generate a label definition         |
| `hatk generate og <name>`        | Generate an OpenGraph route         |
| `hatk generate types`            | Regenerate TypeScript from lexicons |
| `hatk destroy <type> <name>`     | Remove a generated file             |
| `hatk resolve <nsid>`            | Fetch a lexicon from the network    |

## Development

| Command       | Description                                     |
| ------------- | ----------------------------------------------- |
| `hatk dev`    | Start PDS, seed data, and run server with watch |
| `hatk start`  | Start the server (production mode)              |
| `hatk seed`   | Run seed data against local PDS                 |
| `hatk reset`  | Wipe database and PDS                           |
| `hatk schema` | Print SQLite schema from lexicons                |

## Code Quality

| Command       | Description                        |
| ------------- | ---------------------------------- |
| `hatk test`   | Run all tests                      |
| `hatk check`  | Type-check, lint, and format check |
| `hatk format` | Auto-format code                   |

## Build

| Command      | Description                       |
| ------------ | --------------------------------- |
| `hatk build` | Build the frontend for production |
