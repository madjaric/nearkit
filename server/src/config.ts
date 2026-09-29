import { resolve } from 'node:path'
import { parseEnv, type AppEnv, type EnvIssue } from '@/config/env'
import { NETWORKS, type NetworkConfig } from '@/config/networks'
import type { LogLevel } from './log'

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
  /** Bot API server: Telegram's, or a self-hosted telegram-bot-api. */
  telegramApiUrl: string
  env: AppEnv
  network: NetworkConfig
  /** NearKit web app the bot links to (account linking, trade review). No trailing slash. */
  webUrl: string
  /** NEP-413 `recipient` a link signature must name: the web app's host. */
  linkRecipient: string
  api: { host: string; port: number; publicUrl: string; allowedOrigins: string[] }
  dbPath: string
  buybot: { enabled: boolean; dataUrl: string }
  logLevel: LogLevel
}

export type ConfigIssue = EnvIssue

const SERVER_NAMES: Record<string, string> = {
  VITE_NEAR_NETWORK: 'NEAR_NETWORK',
  VITE_NEAR_RPC_URL: 'NEAR_RPC_URL',
  VITE_NEARKIT_FEE_RECIPIENT: 'NEARKIT_FEE_RECIPIENT',
  VITE_KIT_TOKEN_CONTRACT: 'KIT_TOKEN_CONTRACT',
}

const NEARDATA: Record<NetworkConfig['id'], string> = { mainnet: 'https://mainnet.neardata.xyz', testnet: 'https://testnet.neardata.xyz' }

const blank = (v: string | undefined): v is undefined => v === undefined || v.trim() === ''

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

  const tgApi = blank(raw.TELEGRAM_API_URL) ? new URL('https://api.telegram.org') : httpUrl(raw.TELEGRAM_API_URL)
  if (!tgApi) issue('TELEGRAM_API_URL', 'Must be an https:// URL (http:// only for localhost)')

  const web = httpUrl(blank(raw.NEARKIT_WEB_URL) ? 'https://nearkit.vercel.app' : raw.NEARKIT_WEB_URL)
  if (!web) issue('NEARKIT_WEB_URL', 'Must be an https:// URL (http:// only for localhost)')
  const webUrl = (web?.origin ?? 'https://nearkit.vercel.app') + (web && web.pathname !== '/' ? web.pathname.replace(/\/$/, '') : '')

  const port = blank(raw.NEARKIT_API_PORT) ? 8787 : Number(raw.NEARKIT_API_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) issue('NEARKIT_API_PORT', 'Must be a port number between 1 and 65535')
  const publicApi = blank(raw.NEARKIT_API_PUBLIC_URL) ? null : httpUrl(raw.NEARKIT_API_PUBLIC_URL)
  if (!blank(raw.NEARKIT_API_PUBLIC_URL) && !publicApi) issue('NEARKIT_API_PUBLIC_URL', 'Must be an https:// URL (http:// only for localhost)')

  const origins = blank(raw.NEARKIT_API_ALLOWED_ORIGINS)
    ? [web?.origin ?? 'https://nearkit.vercel.app']
    : raw.NEARKIT_API_ALLOWED_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  const allowedOrigins: string[] = []
  for (const o of origins) {
    const u = httpUrl(o)
    if (!u) issue('NEARKIT_API_ALLOWED_ORIGINS', `${o} is not an https:// origin (http:// only for localhost)`)
    else allowedOrigins.push(u.origin)
  }

  const buybotRaw = raw.BUYBOT_ENABLED?.trim()
  if (!blank(buybotRaw) && buybotRaw !== 'true' && buybotRaw !== 'false') issue('BUYBOT_ENABLED', 'Expected "true" or "false"')
  const dataUrl = blank(raw.BUYBOT_DATA_URL) ? NEARDATA[network.id] : (httpUrl(raw.BUYBOT_DATA_URL)?.origin ?? null)
  if (dataUrl === null) issue('BUYBOT_DATA_URL', 'Must be an https:// URL (http:// only for localhost)')

  const levelRaw = raw.LOG_LEVEL?.trim() ?? 'info'
  const logLevel: LogLevel = levelRaw === 'debug' || levelRaw === 'warn' || levelRaw === 'error' ? levelRaw : 'info'

  return {
    config: {
      telegramToken,
      telegramApiUrl: tgApi ? tgApi.origin + tgApi.pathname.replace(/\/$/, '') : 'https://api.telegram.org',
      env,
      network,
      webUrl,
      linkRecipient: web?.hostname ?? 'nearkit.vercel.app',
      api: {
        host: blank(raw.NEARKIT_API_HOST) ? '127.0.0.1' : raw.NEARKIT_API_HOST.trim(),
        port: Number.isInteger(port) ? port : 8787,
        publicUrl: publicApi ? publicApi.origin + publicApi.pathname.replace(/\/$/, '') : `http://localhost:${Number.isInteger(port) ? port : 8787}`,
        allowedOrigins,
      },
      dbPath: resolve(blank(raw.NEARKIT_DB_PATH) ? `server/data/nearkit-${network.id}.sqlite` : raw.NEARKIT_DB_PATH.trim()),
      buybot: { enabled: buybotRaw !== 'false', dataUrl: dataUrl ?? NEARDATA[network.id] },
      logLevel,
    },
    issues,
  }
}
