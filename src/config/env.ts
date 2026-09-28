import { accountIdError, isForeignToNetwork } from '@/lib/validation'
import { NETWORKS, type NetworkConfig, type NetworkId } from './networks'

/**
 * Build-time configuration. This module is the only reader of `import.meta.env`.
 * Values are validated once; anything ambiguous is reported as an issue and the
 * app refuses to start rather than guessing (fail closed).
 */

export type ServicesMode = 'near' | 'demo'

export interface AppEnv {
  services: ServicesMode
  network: NetworkId
  /** Explicit RPC override (comma-separated in env). Null uses the network defaults. */
  rpcUrls: string[] | null
  /** Value-moving actions on mainnet run only when this is true. */
  mainnetExecution: boolean
  /** Account that receives the NearKit app fee. Public, not a secret. */
  feeRecipient: string | null
  /** $KIT NEP-141 contract, once launched. */
  kitContract: string | null
}

export interface EnvIssue {
  key: string
  message: string
}

type RawEnv = Partial<Record<keyof ImportMetaEnv, string | undefined>>

const blank = (v: string | undefined) => v === undefined || v.trim() === ''

function parseRpcUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.toString().replace(/\/$/, '')
    return null
  } catch {
    return null
  }
}

export function parseEnv(raw: RawEnv): { env: AppEnv; issues: EnvIssue[] } {
  const issues: EnvIssue[] = []
  const issue = (key: string, message: string) => issues.push({ key, message })

  const servicesRaw = raw.VITE_NEARKIT_SERVICES?.trim()
  const services: ServicesMode = blank(servicesRaw) ? 'near' : servicesRaw === 'near' || servicesRaw === 'demo' ? servicesRaw : 'near'
  if (!blank(servicesRaw) && servicesRaw !== 'near' && servicesRaw !== 'demo') issue('VITE_NEARKIT_SERVICES', `Expected "near" or "demo", got "${servicesRaw}"`)

  const networkRaw = raw.VITE_NEAR_NETWORK?.trim()
  const network: NetworkId = blank(networkRaw) ? 'testnet' : networkRaw === 'mainnet' || networkRaw === 'testnet' ? networkRaw : 'testnet'
  if (!blank(networkRaw) && networkRaw !== 'mainnet' && networkRaw !== 'testnet') issue('VITE_NEAR_NETWORK', `Expected "mainnet" or "testnet", got "${networkRaw}"`)

  let rpcUrls: string[] | null = null
  if (!blank(raw.VITE_NEAR_RPC_URL)) {
    const parts = (raw.VITE_NEAR_RPC_URL ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const parsed = parts.map(parseRpcUrl)
    if (parsed.some((u) => u === null) || parsed.length === 0) issue('VITE_NEAR_RPC_URL', 'Every RPC URL must be https:// (http:// only for localhost)')
    else rpcUrls = parsed as string[]
  }

  const execRaw = raw.VITE_ENABLE_MAINNET_EXECUTION?.trim()
  const mainnetExecution = execRaw === 'true'
  if (!blank(execRaw) && execRaw !== 'true' && execRaw !== 'false') issue('VITE_ENABLE_MAINNET_EXECUTION', `Expected "true" or "false", got "${execRaw}"`)

  const account = (key: 'VITE_NEARKIT_FEE_RECIPIENT' | 'VITE_KIT_TOKEN_CONTRACT'): string | null => {
    const value = raw[key]?.trim()
    if (blank(value) || value === undefined) return null
    const error = accountIdError(value)
    if (error) {
      issue(key, `${value}: ${error}`)
      return null
    }
    if (isForeignToNetwork(value, network)) {
      issue(key, `${value} belongs to ${network === 'mainnet' ? 'testnet' : 'mainnet'}, but this build runs on ${network}`)
      return null
    }
    return value
  }
  const feeRecipient = account('VITE_NEARKIT_FEE_RECIPIENT')
  const kitContract = account('VITE_KIT_TOKEN_CONTRACT')

  return { env: { services, network, rpcUrls, mainnetExecution, feeRecipient, kitContract }, issues }
}

const parsed = parseEnv(import.meta.env)

/** The validated build configuration. */
export const ENV: Readonly<AppEnv> = Object.freeze(parsed.env)

/** Configuration problems; when non-empty the app shows a configuration error instead of running. */
export const ENV_ISSUES: readonly EnvIssue[] = Object.freeze(parsed.issues)

/** The active network, with the RPC override applied. Fixed for the life of the page. */
export const NETWORK: Readonly<NetworkConfig> = Object.freeze({
  ...NETWORKS[ENV.network],
  rpcUrls: Object.freeze(ENV.rpcUrls ?? [...NETWORKS[ENV.network].rpcUrls]),
})
