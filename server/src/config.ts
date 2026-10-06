import { resolve } from 'node:path'
import { parseEnv, type AppEnv, type EnvIssue } from '@/config/env'
import { NETWORKS, type NetworkConfig } from '@/config/networks'
import { DEFAULT_PUBLIC_URL } from '@/config/site'
import { feeRecipientProblem } from '@/lib/fees'
import { SWITCHES, type SwitchName } from './ops/switches'
import { parseTlsPin, type TlsPin } from './signer/tls'
import type { DatabaseConfig } from './db/open'
import { parseKek } from './custody/vault'
import type { LogLevel } from './log'
import { parseAuthKey } from './signer/auth'

/**
 * Server configuration, from environment variables (a local run also reads the
 * git-ignored `server/.env.local`). Validation reuses the web app's rules
 * (`parseEnv`) so an account ID or RPC URL means the same thing in both places.
 * The NearKit fee account is an ordinary, replaceable setting: nothing here
 * names or defaults it.
 */

export interface ServerConfig {
  /** Secret. Null runs the API without the bot. Never logged. */
  telegramToken: string | null
  /** The bot the token must belong to (TELEGRAM_BOT_USERNAME); the server refuses another one. */
  telegramBotUsername: string | null
  /** Bot API server: Telegram's, or a self-hosted telegram-bot-api. */
  telegramApiUrl: string
  env: AppEnv
  network: NetworkConfig
  /** NearKit web app the bot links to (account linking, trade review). No trailing slash. */
  webUrl: string
  /** NEP-413 `recipient` a link signature must name: the web app's host. */
  linkRecipient: string
  /**
   * trustProxy: the API is reached only through one reverse proxy of ours (e.g. Caddy), so a
   * client's address is the last X-Forwarded-For entry (the one the proxy wrote), for rate limits.
   */
  api: { host: string; port: number; publicUrl: string; allowedOrigins: string[]; trustProxy: boolean }
  /** SQLite file path (kept for the SQLite engine and logs). */
  dbPath: string
  /**
   * The database: PostgreSQL when NEARKIT_DATABASE_URL is set (production; its URL is a
   * secret and never logged), else the SQLite file at dbPath.
   */
  database: DatabaseConfig
  /**
   * Buy alerts. They only read the chain, so they may follow another network than
   * the bot's trading (e.g. mainnet buys while trading is the testnet beta).
   */
  buybot: {
    enabled: boolean
    network: NetworkConfig
    dataUrl: string
    /** 'app': this process follows and posts; 'separate': it only handles /buybot settings, `npm run buybot` posts. */
    runner: 'app' | 'separate'
  }
  /** The Volume Bot's worker: 'app' runs it in this process (with NEARKITS wallets on); 'off' runs no bot here. */
  volumeBot: { runner: 'app' | 'off' }
  /**
   * NearKit trading wallets. Their keys live with NearKit's signer: in this process on
   * testnet (a KEK in the environment), or the separate signer service (NEARKIT_SIGNER_URL).
   * Mainnet custody needs the owner's switch (NEARKIT_MAINNET_CUSTODY=enabled), the signer
   * service, PostgreSQL and the production fee account: without one of them it stays off,
   * and with the switch on but something missing the server refuses to start.
   */
  custody: { enabled: boolean; reason: string | null; signer: CustodySigner | null }
  /** Kill switches the host holds paused from its environment (NEARKIT_OPS_PAUSED), for hosts without a shell. */
  ops: { hostPaused: SwitchName[] }
  logLevel: LogLevel
}

export type CustodySigner = { kind: 'in-process'; kek: Buffer } | { kind: 'remote'; url: string; authKey: Buffer; tlsPin: TlsPin | null }

export type ConfigIssue = EnvIssue

const SERVER_NAMES: Record<string, string> = {
  VITE_NEAR_NETWORK: 'NEAR_NETWORK',
  VITE_NEAR_RPC_URL: 'NEAR_RPC_URL',
  VITE_NEARKIT_FEE_RECIPIENT: 'NEARKIT_FEE_RECIPIENT',
  VITE_KIT_TOKEN_CONTRACT: 'KIT_TOKEN_CONTRACT',
}

const blank = (v: string | undefined): v is undefined => v === undefined || v.trim() === ''

/** The web app when NEARKIT_WEB_URL is unset: NearKit's public address, the same one the web app names as canonical. */
const DEFAULT_WEB_URL = DEFAULT_PUBLIC_URL

function httpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u : null
  } catch {
    return null
  }
}

export function loadConfig(raw: Record<string, string | undefined>): { config: ServerConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = []
  const issue = (key: string, message: string) => issues.push({ key, message })

  const parsed = parseEnv({
    VITE_NEARKIT_SERVICES: 'near',
    VITE_NEAR_NETWORK: raw.NEAR_NETWORK,
    VITE_NEAR_RPC_URL: raw.NEAR_RPC_URL,
    // The server never signs; execution is decided by the web app the user signs in.
    VITE_ENABLE_MAINNET_EXECUTION: 'false',
    VITE_NEARKIT_FEE_RECIPIENT: raw.NEARKIT_FEE_RECIPIENT,
    VITE_KIT_TOKEN_CONTRACT: raw.KIT_TOKEN_CONTRACT,
  })
  for (const i of parsed.issues) issue(SERVER_NAMES[i.key] ?? i.key, i.message.replace(/VITE_/g, ''))
  const env = parsed.env
  const base = NETWORKS[env.network]
  const network: NetworkConfig = { ...base, rpcUrls: env.rpcUrls ?? [...base.rpcUrls] }

  let telegramToken: string | null = null
  if (!blank(raw.TELEGRAM_BOT_TOKEN)) {
    const token = raw.TELEGRAM_BOT_TOKEN.trim()
    if (/^\d{5,16}:[A-Za-z0-9_-]{30,}$/.test(token)) telegramToken = token
    else issue('TELEGRAM_BOT_TOKEN', 'Not shaped like a bot token from @BotFather (value not shown)')
  }

  let telegramBotUsername: string | null = null
  if (!blank(raw.TELEGRAM_BOT_USERNAME)) {
    const name = raw.TELEGRAM_BOT_USERNAME.trim().replace(/^@/, '')
    if (/^[A-Za-z][A-Za-z0-9_]{3,30}bot$/i.test(name)) telegramBotUsername = name
    else issue('TELEGRAM_BOT_USERNAME', `${name} is not a Telegram bot username (letters, digits and _, ending in "bot")`)
  }

  const tgApi = blank(raw.TELEGRAM_API_URL) ? new URL('https://api.telegram.org') : httpUrl(raw.TELEGRAM_API_URL)
  if (!tgApi) issue('TELEGRAM_API_URL', 'Must be an https:// URL (http:// only for localhost)')

  const web = httpUrl(blank(raw.NEARKIT_WEB_URL) ? DEFAULT_WEB_URL : raw.NEARKIT_WEB_URL)
  if (!web) issue('NEARKIT_WEB_URL', 'Must be an https:// URL (http:// only for localhost)')
  const webUrl = (web?.origin ?? DEFAULT_WEB_URL) + (web && web.pathname !== '/' ? web.pathname.replace(/\/$/, '') : '')

  // NEARKIT_API_PORT wins; hosts such as Railway assign one in PORT.
  const portKey = blank(raw.NEARKIT_API_PORT) ? 'PORT' : 'NEARKIT_API_PORT'
  const portRaw = raw[portKey]
  const port = blank(portRaw) ? 8787 : Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) issue(portKey, 'Must be a port number between 1 and 65535')
  const publicApi = blank(raw.NEARKIT_API_PUBLIC_URL) ? null : httpUrl(raw.NEARKIT_API_PUBLIC_URL)
  if (!blank(raw.NEARKIT_API_PUBLIC_URL) && !publicApi) issue('NEARKIT_API_PUBLIC_URL', 'Must be an https:// URL (http:// only for localhost)')

  const origins = blank(raw.NEARKIT_API_ALLOWED_ORIGINS)
    ? [web?.origin ?? DEFAULT_WEB_URL]
    : raw.NEARKIT_API_ALLOWED_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  const allowedOrigins: string[] = []
  for (const o of origins) {
    const u = httpUrl(o)
    if (!u) issue('NEARKIT_API_ALLOWED_ORIGINS', `${o} is not an https:// origin (http:// only for localhost)`)
    else allowedOrigins.push(u.origin)
  }

  const runnerRaw = raw.BUYBOT_RUNNER?.trim()
  if (!blank(runnerRaw) && runnerRaw !== 'app' && runnerRaw !== 'separate') issue('BUYBOT_RUNNER', 'Expected "app" or "separate"')
  const volumeRunnerRaw = raw.NEARKIT_VOLUMEBOT_RUNNER?.trim()
  if (!blank(volumeRunnerRaw) && volumeRunnerRaw !== 'app' && volumeRunnerRaw !== 'off') issue('NEARKIT_VOLUMEBOT_RUNNER', 'Expected "app" or "off"')
  const buybotRaw = raw.BUYBOT_ENABLED?.trim()
  if (!blank(buybotRaw) && buybotRaw !== 'true' && buybotRaw !== 'false') issue('BUYBOT_ENABLED', 'Expected "true" or "false"')
  const bbNetRaw = raw.BUYBOT_NETWORK?.trim()
  if (!blank(bbNetRaw) && bbNetRaw !== 'mainnet' && bbNetRaw !== 'testnet') issue('BUYBOT_NETWORK', `Expected "mainnet" or "testnet", got "${bbNetRaw}"`)
  // Buy alerts matter where tokens have real value: mainnet unless set otherwise. Read-only either way.
  const bbId: NetworkConfig['id'] = bbNetRaw === 'mainnet' || bbNetRaw === 'testnet' ? bbNetRaw : 'mainnet'
  let bbRpc: string[] | null = null
  if (!blank(raw.BUYBOT_RPC_URL)) {
    const urls = raw.BUYBOT_RPC_URL.split(',')
      .map((u) => httpUrl(u))
      .filter((u): u is URL => u !== null)
      .map((u) => u.toString().replace(/\/$/, ''))
    if (!urls.length) issue('BUYBOT_RPC_URL', 'Every RPC URL must be https:// (http:// only for localhost)')
    else bbRpc = urls
  }
  const bbNetwork: NetworkConfig =
    bbId === network.id && !bbRpc ? network : { ...NETWORKS[bbId], rpcUrls: bbRpc ?? (bbId === network.id ? network.rpcUrls : [...NETWORKS[bbId].rpcUrls]) }
  // FastNEAR's transaction index for the buybot's network (the same host NearKit uses for discovery).
  const dataUrl = blank(raw.BUYBOT_DATA_URL) ? NETWORKS[bbId].discovery.fastnearTxUrl : (httpUrl(raw.BUYBOT_DATA_URL)?.origin ?? null)
  if (dataUrl === null) issue('BUYBOT_DATA_URL', 'Must be an https:// URL (http:// only for localhost)')

  // The fee account: on mainnet exactly the production one, when set (unset blocks fee-bearing trades).
  const feeProblem = env.feeRecipient ? feeRecipientProblem(network.id, env.feeRecipient) : null
  if (feeProblem) issue('NEARKIT_FEE_RECIPIENT', feeProblem)

  const dbPath = resolve(blank(raw.NEARKIT_DB_PATH) ? `server/data/nearkit-${network.id}.sqlite` : raw.NEARKIT_DB_PATH.trim())
  // SECRET: the Postgres URL carries the database password. Never shown, not even in an issue.
  let database: DatabaseConfig = { kind: 'sqlite', path: dbPath }
  if (!blank(raw.NEARKIT_DATABASE_URL)) {
    const url = raw.NEARKIT_DATABASE_URL.trim()
    let protocol = ''
    try {
      protocol = new URL(url).protocol
    } catch {
      // refused below
    }
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') issue('NEARKIT_DATABASE_URL', 'Must be a postgres:// connection URL (value not shown)')
    else database = { kind: 'postgres', url }
  }

  // SECRET values below are never shown, not even in an issue.
  const mainnet = network.id === 'mainnet'
  const kekRaw = raw.NEARKIT_WALLET_KEK
  const kek = blank(kekRaw) ? null : parseKek(kekRaw)
  if (!blank(kekRaw) && !kek) issue('NEARKIT_WALLET_KEK', 'Must be 32 random bytes in base64 (value not shown). Create one with npm run server:wallet-key')
  if (!blank(kekRaw) && mainnet)
    issue('NEARKIT_WALLET_KEK', 'A key-encryption key in the app’s environment is for testnet only. Mainnet keys live with the signer service and its KMS: remove it')
  let remote: { url: string; authKey: Buffer; tlsPin: TlsPin | null } | null = null
  if (!blank(raw.NEARKIT_SIGNER_URL) || !blank(raw.NEARKIT_SIGNER_AUTH_KEY)) {
    const url = blank(raw.NEARKIT_SIGNER_URL) ? null : httpUrl(raw.NEARKIT_SIGNER_URL)
    const authKey = parseAuthKey(raw.NEARKIT_SIGNER_AUTH_KEY)
    if (!url) issue('NEARKIT_SIGNER_URL', 'The signer service’s https:// URL (http:// only for localhost)')
    if (!authKey) issue('NEARKIT_SIGNER_AUTH_KEY', 'Must be 32 random bytes in base64, the same as the signer’s (value not shown)')
    // The signer's own certificate, when it has no certificate from a public authority (signer/tls.ts).
    const pinRaw = raw.NEARKIT_SIGNER_TLS_PIN
    const tlsPin = blank(pinRaw) ? null : parseTlsPin(pinRaw)
    if (!blank(pinRaw) && !tlsPin) issue('NEARKIT_SIGNER_TLS_PIN', 'Must be the signer’s certificate pin: base64 of its DER, as the signer logs it at start')
    if (tlsPin && url && url.protocol !== 'https:') issue('NEARKIT_SIGNER_TLS_PIN', 'A certificate pin needs an https:// signer URL')
    if (url && authKey) remote = { url: url.origin + url.pathname.replace(/\/$/, ''), authKey, tlsPin }
  }
  const mainnetSwitch = raw.NEARKIT_MAINNET_CUSTODY?.trim()
  if (!blank(mainnetSwitch) && mainnetSwitch !== 'enabled' && mainnetSwitch !== 'off') issue('NEARKIT_MAINNET_CUSTODY', 'Expected "enabled" or "off"')
  let custody: ServerConfig['custody']
  if (mainnet) {
    if (mainnetSwitch !== 'enabled') {
      custody = { enabled: false, reason: 'NEARKITS trading wallets are off on mainnet until the owner turns them on at go-live.', signer: null }
    } else {
      // The owner's switch is on: every production requirement must hold, or the server doesn't start.
      if (!remote) issue('NEARKIT_SIGNER_URL', 'Mainnet custody needs the separate signer service (NEARKIT_SIGNER_URL and NEARKIT_SIGNER_AUTH_KEY)')
      if (blank(raw.NEARKIT_DATABASE_URL)) issue('NEARKIT_DATABASE_URL', 'Mainnet custody needs PostgreSQL')
      if (!env.feeRecipient) issue('NEARKIT_FEE_RECIPIENT', 'Mainnet custody needs the production fee account')
      if (remote && remote.url.startsWith('http://')) issue('NEARKIT_SIGNER_URL', 'On mainnet the signer is reached over https:// (TLS)')
      // Owner signatures name the web app's host: on mainnet it is a real https host, never a local one.
      if (!web || web.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(web.hostname))
        issue('NEARKIT_WEB_URL', 'Mainnet custody needs the production web app’s https:// URL (owner signatures name its host)')
      custody = { enabled: remote !== null, reason: remote ? null : 'The signer service is not configured.', signer: remote ? { kind: 'remote', ...remote } : null }
    }
  } else if (remote) {
    custody = { enabled: true, reason: null, signer: { kind: 'remote', ...remote } }
  } else if (kek) {
    custody = { enabled: true, reason: null, signer: { kind: 'in-process', kek } }
  } else {
    custody = { enabled: false, reason: 'NEARKITS trading wallets need NEARKIT_WALLET_KEK (testnet) or the signer service on this server.', signer: null }
  }

  const hostPaused = (raw.NEARKIT_OPS_PAUSED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const unknownSwitch = hostPaused.filter((s) => !SWITCHES.includes(s as SwitchName))
  if (unknownSwitch.length) issue('NEARKIT_OPS_PAUSED', `Not a kill switch: ${unknownSwitch.join(', ')} (expected ${SWITCHES.join(', ')})`)

  const trustProxyRaw = raw.NEARKIT_API_TRUST_PROXY?.trim()
  if (!blank(trustProxyRaw) && trustProxyRaw !== 'true' && trustProxyRaw !== 'false') issue('NEARKIT_API_TRUST_PROXY', 'Expected "true" or "false"')

  const levelRaw = raw.LOG_LEVEL?.trim() ?? 'info'
  const logLevel: LogLevel = levelRaw === 'debug' || levelRaw === 'warn' || levelRaw === 'error' ? levelRaw : 'info'

  return {
    config: {
      telegramToken,
      telegramBotUsername,
      telegramApiUrl: tgApi ? tgApi.origin + tgApi.pathname.replace(/\/$/, '') : 'https://api.telegram.org',
      env,
      network,
      webUrl,
      linkRecipient: web?.hostname ?? new URL(DEFAULT_WEB_URL).hostname,
      api: {
        host: blank(raw.NEARKIT_API_HOST) ? '127.0.0.1' : raw.NEARKIT_API_HOST.trim(),
        port: Number.isInteger(port) ? port : 8787,
        publicUrl: publicApi ? publicApi.origin + publicApi.pathname.replace(/\/$/, '') : `http://localhost:${Number.isInteger(port) ? port : 8787}`,
        allowedOrigins,
        trustProxy: trustProxyRaw === 'true',
      },
      dbPath,
      database,
      buybot: {
        enabled: buybotRaw !== 'false',
        network: bbNetwork,
        dataUrl: dataUrl ?? NETWORKS[bbId].discovery.fastnearTxUrl,
        runner: runnerRaw === 'separate' ? 'separate' : 'app',
      },
      volumeBot: { runner: volumeRunnerRaw === 'off' ? 'off' : 'app' },
      custody,
      ops: { hostPaused: hostPaused.filter((s): s is SwitchName => SWITCHES.includes(s as SwitchName)) },
      logLevel,
    },
    issues,
  }
}
