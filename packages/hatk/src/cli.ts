#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { execSync, spawn } from 'node:child_process'
import { loadLexicons, discoverCollections, buildSchemas } from './database/schema.ts'
import { loadConfig } from './config.ts'

const args = process.argv.slice(2)
const command = args[0]

async function ensurePds() {
  if (!existsSync(resolve('docker-compose.yml'))) return
  // Check if PDS is already healthy
  try {
    const res = await fetch('http://localhost:2583/xrpc/_health')
    if (res.ok) return
  } catch {}
  // Start it
  console.log('[dev] starting PDS...')
  execSync('docker compose up -d', { stdio: 'inherit', cwd: process.cwd() })
  // Wait for health
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://localhost:2583/xrpc/_health')
      if (res.ok) {
        console.log('[dev] PDS ready')
        return
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.error('[dev] PDS failed to start')
  process.exit(1)
}

/** Spawn a long-running process and forward SIGINT/SIGTERM for clean shutdown. */
function spawnForward(cmd: string, args: string[], env?: Record<string, string | undefined>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    })
    const onSignal = (sig: NodeJS.Signals) => {
      child.kill(sig)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      if (signal === 'SIGINT' || signal === 'SIGTERM') process.exit(0)
      if (code === 0 || code === null) resolve()
      else reject(new Error(`Process exited with code ${code}`))
    })
  })
}

function runSeed() {
  const seedFile = resolve('seeds/seed.ts')
  if (!existsSync(seedFile)) return
  execSync(`npx tsx ${seedFile}`, { stdio: 'inherit', cwd: process.cwd() })
}

function usage() {
  console.log(`
  Usage: hatk <command> [options]

  Getting Started
    new <name> [--svelte] [--duckdb] [--template <t>] Create a new hatk project

  Running
    start                                  Start the hatk server
    dev                                    Start PDS, seed, and run hatk
    seed                                   Seed local PDS with fixture data
    reset                                  Reset database and PDS for a clean slate
    schema                                 Show database schema from lexicons

  Code Quality
    check                                  Type-check and lint the project
    format                                 Format code with oxfmt
    test [--unit|--integration|--browser]   Run tests

  Build
    build                                  Build the frontend for production

  Generators
    generate record <nsid>                 Generate a record lexicon
    generate query <nsid>                  Generate a query lexicon
    generate procedure <nsid>              Generate a procedure lexicon
    generate feed <name>                   Generate a feed generator
    generate xrpc <nsid>                   Generate an XRPC handler
    generate label <name>                  Generate a label definition
    generate og <name>                     Generate an OpenGraph route
    generate hook <name>                   Generate a lifecycle hook
    generate setup <name>                  Generate a setup script
    generate types                         Regenerate TypeScript types from lexicons
    destroy <type> <name>                  Remove a generated file

  Registry
    resolve <nsid>                         Fetch a lexicon and its refs from the network
`)
  process.exit(1)
}

if (!command) usage()

// --- Templates ---

const templates: Record<string, (name: string) => string> = {
  feed: (name) => `import { defineFeed } from '../hatk.generated.ts'

export default defineFeed({
  collection: 'your.collection.here',
  label: '${name.charAt(0).toUpperCase() + name.slice(1)}',

  async generate(ctx) {
    const { rows, cursor } = await ctx.paginate<{ uri: string }>(
      \`SELECT uri, cid, indexed_at FROM "your.collection.here"\`,
    )

    return ctx.ok({ uris: rows.map((r) => r.uri), cursor })
  },
})
`,
  xrpc: (name) => `import { defineQuery } from '../hatk.generated.ts'

export default defineQuery('${name}', async (ctx) => {
  const { ok, db, params, packCursor, unpackCursor } = ctx
  const limit = params.limit ?? 30
  const cursor = params.cursor

  const conditions: string[] = []
  const sqlParams: (string | number)[] = []
  let paramIdx = 1

  if (cursor) {
    const parsed = unpackCursor(cursor)
    if (parsed) {
      conditions.push(\`(s.indexed_at < $\${paramIdx} OR (s.indexed_at = $\${paramIdx + 1} AND s.cid < $\${paramIdx + 2}))\`)
      sqlParams.push(parsed.primary, parsed.primary, parsed.cid)
      paramIdx += 3
    }
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const rows = await db.query(
    \`SELECT s.* FROM "your.collection.here" s \${where} ORDER BY s.indexed_at DESC, s.cid DESC LIMIT $\${paramIdx}\`,
    sqlParams.concat([limit + 1]),
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  const lastRow = rows[rows.length - 1]

  return ok({
    items: rows,
    cursor: hasMore && lastRow ? packCursor(lastRow.indexed_at, lastRow.cid) : undefined,
  })
})
`,
  label: (name) => `import type { LabelRuleContext } from '@hatk/hatk/labels'

export default {
  definition: {
    identifier: '${name}',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'warn',
    locales: [{ lang: 'en', name: '${name.charAt(0).toUpperCase() + name.slice(1)}', description: 'Description here' }],
  },
  async evaluate(ctx: LabelRuleContext) {
    // Return array of label identifiers to apply, or empty array
    return []
  },
}
`,
  og: (name) => `import type { OpengraphContext, OpengraphResult } from '@hatk/hatk/opengraph'

export default {
  path: '/og/${name}/:id',
  async generate(ctx: OpengraphContext): Promise<OpengraphResult> {
    const { db, params } = ctx
    return {
      element: {
        type: 'div',
        props: {
          style: { display: 'flex', width: '100%', height: '100%', background: '#080b12', color: 'white', alignItems: 'center', justifyContent: 'center' },
          children: params.id,
        },
      },
    }
  },
}
`,
  hook: (name) => `import { defineHook } from '../hatk.generated.ts'

export default defineHook('${name}', async (ctx) => {
  // Hook logic here
})
`,
  setup: (_name) => `import { defineSetup } from '../hatk.generated.ts'

export default defineSetup(async (ctx) => {
  // Setup logic here — runs before the server starts
})
`,
}

const testTemplates: Record<string, (name: string) => string> = {
  feed: (name) => `import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestContext } from '@hatk/hatk/test'

let ctx: Awaited<ReturnType<typeof createTestContext>>

beforeAll(async () => {
  ctx = await createTestContext()
  await ctx.loadFixtures()
})

afterAll(async () => ctx?.close())

describe('${name} feed', () => {
  test('returns results', async () => {
    const feed = ctx.loadFeed('${name}')
    const result = await feed.generate(ctx.feedContext({ limit: 10 }))
    expect(result).toBeDefined()
  })
})
`,
  xrpc: (name) => `import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestContext } from '@hatk/hatk/test'

let ctx: Awaited<ReturnType<typeof createTestContext>>

beforeAll(async () => {
  ctx = await createTestContext()
  await ctx.loadFixtures()
})

afterAll(async () => ctx?.close())

describe('${name}', () => {
  test('returns response', async () => {
    const handler = ctx.loadXrpc('${name}')
    const result = await handler.handler({ params: {} })
    expect(result).toBeDefined()
  })
})
`,
}

const lexiconTemplates: Record<string, (nsid: string) => object> = {
  record: (nsid) => ({
    lexicon: 1,
    id: nsid,
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        description: `A ${nsid.split('.').pop()} record.`,
        record: {
          type: 'object',
          required: ['createdAt'],
          properties: {
            createdAt: { type: 'string', format: 'datetime' },
          },
        },
      },
    },
  }),
  query: (nsid) => ({
    lexicon: 1,
    id: nsid,
    defs: {
      main: {
        type: 'query',
        description: `${nsid.split('.').pop()} query.`,
        parameters: {
          type: 'params',
          properties: {},
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {},
          },
        },
      },
    },
  }),
  procedure: (nsid) => ({
    lexicon: 1,
    id: nsid,
    defs: {
      main: {
        type: 'procedure',
        description: `${nsid.split('.').pop()} procedure.`,
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {},
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {},
          },
        },
      },
    },
  }),
}

const dirs: Record<string, string> = {
  feed: 'server',
  xrpc: 'server',
  label: 'server',
  og: 'server',
  hook: 'server',
  setup: 'server',
}

// --- Commands ---

if (command === 'new') {
  const name = args[1]
  if (!name) {
    console.error('Usage: hatk new <name> [--svelte] [--duckdb] [--template <template-name>]')
    process.exit(1)
  }

  const templateIdx = args.indexOf('--template')
  const templateName = templateIdx !== -1 ? args[templateIdx + 1] : null
  if (templateIdx !== -1 && !templateName) {
    console.error('Usage: hatk new <name> --template <template-name>')
    process.exit(1)
  }

  const dir = resolve(name)
  if (existsSync(dir)) {
    console.error(`Directory ${name} already exists`)
    process.exit(1)
  }

  if (templateName) {
    const repo = `https://github.com/hatk-dev/hatk-template-${templateName}.git`
    console.log(`Cloning template ${templateName}...`)
    try {
      execSync(`git clone --depth 1 ${repo} ${dir}`, { stdio: 'inherit' })
    } catch {
      console.error(`Failed to clone template: ${repo}`)
      process.exit(1)
    }
    execSync(`rm -rf ${join(dir, '.git')}`)
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      pkg.name = name
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    }
    console.log(`\nCreated ${name}/ from template ${templateName}`)
    console.log(`\n  cd ${name}`)
    console.log(`  npm install`)
    console.log(`  hatk dev`)
    process.exit(0)
  }

  const withSvelte = args.includes('--svelte')
  const withDuckdb = args.includes('--duckdb')
  const dbEngine = withDuckdb ? 'duckdb' : 'sqlite'
  mkdirSync(dir)
  const subs = [
    'lexicons',
    'server',
    'seeds',
    'public',
    'test',
    'test/server',
    'test/integration',
    'test/browser',
    'test/fixtures',
  ]
  if (withSvelte) subs.push('src', 'src/routes', 'src/lib')
  for (const sub of subs) {
    mkdirSync(join(dir, sub))
  }

  writeFileSync(
    join(dir, 'hatk.config.ts'),
    `import { defineConfig } from '@hatk/hatk/config'

export default defineConfig({
  relay: 'ws://localhost:2583',
  plc: 'http://localhost:2582',
  port: 3000,
  databaseEngine: '${dbEngine}',
  database: 'data/hatk.db',
  admins: [],
  backfill: {
    parallelism: 10,
  },
})
`,
  )

  writeFileSync(
    join(dir, 'public', 'index.html'),
    `<!DOCTYPE html>
<html><head><title>${name}</title></head>
<body><h1>${name}</h1></body></html>
`,
  )

  // Scaffold core framework lexicons under dev.hatk namespace
  const coreLexDir = join(dir, 'lexicons', 'dev', 'hatk')
  mkdirSync(coreLexDir, { recursive: true })

  writeFileSync(
    join(coreLexDir, 'describeCollections.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.describeCollections',
        defs: {
          main: {
            type: 'query',
            description: 'List indexed collections and their schemas.',
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                properties: {
                  collections: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['collection'],
                      properties: {
                        collection: { type: 'string' },
                        columns: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: ['name', 'originalName', 'type', 'required'],
                            properties: {
                              name: { type: 'string' },
                              originalName: { type: 'string' },
                              type: { type: 'string' },
                              required: { type: 'boolean' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'describeFeeds.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.describeFeeds',
        defs: {
          main: {
            type: 'query',
            description: 'List available feeds.',
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                properties: {
                  feeds: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['name', 'label'],
                      properties: {
                        name: { type: 'string' },
                        label: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'describeLabels.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.describeLabels',
        defs: {
          main: {
            type: 'query',
            description: 'List available label definitions.',
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                properties: {
                  definitions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['identifier', 'severity', 'blurs', 'defaultSetting'],
                      properties: {
                        identifier: { type: 'string' },
                        severity: { type: 'string' },
                        blurs: { type: 'string' },
                        defaultSetting: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'createRecord.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.createRecord',
        defs: {
          main: {
            type: 'procedure',
            description: "Create a record via the user's PDS.",
            input: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                required: ['collection', 'repo', 'record'],
                properties: {
                  collection: { type: 'string' },
                  repo: { type: 'string', format: 'did' },
                  record: { type: 'unknown' },
                },
              },
            },
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                properties: {
                  uri: { type: 'string', format: 'at-uri' },
                  cid: { type: 'string', format: 'cid' },
                  commit: {
                    type: 'object',
                    properties: {
                      cid: { type: 'string', format: 'cid' },
                      rev: { type: 'string' },
                    },
                  },
                  validationStatus: { type: 'string' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'deleteRecord.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.deleteRecord',
        defs: {
          main: {
            type: 'procedure',
            description: "Delete a record via the user's PDS.",
            input: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                required: ['collection', 'rkey'],
                properties: {
                  collection: { type: 'string' },
                  rkey: { type: 'string' },
                },
              },
            },
            output: { encoding: 'application/json', schema: { type: 'object', properties: {} } },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'putRecord.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.putRecord',
        defs: {
          main: {
            type: 'procedure',
            description: "Create or update a record via the user's PDS.",
            input: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                required: ['collection', 'rkey', 'record'],
                properties: {
                  collection: { type: 'string' },
                  rkey: { type: 'string' },
                  record: { type: 'unknown' },
                  repo: { type: 'string', format: 'did' },
                },
              },
            },
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                properties: {
                  uri: { type: 'string', format: 'at-uri' },
                  cid: { type: 'string', format: 'cid' },
                  commit: {
                    type: 'object',
                    properties: {
                      cid: { type: 'string', format: 'cid' },
                      rev: { type: 'string' },
                    },
                  },
                  validationStatus: { type: 'string' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'uploadBlob.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.uploadBlob',
        defs: {
          main: {
            type: 'procedure',
            description: "Upload a blob via the user's PDS.",
            input: {
              encoding: '*/*',
            },
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                required: ['blob'],
                properties: {
                  blob: { type: 'blob' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'getPreferences.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.getPreferences',
        defs: {
          main: {
            type: 'query',
            description: 'Get all preferences for the authenticated user.',
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                properties: {
                  preferences: { type: 'unknown' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'putPreference.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.putPreference',
        defs: {
          main: {
            type: 'procedure',
            description: 'Set a single preference by key.',
            input: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                required: ['key', 'value'],
                properties: {
                  key: { type: 'string' },
                  value: { type: 'unknown' },
                },
              },
            },
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                properties: {},
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'getFeed.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.getFeed',
        defs: {
          main: {
            type: 'query',
            description: 'Retrieve a named feed of items.',
            parameters: {
              type: 'params',
              required: ['feed'],
              properties: {
                feed: { type: 'string', description: 'Feed name' },
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
                cursor: { type: 'string' },
              },
            },
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: { type: 'array', items: { type: 'unknown' } },
                  cursor: { type: 'string' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'getRecord.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.getRecord',
        defs: {
          main: {
            type: 'query',
            description: 'Fetch a single record by AT URI.',
            parameters: {
              type: 'params',
              required: ['uri'],
              properties: {
                uri: { type: 'string', format: 'at-uri' },
              },
            },
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                properties: {
                  record: { type: 'unknown' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'getRecords.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.getRecords',
        defs: {
          main: {
            type: 'query',
            description: 'List records from a collection with optional filters.',
            parameters: {
              type: 'params',
              required: ['collection'],
              properties: {
                collection: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                cursor: { type: 'string' },
                sort: { type: 'string' },
                order: { type: 'string' },
              },
            },
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: { type: 'array', items: { type: 'unknown' } },
                  cursor: { type: 'string' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(coreLexDir, 'searchRecords.json'),
    JSON.stringify(
      {
        lexicon: 1,
        id: 'dev.hatk.searchRecords',
        defs: {
          main: {
            type: 'query',
            description: 'Full-text search across a collection.',
            parameters: {
              type: 'params',
              required: ['collection', 'q'],
              properties: {
                collection: { type: 'string' },
                q: { type: 'string', description: 'Search query' },
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                cursor: { type: 'string' },
                fuzzy: { type: 'boolean', default: true },
              },
            },
            output: {
              encoding: 'application/json',
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: { type: 'array', items: { type: 'unknown' } },
                  cursor: { type: 'string' },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(dir, 'seeds', 'seed.ts'),
    `import { seed } from '../hatk.generated.ts'

const { createAccount, createRecord } = seed()

const alice = await createAccount('alice.test')

// await createRecord(alice, 'your.collection.here', {
//   field: 'value',
// }, { rkey: 'my-record' })

console.log('\\n[seed] Done!')
`,
  )

  writeFileSync(
    join(dir, 'docker-compose.yml'),
    `services:
  plc:
    build:
      context: https://github.com/did-method-plc/did-method-plc.git
      dockerfile: packages/server/Dockerfile
    ports:
      - '2582:2582'
    environment:
      - DATABASE_URL=postgres://plc:plc@postgres:5432/plc
      - PORT=2582
    command: ['dumb-init', 'node', '--enable-source-maps', '../dist/bin.js']
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ['CMD-SHELL', 'wget -q --spider http://localhost:2582/_health || exit 1']
      interval: 2s
      timeout: 5s
      retries: 15

  pds:
    image: ghcr.io/bluesky-social/pds:latest
    ports:
      - '2583:2583'
    environment:
      - PDS_HOSTNAME=localhost
      - PDS_PORT=2583
      - PDS_DID_PLC_URL=http://plc:2582
      - PDS_DATA_DIRECTORY=/pds
      - PDS_BLOBSTORE_DISK_LOCATION=/pds/blobs
      - PDS_JWT_SECRET=dev-jwt-secret
      - PDS_ADMIN_PASSWORD=dev-admin
      - PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      - PDS_INVITE_REQUIRED=false
      - PDS_DEV_MODE=true
      - LOG_ENABLED=true
    volumes:
      - pds_data:/pds
    depends_on:
      plc:
        condition: service_healthy
    healthcheck:
      test: ['CMD-SHELL', 'wget -q --spider http://localhost:2583/xrpc/_health || exit 1']
      interval: 2s
      timeout: 5s
      retries: 15

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=plc
      - POSTGRES_PASSWORD=plc
      - POSTGRES_DB=plc
    volumes:
      - plc_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U plc']
      interval: 2s
      timeout: 5s
      retries: 10

volumes:
  pds_data:
  plc_data:
`,
  )

  writeFileSync(
    join(dir, '.dockerignore'),
    `node_modules
data
.svelte-kit
public
`,
  )

  writeFileSync(
    join(dir, 'Dockerfile'),
    `FROM node:25-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node_modules/.bin/hatk build
RUN npm prune --omit=dev
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "--max-old-space-size=512", "node_modules/@hatk/hatk/dist/main.js", "hatk.config.ts"]
`,
  )

  const pkgDeps: Record<string, string> = { '@hatk/oauth-client': '*', hatk: '*' }
  if (!withDuckdb) {
    pkgDeps['better-sqlite3'] = '^11'
  }
  const pkgDevDeps: Record<string, string> = {
    '@playwright/test': '^1',
    oxfmt: '^0.35.0',
    oxlint: '^1',
    typescript: '^5',
    vite: '^6',
    vitest: '^4',
    '@types/node': '^22',
  }
  if (withSvelte) {
    pkgDevDeps['@sveltejs/adapter-static'] = '^3'
    pkgDevDeps['@sveltejs/kit'] = '^2'
    pkgDevDeps['@sveltejs/vite-plugin-svelte'] = '^5'
    pkgDevDeps['svelte'] = '^5'
    pkgDevDeps['svelte-check'] = '^4'
  }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        private: true,
        type: 'module',
        scripts: {
          start: 'hatk start',
          dev: 'hatk dev',
          build: 'hatk build',
          check: 'hatk check',
          format: 'hatk format',
        },
        dependencies: pkgDeps,
        devDependencies: pkgDevDeps,
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(dir, 'tsconfig.server.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          resolveJsonModule: true,
        },
        include: ['server', 'seeds', 'hatk.generated.ts', 'hatk.config.ts'],
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(dir, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'test/browser',
  use: { baseURL: 'http://127.0.0.1:3000' },
  globalSetup: './test/browser/global-setup.ts',
})
`,
  )

  writeFileSync(
    join(dir, 'test/browser/global-setup.ts'),
    `import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export default function globalSetup() {
  if (existsSync('src/app.html')) {
    execSync('npx vite build', { stdio: 'inherit' })
  }
}
`,
  )

  writeFileSync(
    join(dir, '.gitignore'),
    `node_modules/
*.db
data/
test-results/
.svelte-kit/
.DS_Store
public/
`,
  )

  writeFileSync(
    join(dir, '.oxlintrc.json'),
    `{
  "ignorePatterns": ["public", "data", ".svelte-kit", "hatk.generated.ts"]
}
`,
  )

  writeFileSync(
    join(dir, '.oxfmtrc.json'),
    `{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 120,
  "tabWidth": 2,
  "ignorePatterns": ["public", "data", ".svelte-kit", "hatk.generated.ts"]
}
`,
  )

  if (withSvelte) {
    writeFileSync(
      join(dir, 'svelte.config.js'),
      `import adapter from '@sveltejs/adapter-static'

export default {
  kit: {
    adapter: adapter({
      pages: 'public',
      assets: 'public',
      fallback: 'index.html',
    }),
    paths: { base: '' },
    alias: {
      $hatk: './hatk.generated.ts',
    },
  },
}
`,
    )

    writeFileSync(
      join(dir, 'vite.config.ts'),
      `import { sveltekit } from '@sveltejs/kit/vite'
import { hatk } from '@hatk/hatk/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sveltekit(), hatk()],
})
`,
    )

    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          extends: './.svelte-kit/tsconfig.json',
          compilerOptions: {
            allowJs: true,
            checkJs: false,
            esModuleInterop: true,
            forceConsistentCasingInFileNames: true,
            resolveJsonModule: true,
            skipLibCheck: true,
            sourceMap: true,
            strict: true,
            moduleResolution: 'bundler',
            allowImportingTsExtensions: true,
          },
        },
        null,
        2,
      ) + '\n',
    )

    writeFileSync(
      join(dir, 'src/app.html'),
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${name}" />
    <title>${name}</title>
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
    )

    writeFileSync(
      join(dir, 'src/app.css'),
      `*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --bg-root: #080b12;
  --bg-surface: #0f1419;
  --bg-elevated: #161d27;
  --bg-hover: #1c2633;
  --border: #1e293b;
  --teal: #14b8a6;
  --text-primary: #e2e8f0;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
}

html {
  background: var(--bg-root);
  color: var(--text-primary);
}

body {
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  min-height: 100vh;
}

a {
  color: inherit;
  text-decoration: none;
}
`,
    )

    writeFileSync(
      join(dir, 'src/routes/+layout.svelte'),
      `<script lang="ts">
  import type { Snippet } from 'svelte'
  import '../app.css'

  let { children }: { children: Snippet } = $props()
</script>

{@render children()}
`,
    )

    writeFileSync(
      join(dir, 'src/routes/+page.svelte'),
      `<h1>${name}</h1>
<p>Your hatk server is running.</p>
`,
    )

    writeFileSync(
      join(dir, 'src/error.html'),
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>%sveltekit.error.message% — ${name}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, system-ui, sans-serif;
        background: #080b12; color: #e2e8f0;
        min-height: 100vh; display: flex; align-items: center; justify-content: center;
      }
      .error-page { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 24px; }
      .error-code { font-size: 72px; font-weight: 800; color: #14b8a6; line-height: 1; }
      .error-title { font-size: 24px; font-weight: 800; }
      .error-link {
        margin-top: 16px; padding: 10px 24px; background: #14b8a6; color: #000;
        border-radius: 20px; font-weight: 600; font-size: 14px; text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="error-page">
      <span class="error-code">%sveltekit.status%</span>
      <h1 class="error-title">%sveltekit.error.message%</h1>
      <a href="/" class="error-link">Back to home</a>
    </div>
  </body>
</html>
`,
    )

    writeFileSync(
      join(dir, 'src/routes/+error.svelte'),
      `<script lang="ts">
  import { page } from '$app/state'
</script>

<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; gap: 8px;">
  <span style="font-size: 72px; font-weight: 800; color: var(--teal);">{page.status}</span>
  <h1 style="font-size: 24px; font-weight: 800;">{page.error?.message}</h1>
  <a href="/" style="margin-top: 16px; padding: 10px 24px; background: var(--teal); color: #000; border-radius: 20px; font-weight: 600; font-size: 14px;">Back to home</a>
</div>
`,
    )
  }

  let agentsMd = `# hatk project

This is an AT Protocol application built with [hatk](https://github.com/hatk-dev/hatk).
Read the project's lexicons in \`lexicons/\` to understand the data model.
Types are generated from lexicons into \`hatk.generated.ts\` — never edit this file directly.

## Project structure

| Directory    | Purpose                                              |
|-------------|------------------------------------------------------|
| \`lexicons/\`  | AT Protocol lexicon schemas (JSON). Defines collections and XRPC methods |
| \`server/\`    | All server-side code: feeds, XRPC handlers, hooks, labels, OG routes, setup scripts |
| \`seeds/\`     | Test data seeding scripts for local development       |
| \`test/\`      | Test files (vitest). Run with \`vp test\`               |
| \`public/\`    | Static files served at the root                       |
`
  if (withSvelte) {
    agentsMd += `| \`src/\`       | SvelteKit frontend (routes, components, styles)       |

`
  } else {
    agentsMd += `
`
  }

  agentsMd += `## Key files

- \`hatk.config.ts\` — project configuration (see \`defineConfig\` for type info)
- \`hatk.generated.ts\` — auto-generated server types and helpers. Regenerate with \`hatk generate types\`
- \`hatk.generated.client.ts\` — auto-generated client-safe types and \`callXrpc\`. Never import \`hatk.generated.ts\` from frontend code

## The \`$hatk\` alias

Server files in \`server/\` import from \`$hatk\`:
\`\`\`ts
import { defineFeed, views, type Status } from "$hatk"
\`\`\`
`
  if (withSvelte) {
    agentsMd += `
SvelteKit routes and components import from \`$hatk/client\`:
\`\`\`ts
import { callXrpc, getViewer } from "$hatk/client"
\`\`\`

\`$hatk\` resolves to \`hatk.generated.ts\` and \`$hatk/client\` to \`hatk.generated.client.ts\`.
The Vite plugin handles this in dev/build. In tests and production, a Node.js module resolve hook handles it.
`
  } else {
    agentsMd += `
\`$hatk\` resolves to \`hatk.generated.ts\`. The Vite plugin handles this in dev/build.
In tests and production, a Node.js module resolve hook handles it.
`
  }

  agentsMd += `
## Commands

Run \`npx hatk --help\` for the full list of commands.

Use \`npx hatk generate\` to scaffold new feeds, xrpc handlers, labels, and lexicons
rather than creating files manually. These generate files with the correct imports.

After modifying lexicons, always run \`npx hatk generate types\` to update the generated types.
`
  if (withSvelte) {
    agentsMd += `
## Running

- \`vp dev\` — start dev server (hatk + SvelteKit + PDS)
- \`vp build\` — build for production (SvelteKit outputs to \`build/\`)
- \`hatk start\` — start production server (hatk + SvelteKit via \`build/handler.js\`)
- \`vp test\` — run tests
`
  }

  writeFileSync(join(dir, 'AGENTS.md'), agentsMd)

  console.log(`Created ${name}/`)
  console.log(`  hatk.config.ts`)
  console.log(`  lexicons/   — lexicon JSON files (core + your own)`)
  console.log(`  server/     — feeds, XRPC handlers, hooks, labels, OG routes, setup`)
  console.log(`  seeds/      — seed fixture data (hatk seed)`)
  console.log(`  test/       — test files (hatk test)`)
  console.log(`  public/     — static files`)
  console.log(`  docker-compose.yml — local PDS for development`)
  console.log(`  Dockerfile     — production container`)
  if (withSvelte) {
    console.log(`  src/        — SvelteKit frontend`)
    console.log(`  svelte.config.js`)
    console.log(`  vite.config.ts`)
  }

  // Generate types so the project is ready to go
  execSync('npx hatk generate types', { stdio: 'inherit', cwd: dir })
  if (withSvelte) {
    execSync('npx svelte-kit sync', { stdio: 'inherit', cwd: dir })
  }
} else if (command === 'generate') {
  const type = args[1]

  if (type === 'types') {
    const lexiconsDir = './lexicons'
    const outPath = './hatk.generated.ts'
    if (!existsSync(lexiconsDir)) {
      console.error(`Lexicons directory not found: ${lexiconsDir}`)
      process.exit(1)
    }

    const lexicons = loadLexicons(resolve(lexiconsDir))

    // Classify all lexicons — include defs-only lexicons for registry
    const entries: { nsid: string; defType: string | null }[] = []
    for (const [nsid, lex] of lexicons) {
      const defType = lex.defs?.main?.type
      if (defType === 'record' || defType === 'query' || defType === 'procedure') {
        entries.push({ nsid, defType })
      } else if (lex.defs && Object.keys(lex.defs).length > 0) {
        // Defs-only lexicon (shared types, no main record/query/procedure)
        entries.push({ nsid, defType: null })
      }
    }
    entries.sort((a, b) => a.nsid.localeCompare(b.nsid))

    // Collect procedure nsids and blob-input nsids for client callXrpc
    const procedureNsids: string[] = []
    const blobInputNsids: string[] = []
    for (const { nsid, defType } of entries) {
      if (defType === 'procedure') {
        const lex = lexicons.get(nsid)
        const inputEncoding = lex?.defs?.main?.input?.encoding
        if (inputEncoding === '*/*') {
          blobInputNsids.push(nsid)
        } else {
          procedureNsids.push(nsid)
        }
      }
    }

    if (entries.length === 0) {
      console.error('No lexicons found')
      process.exit(1)
    }

    // Build unique variable names from NSIDs
    // First pass: detect which leaf names collide
    const leafCount = new Map<string, number>()
    for (const { nsid } of entries) {
      const leaf = nsid.split('.').pop()!
      leafCount.set(leaf, (leafCount.get(leaf) || 0) + 1)
    }

    const varNames = new Map<string, string>()
    const usedNames = new Set<string>()
    for (const { nsid } of entries) {
      const parts = nsid.split('.')
      const leaf = parts[parts.length - 1]
      let name: string
      if (leafCount.get(leaf)! > 1) {
        // Collision: use authority + path segments (skip TLD)
        // e.g. app.bsky.actor.profile → bskyActorProfile
        name = parts
          .slice(1)
          .join('.')
          .split('.')
          .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
          .join('')
      } else {
        name = leaf
      }
      // Final dedup fallback
      if (usedNames.has(name)) name = name + '2'
      usedNames.add(name)
      varNames.set(nsid, name)
    }

    const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
    const wrapperMap: Record<string, string> = {
      record: 'LexRecord',
      query: 'LexQuery',
      procedure: 'LexProcedure',
    }

    // Collect which wrappers are used (only from entries with a main type)
    const usedWrappers = new Set(entries.filter((e) => e.defType).map((e) => wrapperMap[e.defType!]))

    let out = '// Auto-generated from lexicons. Do not edit.\n'
    out += `import type { ${[...usedWrappers].sort().join(', ')}, LexServerParams, Checked, Prettify, StrictArg } from '@hatk/hatk/lex-types'\n`
    out += `import type { XrpcContext } from '@hatk/hatk/xrpc'\n`
    out += `import { callXrpc as _callXrpc } from '@hatk/hatk/xrpc'\n`
    out += `import { defineFeed as _defineFeed, type FeedResult, type FeedContext, type BaseContext, type Row } from '@hatk/hatk/feeds'\n`
    out += `import { seed as _seed, type SeedOpts } from '@hatk/hatk/seed'\n`

    // Emit ALL lexicons as `const ... = {...} as const` (including defs-only)
    out += `\n// ─── Lexicon Definitions ────────────────────────────────────────────\n\n`
    for (const { nsid } of entries) {
      const varName = varNames.get(nsid)!
      const content = lexicons.get(nsid)
      out += `const ${varName}Lex = ${JSON.stringify(content)} as const\n`
    }

    // Registry includes ALL lexicons so cross-lexicon refs resolve
    out += `\n// ─── Type Registry ──────────────────────────────────────────────────\n\n`
    out += `type Registry = {\n`
    for (const { nsid } of entries) {
      const varName = varNames.get(nsid)!
      out += `  '${nsid}': typeof ${varName}Lex\n`
    }
    out += `}\n\n`

    // Emit main type only for lexicons with a typed main def
    out += `// ─── Record & Method Types ──────────────────────────────────────────\n\n`
    for (const { nsid, defType } of entries) {
      if (!defType) continue
      // createRecord/deleteRecord/putRecord get typed overrides after RecordRegistry
      if (nsid === 'dev.hatk.createRecord' || nsid === 'dev.hatk.deleteRecord' || nsid === 'dev.hatk.putRecord')
        continue
      const varName = varNames.get(nsid)!
      const typeName = capitalize(varName)
      const wrapper = wrapperMap[defType]
      out += `export type ${typeName} = Prettify<${wrapper}<typeof ${varName}Lex, Registry>>\n`
    }

    // Emit RecordRegistry for typesafe search/resolve
    const recordEntries = entries.filter((e) => e.defType === 'record')
    if (recordEntries.length > 0) {
      out += `\nexport type RecordRegistry = {\n`
      for (const { nsid } of recordEntries) {
        const varName = varNames.get(nsid)!
        out += `  '${nsid}': ${capitalize(varName)}\n`
      }
      out += `}\n\n`

      // Emit typed CreateRecord/DeleteRecord using RecordRegistry
      out += `export type CreateRecord = {\n`
      out += `  params: {}\n`
      out += `  input: { [K in keyof RecordRegistry]: { collection: K; record: RecordRegistry[K]; repo?: string } }[keyof RecordRegistry]\n`
      out += `  output: { uri?: string; cid?: string }\n`
      out += `}\n\n`

      out += `export type DeleteRecord = {\n`
      out += `  params: {}\n`
      out += `  input: { [K in keyof RecordRegistry]: { collection: K; rkey: string } }[keyof RecordRegistry]\n`
      out += `  output: {}\n`
      out += `}\n\n`

      out += `export type PutRecord = {\n`
      out += `  params: {}\n`
      out += `  input: { [K in keyof RecordRegistry]: { collection: K; rkey: string; record: RecordRegistry[K]; repo?: string } }[keyof RecordRegistry]\n`
      out += `  output: { uri?: string; cid?: string }\n`
      out += `}\n\n`
    } else {
      // No record lexicons — emit empty registries and basic CRUD types
      out += `\nexport type RecordRegistry = {}\n\n`
      out += `export type CreateRecord = LexProcedure<typeof createRecordLex, Registry>\n`
      out += `export type DeleteRecord = LexProcedure<typeof deleteRecordLex, Registry>\n`
      out += `export type PutRecord = LexProcedure<typeof putRecordLex, Registry>\n\n`
    }

    // Emit named defs (non-main, non-record types like views, objects)
    // Use def name as-is; only prefix with lexicon name on collision
    out += `// ─── Named Defs (Views, Objects) ────────────────────────────────────\n\n`
    let hasLexDef = false

    // First pass: collect all def names to detect collisions
    const defOccurrences = new Map<string, number>()
    for (const { nsid } of entries) {
      const lex = lexicons.get(nsid)
      for (const defName of Object.keys(lex.defs || {})) {
        if (defName === 'main') continue
        const def = lex.defs[defName]
        if (def.type === 'object' && def.properties) {
          const name = capitalize(defName)
          defOccurrences.set(name, (defOccurrences.get(name) || 0) + 1)
        }
      }
    }

    // Second pass: emit, prefixing only when name collides
    // Seed with main type names to avoid collision with those
    const emittedDefNames = new Set<string>(
      entries.filter((e) => e.defType).map((e) => capitalize(varNames.get(e.nsid)!)),
    )
    // Track view defs for views identity helpers
    const viewEntries: { fullNsid: string; typeName: string; collection: string | null }[] = []

    for (const { nsid } of entries) {
      const varName = varNames.get(nsid)!
      const typeName = capitalize(varName)
      const lex = lexicons.get(nsid)
      for (const defName of Object.keys(lex.defs || {})) {
        if (defName === 'main') continue
        const def = lex.defs[defName]
        if (def.type === 'object' && def.properties) {
          if (!hasLexDef) hasLexDef = true
          let name = capitalize(defName)
          // Also check collision with main type names
          const needsPrefix = (defOccurrences.get(name) || 0) > 1 || emittedDefNames.has(name)
          if (needsPrefix) name = typeName + name
          // Final dedup fallback
          if (emittedDefNames.has(name)) name = name + '2'
          emittedDefNames.add(name)
          out += `export type ${name} = Prettify<LexDef<typeof ${varName}Lex, '${defName}', Registry>>\n`

          // Detect view defs for views identity helpers
          if (/View(Basic|Detailed)?$/.test(defName)) {
            const fullNsid = `${nsid}#${defName}`

            // Pattern 1: inline view — has ref: "#main", collection is this lexicon
            const hasMainRef = Object.values(def.properties).some((p: any) => p.type === 'ref' && p.ref === '#main')
            if (hasMainRef) {
              viewEntries.push({ fullNsid, typeName: name, collection: nsid })
            } else {
              // Pattern 2: defs view — derive collection from naming convention
              const recordName = defName.match(/^(.+?)View(Basic|Detailed)?$/)?.[1]
              let found = false
              if (recordName) {
                const namespace = nsid.split('.').slice(0, -1).join('.')
                const collectionNsid = `${namespace}.${recordName}`
                const collectionLex = lexicons.get(collectionNsid)
                if (collectionLex?.defs?.main?.type === 'record') {
                  viewEntries.push({ fullNsid, typeName: name, collection: collectionNsid })
                  found = true
                }
              }
              // Pattern 3: cross-namespace view — has explicit ref to a record-type lexicon
              if (!found) {
                const recordRef = Object.values(def.properties).find(
                  (p: any) =>
                    p.type === 'ref' && !p.ref.startsWith('#') && lexicons.get(p.ref)?.defs?.main?.type === 'record',
                ) as any
                if (recordRef) {
                  viewEntries.push({ fullNsid, typeName: name, collection: recordRef.ref })
                  found = true
                }
              }
              // Pattern 4: standalone view — not tied to a record, but still a reusable view type
              if (!found) {
                viewEntries.push({ fullNsid, typeName: name, collection: null })
              }
            }
          }
        }
      }
    }

    // Emit XrpcSchema for typed XRPC clients — keyed by full NSID
    const methods = entries.filter((e) => e.defType === 'query' || e.defType === 'procedure')
    out += `\n// ─── XRPC Schema ────────────────────────────────────────────────────\n\n`
    out += `export type XrpcSchema = {\n`
    for (const { nsid } of methods) {
      const varName = varNames.get(nsid)!
      out += `  '${nsid}': ${capitalize(varName)}\n`
    }
    out += `}\n`

    // Emit Ctx helper for typesafe XRPC handler contexts
    out += `\n// ─── XRPC Helpers ───────────────────────────────────────────────────\n\n`
    out += `export type { BaseContext, Row } from '@hatk/hatk/feeds'\n`
    out += `export { InvalidRequestError, NotFoundError } from '@hatk/hatk/xrpc'\n`
    out += `export { defineSetup } from '@hatk/hatk/setup'\n`
    out += `export { defineHook } from '@hatk/hatk/hooks'\n`
    out += `export { defineLabel } from '@hatk/hatk/labels'\n`
    out += `export { defineOG } from '@hatk/hatk/opengraph'\n`
    out += `export { defineRenderer } from '@hatk/hatk/renderer'\n`
    out += `export type Ctx<K extends keyof XrpcSchema & keyof Registry> = XrpcContext<\n`
    out += `  LexServerParams<Registry[K], Registry>,\n`
    out += `  RecordRegistry,\n`
    out += `  K extends keyof XrpcSchema ? InputOf<K> : unknown\n`
    out += `>\n`

    // Emit typed handler helpers with ctx.ok() for strict return type enforcement
    out += `\ntype OutputOf<K extends keyof XrpcSchema> = XrpcSchema[K]['output']\n`
    out += `type InputOf<K extends keyof XrpcSchema> = XrpcSchema[K] extends { input: infer I } ? I : unknown\n\n`
    out += `export function defineQuery<K extends keyof XrpcSchema & string>(\n`
    out += `  nsid: K,\n`
    out += `  handler: (ctx: Ctx<K> & { ok: <T extends OutputOf<K>>(value: StrictArg<T, OutputOf<K>>) => Checked<OutputOf<K>> }) => Promise<Checked<OutputOf<K>>>,\n`
    out += `) {\n`
    out += `  return { __type: 'query' as const, nsid, handler: (ctx: any) => handler({ ...ctx, ok: (v: any) => v }) }\n`
    out += `}\n\n`
    out += `export function defineProcedure<K extends keyof XrpcSchema & string>(\n`
    out += `  nsid: K,\n`
    out += `  handler: (ctx: Ctx<K> & { ok: <T extends OutputOf<K>>(value: StrictArg<T, OutputOf<K>>) => Checked<OutputOf<K>> }) => Promise<Checked<OutputOf<K>>>,\n`
    out += `) {\n`
    out += `  return { __type: 'procedure' as const, nsid, handler: (ctx: any) => handler({ ...ctx, ok: (v: any) => v }) }\n`
    out += `}\n\n`
    out += `// ─── Server-side XRPC Caller ────────────────────────────────────────\n\n`
    out += `type ExtractParams<T> = T extends { params: infer P } ? P : Record<string, unknown>\n`
    out += `export async function callXrpc<K extends keyof XrpcSchema & string>(\n`
    out += `  nsid: K,\n`
    out += `  params?: ExtractParams<XrpcSchema[K]>,\n`
    out += `): Promise<OutputOf<K>> {\n`
    out += `  return _callXrpc(nsid, params as any) as Promise<OutputOf<K>>\n`
    out += `}\n\n`
    out += `// ─── Feed & Seed Helpers ────────────────────────────────────────────\n\n`
    out += `type FeedGenerate = (ctx: FeedContext & { ok: (value: FeedResult) => Checked<FeedResult> }) => Promise<Checked<FeedResult>>\n`
    out += `export function defineFeed<K extends keyof RecordRegistry>(\n`
    out += `  opts: { collection: K; view?: string; label: string; generate: FeedGenerate; hydrate?: (ctx: BaseContext, items: Row<RecordRegistry[K]>[]) => Promise<unknown[]> }\n`
    out += `): ReturnType<typeof _defineFeed>\n`
    out += `export function defineFeed(\n`
    out += `  opts: { collection?: never; view?: never; label: string; generate: FeedGenerate; hydrate: (ctx: BaseContext, items: Row<unknown>[]) => Promise<unknown[]> }\n`
    out += `): ReturnType<typeof _defineFeed>\n`
    out += `export function defineFeed(opts: any) { return _defineFeed(opts) }\n`
    out += `export function seed(opts?: SeedOpts) { return _seed<RecordRegistry>(opts) }\n`

    // Emit view identity helpers for strict excess property checking on nested objects
    if (viewEntries.length > 0) {
      out += `\n// View identity helpers — wrap object literals to enable excess property checking.\n`
      out += `// Usage: rows.map(r => views.statusView({ ...fields })) catches extra properties.\n`
      out += `export const views = {\n`
      for (const { typeName } of viewEntries) {
        // Use the deduped type name (lowercased) as key to avoid collisions
        // e.g., PlayView -> playView, BskyFeedDefsPlayView -> bskyFeedDefsPlayView
        const key = typeName[0].toLowerCase() + typeName.slice(1)
        out += `  ${key}: (v: ${typeName}): ${typeName} => v,\n`
      }
      out += `} as const\n`
    }

    // Patch imports to include LexDef if needed
    if (hasLexDef) {
      usedWrappers.add('LexDef')
      out = out.replace(
        /import type \{ ([^}]+) \} from '@hatk\/hatk\/lex-types'/,
        `import type { ${[...usedWrappers].sort().join(', ')}, LexServerParams, Checked, Prettify, StrictArg } from '@hatk/hatk/lex-types'`,
      )
    }

    writeFileSync(outPath, out)

    // Generate client-safe version (types + callXrpc only, no server module re-exports)
    // Types use `export type` from main file (erased at compile time, no runtime import).
    // callXrpc imports from @hatk/hatk/xrpc directly to avoid pulling in server deps.
    let clientOut = '// Auto-generated client-safe subset. Do not edit.\n'
    clientOut += `// Import this in app components instead of hatk.generated.ts\n`
    clientOut += `// to avoid pulling in server-only dependencies.\n`
    clientOut += `export type { XrpcSchema } from './hatk.generated.ts'\n`
    clientOut += `import type { XrpcSchema } from './hatk.generated.ts'\n`

    // Re-export all types
    const typeExports: string[] = []
    for (const { nsid, defType } of entries) {
      if (!defType) continue
      if (nsid === 'dev.hatk.createRecord' || nsid === 'dev.hatk.deleteRecord' || nsid === 'dev.hatk.putRecord')
        continue
      typeExports.push(capitalize(varNames.get(nsid)!))
    }
    if (recordEntries.length > 0) {
      typeExports.push('RecordRegistry', 'CreateRecord', 'DeleteRecord', 'PutRecord')
    }
    // Named defs (views, objects) — collect from emittedDefNames minus main types
    const mainTypeNames = new Set(entries.filter((e) => e.defType).map((e) => capitalize(varNames.get(e.nsid)!)))
    for (const name of emittedDefNames) {
      if (!mainTypeNames.has(name) && !typeExports.includes(name)) {
        typeExports.push(name)
      }
    }
    if (typeExports.length > 0) {
      clientOut += `export type { ${typeExports.join(', ')} } from './hatk.generated.ts'\n`
    }

    // Typed callXrpc — environment-aware:
    // SSR: uses globalThis.__hatk_callXrpc bridge (direct handler invocation)
    // Client: fetches via HTTP (GET for queries, POST for procedures, raw POST for blobs)
    if (procedureNsids.length > 0) {
      clientOut += `\nconst _procedures = new Set([${procedureNsids.map((n) => `'${n}'`).join(', ')}])\n`
    }
    if (blobInputNsids.length > 0) {
      clientOut += `const _blobInputs = new Set([${blobInputNsids.map((n) => `'${n}'`).join(', ')}])\n`
    }

    clientOut += `\ntype CallArg<K extends keyof XrpcSchema> =\n`
    clientOut += `  XrpcSchema[K] extends { input: infer I } ? I :\n`
    clientOut += `  XrpcSchema[K] extends { params: infer P } ? P :\n`
    clientOut += `  Record<string, unknown>\n`
    clientOut += `type OutputOf<K extends keyof XrpcSchema> = XrpcSchema[K]['output']\n\n`
    clientOut += `export async function callXrpc<K extends keyof XrpcSchema & string>(\n`
    clientOut += `  nsid: K,\n`
    clientOut += `  arg?: CallArg<K>,\n`
    clientOut += `  customFetch?: typeof globalThis.fetch,\n`
    clientOut += `): Promise<OutputOf<K>> {\n`
    // Server-side bridge (skip when customFetch is provided — let SvelteKit's fetch handle it)
    clientOut += `  if (typeof window === 'undefined' && !customFetch) {\n`
    clientOut += `    const bridge = (globalThis as any).__hatk_callXrpc\n`
    clientOut += `    if (!bridge) throw new Error('callXrpc: server bridge not available — is hatk initialized?')\n`
    if (procedureNsids.length > 0 || blobInputNsids.length > 0) {
      const checks = []
      if (procedureNsids.length > 0) checks.push('_procedures.has(nsid)')
      if (blobInputNsids.length > 0) checks.push('_blobInputs.has(nsid)')
      clientOut += `    if (${checks.join(' || ')}) return bridge(nsid, {}, arg) as Promise<OutputOf<K>>\n`
    }
    clientOut += `    return bridge(nsid, arg) as Promise<OutputOf<K>>\n`
    clientOut += `  }\n`
    // Client-side fetch (or server-side with customFetch for SSR deduplication)
    clientOut += `  const _fetch = customFetch ?? globalThis.fetch\n`
    clientOut += `  // Use relative URL so SvelteKit's fetch can deduplicate server/client requests\n`
    clientOut += `  let path = \`/xrpc/\${nsid}\`\n`
    if (blobInputNsids.length > 0) {
      clientOut += `  if (_blobInputs.has(nsid)) {\n`
      clientOut += `    const blob = arg as Blob | ArrayBuffer\n`
      clientOut += `    const ct = blob instanceof Blob ? blob.type : 'application/octet-stream'\n`
      clientOut += `    const res = await _fetch(path, { method: 'POST', headers: { 'Content-Type': ct }, body: blob })\n`
      clientOut += `    if (!res.ok) throw new Error(\`XRPC \${nsid} failed: \${res.status}\`)\n`
      clientOut += `    return res.json() as Promise<OutputOf<K>>\n`
      clientOut += `  }\n`
    }
    if (procedureNsids.length > 0) {
      clientOut += `  if (_procedures.has(nsid)) {\n`
      clientOut += `    const res = await _fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(arg) })\n`
      clientOut += `    if (typeof window !== 'undefined' && res.status === 401) { const _h = getViewer()?.handle; window.location.href = _h ? \`/oauth/login?handle=\${encodeURIComponent(_h)}\` : '/oauth/login'; return new Promise(() => {}) as any }\n`
      clientOut += `    if (!res.ok) throw new Error(\`XRPC \${nsid} failed: \${res.status}\`)\n`
      clientOut += `    return res.json() as Promise<OutputOf<K>>\n`
      clientOut += `  }\n`
    }
    clientOut += `  const params = new URLSearchParams()\n`
    clientOut += `  for (const [k, v] of Object.entries(arg || {})) {\n`
    clientOut += `    if (v != null) params.set(k, String(v))\n`
    clientOut += `  }\n`
    clientOut += `  const qs = params.toString()\n`
    clientOut += `  if (qs) path += \`?\${qs}\`\n`
    clientOut += `  const res = await _fetch(path)\n`
    clientOut += `  if (typeof window !== 'undefined' && res.status === 401) { window.location.href = '/oauth/login'; return new Promise(() => {}) as any }\n`
    clientOut += `  if (!res.ok) throw new Error(\`XRPC \${nsid} failed: \${res.status}\`)\n`
    clientOut += `  return res.json() as Promise<OutputOf<K>>\n`
    clientOut += `}\n`

    // getViewer — returns the viewer set by layout load (server) or $effect (client)
    clientOut += `\nexport function getViewer(): { did: string; handle: string } | null {\n`
    clientOut += `  return (globalThis as any).__hatk_viewer ?? null\n`
    clientOut += `}\n`

    // Auth helpers — login, logout, viewerDid
    clientOut += `\n// ─── Auth Helpers ────────────────────────────────────────────────────\n\n`
    clientOut += `export async function login(handle: string): Promise<void> {\n`
    clientOut += `  const res = await fetch(\`/oauth/login?handle=\${encodeURIComponent(handle)}\`, { redirect: 'manual' })\n`
    clientOut += `  if (res.type === 'opaqueredirect') {\n`
    clientOut += `    window.location.href = \`/oauth/login?handle=\${encodeURIComponent(handle)}\`\n`
    clientOut += `    return\n`
    clientOut += `  }\n`
    clientOut += `  if (res.ok) return\n`
    clientOut += `  const body = await res.json().catch(() => ({ error: 'Login failed' }))\n`
    clientOut += `  throw new Error(body.error || 'Login failed')\n`
    clientOut += `}\n\n`
    clientOut += `export async function logout(): Promise<void> {\n`
    clientOut += `  ;(globalThis as any).__hatk_viewer = null\n`
    clientOut += `  await fetch('/auth/logout', { method: 'POST' }).catch(() => {})\n`
    clientOut += `}\n\n`
    clientOut += `export function viewerDid(): string | null {\n`
    clientOut += `  if (typeof window === 'undefined') return null\n`
    clientOut += `  const viewer = (globalThis as any).__hatk_viewer\n`
    clientOut += `  return viewer?.did ?? null\n`
    clientOut += `}\n\n`
    clientOut += `// Expose viewer for getViewer() bridge\n`
    clientOut += `;(globalThis as any).__hatk_auth = { viewerDid }\n`

    // parseViewer — server-side session cookie resolution for +layout.server.ts
    clientOut += `\n// ─── Server Helpers ──────────────────────────────────────────────────\n\n`
    clientOut += `export async function parseViewer(cookies: { get(name: string): string | undefined }): Promise<{ did: string; handle?: string } | null> {\n`
    clientOut += `  const parseSessionCookie = (globalThis as any).__hatk_parseSessionCookie\n`
    clientOut += `  if (!parseSessionCookie) return null\n`
    clientOut += `  const cookieValue = cookies.get('__hatk_session')\n`
    clientOut += `  if (!cookieValue) return null\n`
    clientOut += `  try {\n`
    clientOut += `    const request = new Request('http://localhost', { headers: { cookie: \`__hatk_session=\${cookieValue}\` } })\n`
    clientOut += `    const viewer = await parseSessionCookie(request)\n`
    clientOut += `    if (viewer) (globalThis as any).__hatk_viewer = viewer\n`
    clientOut += `    return viewer\n`
    clientOut += `  } catch { return null }\n`
    clientOut += `}\n`

    writeFileSync('./hatk.generated.client.ts', clientOut)

    console.log(
      `Generated ${outPath} with ${entries.length} types: ${entries.map((e) => capitalize(varNames.get(e.nsid)!)).join(', ')}`,
    )
    console.log(`Generated ./hatk.generated.client.ts (client-safe subset)`)
  } else if (lexiconTemplates[type]) {
    const nsid = args[2]
    if (!nsid || !nsid.includes('.')) {
      console.error(`Usage: hatk generate ${type} <nsid>  (e.g. com.example.myRecord)`)
      process.exit(1)
    }
    const parts = nsid.split('.')
    const lexDir = join('lexicons', ...parts.slice(0, -1))
    mkdirSync(lexDir, { recursive: true })
    const filePath = join(lexDir, `${parts[parts.length - 1]}.json`)
    if (existsSync(filePath)) {
      console.error(`${filePath} already exists`)
      process.exit(1)
    }
    writeFileSync(filePath, JSON.stringify(lexiconTemplates[type](nsid), null, 2) + '\n')
    console.log(`Created ${filePath}`)
    // Auto-regenerate types
    execSync('npx hatk generate types', { stdio: 'inherit', cwd: process.cwd() })
  } else {
    const name = args[2]
    if (!type || !name || !templates[type]) {
      console.error(
        `Usage: hatk generate <${[...Object.keys(templates), ...Object.keys(lexiconTemplates)].join('|')}|types> <name>`,
      )
      process.exit(1)
    }

    const baseDir = dirs[type]
    mkdirSync(baseDir, { recursive: true })
    const fileName = type === 'xrpc' ? name.split('.').pop()! : name
    const filePath = join(baseDir, `${fileName}.ts`)

    if (existsSync(filePath)) {
      console.error(`${filePath} already exists`)
      process.exit(1)
    }

    writeFileSync(filePath, templates[type](name))
    console.log(`Created ${filePath}`)

    // Scaffold test file if template exists
    const testTemplate = testTemplates[type]
    if (testTemplate) {
      const testDir = 'test/server'
      mkdirSync(testDir, { recursive: true })
      const testName = type === 'xrpc' ? name.split('.').pop()! : name
      const testPath = join(testDir, `${testName}.test.ts`)
      if (!existsSync(testPath)) {
        writeFileSync(testPath, testTemplate(name))
        console.log(`Created ${testPath}`)
      }
    }
  }
} else if (command === 'destroy') {
  const type = args[1]
  const name = args[2]
  if (!type || !name || !dirs[type]) {
    console.error(`Usage: hatk destroy <${Object.keys(dirs).join('|')}> <name>`)
    process.exit(1)
  }

  const baseDir = dirs[type]
  const fileName = type === 'xrpc' ? name.split('.').pop()! : name
  const tsPath = join(baseDir, `${fileName}.ts`)
  const jsPath = join(baseDir, `${fileName}.js`)
  const filePath = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null

  if (!filePath) {
    console.error(`No file found for ${type} "${name}"`)
    process.exit(1)
  }

  unlinkSync(filePath)
  console.log(`Removed ${filePath}`)

  // Clean up test file
  const testDir = 'test/server'
  const testName = type === 'xrpc' ? name.split('.').pop()! : name
  const testFile = join(testDir, `${testName}.test.ts`)
  if (existsSync(testFile)) {
    unlinkSync(testFile)
    console.log(`Removed ${testFile}`)
  }

  if (type === 'label') {
    console.log(`Note: existing applied labels for "${name}" remain in the database.`)
  }
} else if (command === 'dev') {
  await ensurePds()
  runSeed()

  if (existsSync(resolve('vite.config.ts')) || existsSync(resolve('vite.config.js'))) {
    // Vite project — vite dev starts the hatk server via the plugin
    await spawnForward('npx', ['vite', 'dev'])
  } else {
    // No frontend — just run the hatk server directly
    const mainPath = resolve(import.meta.dirname!, 'main.js')
    await spawnForward('npx', ['tsx', mainPath, 'hatk.config.ts'], { DEV_MODE: '1' })
  }
} else if (command === 'format' || command === 'fmt') {
  try {
    execSync('npx oxfmt .', { stdio: 'inherit', cwd: process.cwd() })
  } catch {
    console.log('[format] oxfmt not found — install it with: npm install -D oxfmt')
  }
} else if (command === 'build') {
  if (existsSync(resolve('svelte.config.js')) && existsSync(resolve('src/app.html'))) {
    execSync('npx vite build', { stdio: 'inherit', cwd: process.cwd() })
  } else {
    console.log('[build] No frontend to build (API-only hatk)')
  }
} else if (command === 'reset') {
  const config = await loadConfig(resolve('hatk.config.ts'))

  if (config.database !== ':memory:') {
    for (const suffix of ['', '.wal', '-shm', '-wal']) {
      const file = config.database + suffix
      if (existsSync(file)) {
        unlinkSync(file)
        console.log(`[reset] deleted ${file}`)
      }
    }
  }

  if (existsSync(resolve('docker-compose.yml'))) {
    console.log('[reset] resetting PDS...')
    execSync('docker compose down -v', { stdio: 'inherit', cwd: process.cwd() })
  }

  console.log('[reset] done')
} else if (command === 'check') {
  let failed = false

  // Lexicon schema validation
  if (existsSync(resolve('lexicons'))) {
    console.log('[check] lexicons...')
    const { validateLexicons } = await import('@bigmoves/lexicon')
    const lexicons = loadLexicons(resolve('lexicons'))
    const errors = validateLexicons([...lexicons.values()])
    if (errors) {
      for (const [nsid, errs] of Object.entries(errors)) {
        for (const err of errs as string[]) {
          console.error(`  ${nsid}: ${err}`)
        }
      }
      failed = true
    }
  }

  // Server code type checking (if tsconfig.server.json exists)
  if (existsSync(resolve('tsconfig.server.json'))) {
    console.log('[check] tsc (server)...')
    try {
      execSync('npx tsc --noEmit -p tsconfig.server.json', { stdio: 'inherit', cwd: process.cwd() })
    } catch {
      failed = true
    }
  }

  // Svelte type checking (if SvelteKit project)
  if (existsSync(resolve('svelte.config.js')) && existsSync(resolve('src/app.html'))) {
    console.log('[check] svelte-check...')
    try {
      execSync('npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json', {
        stdio: 'inherit',
        cwd: process.cwd(),
      })
    } catch {
      failed = true
    }
  }

  // Lint
  console.log('[check] oxlint...')
  try {
    execSync('npx oxlint .', { stdio: 'inherit', cwd: process.cwd() })
  } catch {
    failed = true
  }

  if (failed) process.exit(1)
} else if (command === 'test') {
  const knownFlags = new Set(['--unit', '--integration', '--browser', '--verbose'])
  const parsedFlags = args.slice(1).filter((a) => knownFlags.has(a))
  const extraArgs = args
    .slice(1)
    .filter((a) => !knownFlags.has(a))
    .join(' ')
  const flag = parsedFlags.find((f) => f !== '--verbose') || null
  const verbose = parsedFlags.includes('--verbose')
  if (!verbose && !process.env.DEBUG) process.env.DEBUG = '0'
  const runUnit = !flag || flag === '--unit'
  const runIntegration = !flag || flag === '--integration'
  const runBrowser = !flag || flag === '--browser'

  // Integration and browser tests need PDS
  if (runIntegration || runBrowser) {
    await ensurePds()
  }

  if (!existsSync(resolve(process.cwd(), 'vite.config.ts'))) {
    console.error('No vite.config.ts found. Add one with the hatk() plugin to configure tests.')
    process.exit(1)
  }

  if (runUnit) {
    console.log('[test] running unit tests...')
    try {
      execSync(`npx vitest run --project unit ${extraArgs}`, { stdio: 'inherit', cwd: process.cwd() })
    } catch (e: any) {
      if (e.status === 130) process.exit(0)
      process.exit(e.status || 1)
    }
  }

  if (runIntegration) {
    const intDir = resolve(process.cwd(), 'test/integration')
    const hasIntegrationTests = existsSync(intDir) && readdirSync(intDir).some((f) => f.endsWith('.test.ts'))
    if (hasIntegrationTests) {
      console.log('[test] running integration tests...')
      try {
        execSync(`npx vitest run --project integration ${extraArgs}`, { stdio: 'inherit', cwd: process.cwd() })
      } catch (e: any) {
        if (e.status === 130) process.exit(0)
        process.exit(e.status || 1)
      }
    }
  }

  if (runBrowser) {
    const browserDir = resolve(process.cwd(), 'test/browser')
    const hasBrowserTests =
      existsSync(browserDir) && readdirSync(browserDir).some((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'))
    if (hasBrowserTests) {
      console.log('[test] running browser tests...')
      try {
        execSync(`npx playwright test ${extraArgs}`, { stdio: 'inherit', cwd: process.cwd() })
      } catch (e: any) {
        if (e.status === 130) process.exit(0)
        process.exit(e.status || 1)
      }
    }
  }
} else if (command === 'seed') {
  await ensurePds()
  runSeed()
} else if (command === 'resolve') {
  const nsid = args[1]
  if (!nsid) {
    console.error('Usage: hatk resolve <nsid>')
    process.exit(1)
  }

  const { resolveLexicon } = await import('./lexicon-resolve.ts')
  console.log(`Resolving ${nsid} from registry...`)
  const resolved = await resolveLexicon(nsid)

  if (resolved.size === 0) {
    console.error(`Could not resolve ${nsid}`)
    process.exit(1)
  }

  for (const [id, lexicon] of resolved) {
    const parts = id.split('.')
    const lexDir = join('lexicons', ...parts.slice(0, -1))
    const filePath = join(lexDir, `${parts[parts.length - 1]}.json`)
    mkdirSync(lexDir, { recursive: true })
    writeFileSync(filePath, JSON.stringify(lexicon, null, 2) + '\n')
    console.log(`  wrote ${filePath}`)
  }

  console.log(`\nResolved ${resolved.size} lexicon(s). Regenerating types...`)
  execSync('npx hatk generate types', { stdio: 'inherit', cwd: process.cwd() })
} else if (command === 'schema') {
  const config = await loadConfig(resolve('hatk.config.ts'))

  const { initDatabase, getSchemaDump } = await import('./database/db.ts')
  const { createAdapter } = await import('./database/adapter-factory.ts')
  const { getDialect } = await import('./database/dialect.ts')
  const configDir2 = resolve('.')
  const lexicons2 = loadLexicons(resolve(configDir2, 'lexicons'))
  const collections2 = config.collections.length > 0 ? config.collections : discoverCollections(lexicons2)
  const { schemas: schemas2, ddlStatements: ddl2 } = buildSchemas(
    lexicons2,
    collections2,
    getDialect(config.databaseEngine),
  )

  if (config.database !== ':memory:') {
    mkdirSync(dirname(config.database), { recursive: true })
  }
  const { adapter: adapter2 } = await createAdapter(config.databaseEngine)
  await initDatabase(adapter2, config.database, schemas2, ddl2)

  console.log(await getSchemaDump())
} else if (command === 'start') {
  const mainPath = resolve(import.meta.dirname!, 'main.js')
  await spawnForward('npx', ['tsx', mainPath, 'hatk.config.ts'])
} else {
  usage()
}
