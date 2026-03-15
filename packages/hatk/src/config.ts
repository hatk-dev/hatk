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
  cookieName?: string
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
  databaseEngine: 'duckdb' | 'sqlite' // which database adapter to use
  database: string // database file path (replaces :memory:)
  publicDir: string | null // static file directory (null to disable)
  collections: string[] // optional — auto-derived from lexicons if empty
  backfill: BackfillConfig
  ftsRebuildInterval: number // rebuild FTS index every N writes (lower = fresher search)
  oauth: OAuthConfig | null
  admins: string[] // DIDs allowed to access /admin/* endpoints
}

/** Input type for defineConfig — fields that have defaults are optional. */
export type HatkConfigInput = Partial<Omit<HatkConfig, 'oauth' | 'backfill'>> & {
  oauth?: (Partial<OAuthConfig> & { clients: OAuthClientConfig[] }) | null
  backfill?: Partial<BackfillConfig>
}

/** Identity function that provides type inference for hatk config files. */
export function defineConfig(config: HatkConfigInput): HatkConfigInput {
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
  let mod: any
  try {
    mod = await import(/* @vite-ignore */ resolved)
  } catch (err: any) {
    console.error(`Failed to load config file: ${resolved}`)
    console.error(err.message || err)
    process.exit(1)
  }
  const parsed: HatkConfigInput & Record<string, any> = mod.default || {}

  const backfillRaw = parsed.backfill || ({} as Partial<BackfillConfig>)
  const env = process.env

  const database = env.DATABASE || parsed.database
  const config: HatkConfig = {
    relay: env.RELAY || parsed.relay || 'ws://localhost:2583',
    plc: env.DID_PLC_URL || parsed.plc || 'https://plc.directory',
    port: parseInt(env.PORT || '') || parsed.port || 3000,
    databaseEngine: (env.DATABASE_ENGINE || parsed.databaseEngine || 'sqlite') as HatkConfig['databaseEngine'],
    database: database ? resolve(configDir, database) : ':memory:',
    publicDir: parsed.publicDir === null ? null : resolve(configDir, parsed.publicDir || './public'),
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
