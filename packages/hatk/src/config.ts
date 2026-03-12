import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import YAML from 'yaml'

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

/** Derive HTTP URL from relay WebSocket URL (ws://host → http://host) */
export function relayHttpUrl(relay: string): string {
  return relay.replace(/^ws(s?):\/\//, 'http$1://')
}

export function loadConfig(configPath: string): HatkConfig {
  const raw = readFileSync(configPath, 'utf-8')
  const parsed = YAML.parse(raw)

  const configDir = dirname(resolve(configPath))

  const backfillRaw = parsed.backfill || {}

  const env = process.env

  const database = env.DATABASE || parsed.database
  const config: HatkConfig = {
    relay: env.RELAY || parsed.relay || 'ws://localhost:2583',
    plc: env.DID_PLC_URL || parsed.plc || 'https://plc.directory',
    port: parseInt(env.PORT || '') || parsed.port || 3000,
    database: database ? resolve(configDir, database) : ':memory:',
    publicDir: parsed.public === false ? null : resolve(configDir, parsed.public || './public'),
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
