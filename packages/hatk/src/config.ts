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
  /**
   * Scopes requested only from PDSes that serve `whenMethod`, discovered
   * through `community.lexicon.service.describe` before the authorization
   * request is pushed.
   *
   * For optional protocol features — permissioned spaces (proposal 0016) being
   * the first — where asking every PDS for the scope would put a permission on
   * the consent screen that most servers cannot honor.
   */
  conditionalScopes?: ConditionalScopeConfig[]
}

export interface ConditionalScopeConfig {
  /** An XRPC method whose presence means the PDS implements the feature. */
  whenMethod: string
  scopes: string[]
}

/**
 * A record that names another repo worth tracking.
 *
 * Backfill and the stream find repos by what they write into the signal
 * collections. Some repos matter because a record points at them instead: a
 * community's roster names its members, and a member's own repo — their
 * profile first of all — is what puts a name and a face on everything they
 * write. Each reference says which collection carries such a record and which
 * field holds the DID.
 */
export interface RepoReference {
  collection: string
  /** Dot path to the DID inside the record, or `$rkey` when the record key is the DID. */
  field: string
}

export interface BackfillConfig {
  signalCollections?: string[] // defaults to top-level collections
  repos?: string[] // pin specific DIDs to backfill
  /** Records that name repos to track; see {@link RepoReference}. */
  references?: RepoReference[]
  fullNetwork: boolean
  parallelism: number
  fetchTimeout: number // seconds
  maxRetries: number // max retry attempts for failed repos (default 5)
}

export interface ApnsPushConfig {
  keyFile: string
  keyId: string
  teamId: string
  bundleId: string
  production?: boolean // defaults to true; set false for sandbox
}

/**
 * Firebase Cloud Messaging, for Android devices.
 *
 * `keyFile` is a Google service-account JSON carrying the Firebase Messaging
 * role, resolved relative to the config file like the APNs key. The project id
 * comes from that file unless it's overridden here.
 */
export interface FcmPushConfig {
  keyFile: string
  projectId?: string
}

/** Either transport may stand alone; a platform without one simply isn't sent to. */
export interface PushConfig {
  apns?: ApnsPushConfig
  fcm?: FcmPushConfig
}

export interface CdnConfig {
  url: string // CDN base URL (e.g. https://cdn.grain.social)
  key: string // hex-encoded HMAC key for imgproxy URL signing
  salt: string // hex-encoded HMAC salt for imgproxy URL signing
}

/**
 * Indexing permissioned spaces (proposal 0016).
 *
 * A space's records never reach a firehose, so they are read from the
 * authority and each writer's own host instead. Doing that at all requires
 * `oauth`: hatk is a member of nothing and borrows a signed-in member's
 * delegation to get a credential, so with no sessions there is no way in.
 *
 * Absent by default. An instance that does not set this indexes nothing from a
 * space and serves no space rows, which is what every existing deployment does
 * today.
 */
export interface SpacesConfig {
  /**
   * Space type NSIDs to follow. A space of any other type is refused rather
   * than indexed, so a lexicon vendored for reference cannot quietly become a
   * subscription.
   */
  types: string[]
  /** Space refs to follow at boot, for the spaces an instance always wants. */
  watch?: string[]
  /**
   * Seconds between reconcile sweeps. Write notices are best-effort — the
   * reference host forwards each once and logs the failure — so the sweep is
   * what makes sync correct rather than merely prompt.
   */
  reconcileInterval?: number
  /**
   * This instance's own DID, for receiving write notices — e.g.
   * `did:web:appview.example.com`. hatk serves the matching document at
   * `/.well-known/did.json`, so the DID has to resolve to this origin.
   *
   * Without it the sweep is the only thing that notices a write, which is
   * correct but no faster than the interval. The DID publishes no signing key:
   * notices are only ever verified here, never signed.
   */
  serviceDid?: string
  /**
   * The service entry notices are delivered to, named in the DID document and
   * in every registration. Its own fragment rather than the bare DID, so a
   * notice cannot be confused with one addressed to an account.
   */
  serviceFragment?: string
}

export interface JetstreamConfig {
  /** Instance base URL, e.g. `wss://jetstream.us-east.bsky.network`. */
  url: string
}

export interface HatkConfig {
  relay: string
  /**
   * Additional `subscribeRepos` sources tailed alongside `relay`, each with
   * its own cursor. For repos whose PDS is not behind the relay — a dev stack
   * with more than one PDS, a self-hosted network — tail the PDS directly
   * instead of standing up a relay to merge the streams. Ignored when
   * `jetstream` is set (Jetstream is the sole source then).
   */
  relays: string[]
  /**
   * Consume the stream from a Jetstream v2 instance instead of `relay`.
   *
   * Jetstream filters server-side and delivers records as decoded JSON, so an
   * AppView tracking a few collections stops paying to decode the whole
   * network. Not every deployment has one — a local PDS or self-hosted relay
   * won't — so `relay` stays the default.
   */
  jetstream: JetstreamConfig | null
  plc: string // PLC directory URL for DID resolution
  port: number
  cdn: CdnConfig | null // CDN with imgproxy URL signing (null to use cdn.bsky.app)
  databaseEngine: 'duckdb' | 'sqlite' // which database adapter to use
  database: string // database file path (replaces :memory:)
  publicDir: string | null // static file directory (null to disable)
  collections: string[] // optional — auto-derived from lexicons if empty
  privateCollections: string[] // never served by the built-in dev.hatk.* record endpoints
  backfill: BackfillConfig
  ftsRebuildInterval: number // rebuild FTS index every N writes (lower = fresher search)
  oauth: OAuthConfig | null
  push: PushConfig | null // push notification delivery (null to disable)
  admins: string[] // DIDs allowed to access /admin/* endpoints
  spaces: SpacesConfig | null // permissioned-space indexing (null to disable)
}

/** Input type for defineConfig — fields that have defaults are optional. */
export type HatkConfigInput = Partial<
  Omit<HatkConfig, 'oauth' | 'backfill' | 'push' | 'cdn' | 'jetstream' | 'spaces'>
> & {
  cdn?: CdnConfig | null
  oauth?: (Partial<OAuthConfig> & { clients: OAuthClientConfig[] }) | null
  backfill?: Partial<BackfillConfig>
  push?: PushConfig | null
  jetstream?: JetstreamConfig | null
  spaces?: SpacesConfig | null
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
    relays: env.RELAYS
      ? env.RELAYS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : parsed.relays || [],
    jetstream: env.JETSTREAM_URL ? { url: env.JETSTREAM_URL } : parsed.jetstream || null,
    plc: env.DID_PLC_URL || parsed.plc || 'https://plc.directory',
    port: parseInt(env.PORT || '') || parsed.port || 3000,
    databaseEngine: (env.DATABASE_ENGINE || parsed.databaseEngine || 'sqlite') as HatkConfig['databaseEngine'],
    database: database ? resolve(configDir, database) : ':memory:',
    publicDir: parsed.publicDir === null ? null : resolve(configDir, parsed.publicDir || './public'),
    collections: parsed.collections || [],
    privateCollections: parsed.privateCollections || [],
    backfill: {
      signalCollections: backfillRaw.signalCollections || undefined,
      references: backfillRaw.references || undefined,
      repos: env.BACKFILL_REPOS ? env.BACKFILL_REPOS.split(',').map((s) => s.trim()) : backfillRaw.repos || undefined,
      fullNetwork: env.BACKFILL_FULL_NETWORK ? env.BACKFILL_FULL_NETWORK === 'true' : backfillRaw.fullNetwork || false,
      parallelism: parseInt(env.BACKFILL_PARALLELISM || '') || backfillRaw.parallelism || 3,
      fetchTimeout: parseInt(env.BACKFILL_FETCH_TIMEOUT || '') || backfillRaw.fetchTimeout || 300,
      maxRetries: parseInt(env.BACKFILL_MAX_RETRIES || '') || backfillRaw.maxRetries || 5,
    },
    ftsRebuildInterval: parseInt(env.FTS_REBUILD_INTERVAL || '') || parsed.ftsRebuildInterval || 5000,
    cdn:
      env.CDN_URL && env.CDN_KEY && env.CDN_SALT
        ? { url: env.CDN_URL, key: env.CDN_KEY, salt: env.CDN_SALT }
        : parsed.cdn || null,
    oauth: null,
    push: parsed.push || null,
    admins: env.ADMINS ? env.ADMINS.split(',').map((s) => s.trim()) : parsed.admins || [],
    spaces: parsed.spaces
      ? {
          types: parsed.spaces.types || [],
          watch: env.SPACES_WATCH
            ? env.SPACES_WATCH.split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : parsed.spaces.watch || [],
          reconcileInterval: parseInt(env.SPACES_RECONCILE_INTERVAL || '') || parsed.spaces.reconcileInterval || 300,
          serviceDid: env.SPACES_SERVICE_DID || parsed.spaces.serviceDid || undefined,
          serviceFragment: parsed.spaces.serviceFragment || 'atproto_space_syncer',
        }
      : null,
  }

  const oauthRaw = parsed.oauth
  if (oauthRaw) {
    config.oauth = {
      issuer: process.env.OAUTH_ISSUER || oauthRaw.issuer || `http://127.0.0.1:${config.port}`,
      scopes: oauthRaw.scopes || ['atproto'],
      clients: oauthRaw.clients || [],
      conditionalScopes: oauthRaw.conditionalScopes || [],
    }
  }

  return config
}
