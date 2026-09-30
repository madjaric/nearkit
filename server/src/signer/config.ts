import { resolve } from 'node:path'
import { NETWORKS, type NetworkConfig, type NetworkId } from '@/config/networks'
import { feeRecipientProblem, MAX_SLIPPAGE } from '@/lib/fees'
import { parseKek } from '../custody/vault'
import type { DatabaseConfig } from '../db/open'
import type { LogLevel } from '../log'
import { parseAuthKey } from './auth'
import { parseKeyArn } from './kms'
import { parseTlsPin, type TlsPin } from './tls'

/**
 * The signer service's configuration (server/src/signer/main.ts), from its own
 * environment. It fails closed: anything missing or doubtful stops it from starting,
 * and mainnet asks for everything production needs, with no fallback:
 *
 * - NEARKIT_MAINNET_CUSTODY=enabled, the owner's explicit go-live switch;
 * - a KMS key (a KEK in the environment is testnet-only);
 * - PostgreSQL (its own database and credentials);
 * - the production fee account, exactly;
 * - two or more RPC providers that must agree;
 * - TLS, unless it listens on this machine only.
 */

export interface SignerServiceConfig {
  network: NetworkConfig
  /** SECRET: the shared request-signing key. Never logged. */
  authKey: Buffer
  database: DatabaseConfig
  kek:
    | { kind: 'kms'; current: string; previous: string[] }
    | { kind: 'local'; current: Buffer; previous: Buffer[] }
    /** OpenBao transit (openbao.ts). The token is SECRET: never logged. */
    | { kind: 'openbao'; addr: string; mount: string; key: string; token: string; tlsPin: TlsPin | null }
  /** NEP-413 recipient owner signatures must name: the NearKit web app's host. */
  recipient: string
  feeRecipient: string | null
  rpc: { urls: string[]; quorum: number }
  maxSlippagePpm: number
  /** TLS from a certificate pair, or from a folder where the signer makes and keeps its own (signer/tls.ts). */
  listen: { host: string; port: number; tls: { certPath: string; keyPath: string } | { dir: string } | null }
  pause: { byEnv: boolean; file: string | null }
  logLevel: LogLevel
}

export interface ConfigIssue {
  key: string
  message: string
}

const blank = (v: string | undefined): v is undefined => v === undefined || v.trim() === ''
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function loadSignerConfig(raw: Record<string, string | undefined>): { config: SignerServiceConfig | null; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = []
  const issue = (key: string, message: string) => void issues.push({ key, message })

  const netRaw = raw.NEAR_NETWORK?.trim()
  if (netRaw !== 'mainnet' && netRaw !== 'testnet') issue('NEAR_NETWORK', 'Set "testnet" or "mainnet" explicitly for the signer')
  const networkId: NetworkId = netRaw === 'mainnet' ? 'mainnet' : 'testnet'
  const mainnet = netRaw === 'mainnet'

  if (mainnet && raw.NEARKIT_MAINNET_CUSTODY?.trim() !== 'enabled')
    issue('NEARKIT_MAINNET_CUSTODY', 'Mainnet custody is off. Only the owner turns it on, at go-live, with NEARKIT_MAINNET_CUSTODY=enabled')

  // SECRET values are never shown, not even in an issue.
  const authKey = parseAuthKey(raw.NEARKIT_SIGNER_AUTH_KEY)
  if (!authKey) issue('NEARKIT_SIGNER_AUTH_KEY', 'Must be 32 random bytes in base64, the same on the app (value not shown)')

  let kek: SignerServiceConfig['kek'] | null = null
  const arn = raw.NEARKIT_KMS_KEY_ARN?.trim()
  const localKek = raw.NEARKIT_SIGNER_KEK?.trim()
  const baoAddr = raw.NEARKIT_OPENBAO_ADDR?.trim()
  if (baoAddr) {
    // The KEK in OpenBao transit, self-hosted (openbao.ts).
    if (arn || localKek) issue('NEARKIT_OPENBAO_ADDR', 'Set one key-encryption key: OpenBao, an AWS KMS key, or (testnet) a local KEK')
    let url: URL | null = null
    try {
      url = new URL(baoAddr)
    } catch {
      url = null
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) issue('NEARKIT_OPENBAO_ADDR', 'Must be OpenBao’s https:// address')
    else if (url.protocol === 'http:' && (mainnet || !LOCAL_HOSTS.has(url.hostname)))
      issue('NEARKIT_OPENBAO_ADDR', 'OpenBao is reached over https:// (http:// only on this machine, and never on mainnet)')
    const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
    const mount = raw.NEARKIT_OPENBAO_TRANSIT_MOUNT?.trim() || 'transit'
    const key = raw.NEARKIT_OPENBAO_TRANSIT_KEY?.trim() || 'nearkit-wallets'
    if (!NAME.test(mount)) issue('NEARKIT_OPENBAO_TRANSIT_MOUNT', 'A transit mount name: lowercase letters, digits, - and _')
    if (!NAME.test(key)) issue('NEARKIT_OPENBAO_TRANSIT_KEY', 'A transit key name: lowercase letters, digits, - and _')
    const token = raw.NEARKIT_OPENBAO_TOKEN?.trim() ?? ''
    if (token.length < 16 || /\s/.test(token)) issue('NEARKIT_OPENBAO_TOKEN', 'The signer’s OpenBao token (value not shown)')
    const pinRaw = raw.NEARKIT_OPENBAO_TLS_PIN
    const tlsPin = blank(pinRaw) ? null : parseTlsPin(pinRaw)
    if (!blank(pinRaw) && !tlsPin) issue('NEARKIT_OPENBAO_TLS_PIN', 'Must be OpenBao’s certificate: base64 of its DER')
    if (url && token) kek = { kind: 'openbao', addr: url.origin, mount, key, token, tlsPin }
  } else if (arn) {
    const parsed = parseKeyArn(arn)
    const previous = (raw.NEARKIT_KMS_PREVIOUS_KEY_ARNS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!parsed) issue('NEARKIT_KMS_KEY_ARN', 'Must be an AWS KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>); aliases are not accepted')
    for (const p of previous) if (!parseKeyArn(p)) issue('NEARKIT_KMS_PREVIOUS_KEY_ARNS', `${p} is not an AWS KMS key ARN`)
    if (localKek) issue('NEARKIT_SIGNER_KEK', 'Set either a KMS key or a local KEK, not both')
    if (parsed) kek = { kind: 'kms', current: parsed.arn, previous }
  } else if (localKek) {
    const current = parseKek(localKek)
    const previous = (raw.NEARKIT_SIGNER_KEK_PREVIOUS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseKek(s))
    if (!current || previous.some((p) => !p)) issue('NEARKIT_SIGNER_KEK', 'Must be 32 random bytes in base64 (value not shown)')
    if (mainnet) issue('NEARKIT_SIGNER_KEK', 'A key-encryption key in the environment is for testnet only; mainnet needs NEARKIT_KMS_KEY_ARN')
    if (current && previous.every((p) => p)) kek = { kind: 'local', current, previous: previous as Buffer[] }
  } else {
    issue(
      'NEARKIT_KMS_KEY_ARN',
      mainnet ? 'Mainnet needs a KMS: NEARKIT_OPENBAO_ADDR or NEARKIT_KMS_KEY_ARN' : 'Set NEARKIT_OPENBAO_ADDR or NEARKIT_KMS_KEY_ARN, or NEARKIT_SIGNER_KEK on testnet',
    )
  }

  let database: DatabaseConfig | null = null
  if (!blank(raw.NEARKIT_SIGNER_DATABASE_URL)) {
    const url = raw.NEARKIT_SIGNER_DATABASE_URL.trim()
    let protocol = ''
    try {
      protocol = new URL(url).protocol
    } catch {
      // refused below
    }
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') issue('NEARKIT_SIGNER_DATABASE_URL', 'Must be a postgres:// connection URL (value not shown)')
    else database = { kind: 'postgres', url }
  } else if (mainnet) {
    issue('NEARKIT_SIGNER_DATABASE_URL', 'Mainnet needs PostgreSQL: the signer’s own database and credentials')
  } else {
    database = { kind: 'sqlite', path: resolve(blank(raw.NEARKIT_SIGNER_DB_PATH) ? `server/data/signer-${networkId}.sqlite` : raw.NEARKIT_SIGNER_DB_PATH.trim()) }
  }

  const recipient = raw.NEARKIT_SIGNER_RECIPIENT?.trim() ?? ''
  if (!/^[a-z0-9.-]{1,253}$/.test(recipient)) issue('NEARKIT_SIGNER_RECIPIENT', 'The NearKit web app’s host name, e.g. nearkit.vercel.app')
  else if (mainnet && LOCAL_HOSTS.has(recipient)) issue('NEARKIT_SIGNER_RECIPIENT', 'A local host name is not a production web app')

  const feeRecipient = blank(raw.NEARKIT_FEE_RECIPIENT) ? null : raw.NEARKIT_FEE_RECIPIENT.trim()
  const feeProblem = feeRecipientProblem(networkId, feeRecipient)
  if (feeProblem) issue('NEARKIT_FEE_RECIPIENT', feeProblem)
  if (!mainnet && feeRecipient) issue('NEARKIT_FEE_RECIPIENT', 'Testnet charges no NearKit fee: leave it empty')

  const urls = (blank(raw.NEARKIT_SIGNER_RPC_URLS) ? [...NETWORKS[networkId].rpcUrls] : raw.NEARKIT_SIGNER_RPC_URLS.split(',')).map((u) => u.trim()).filter(Boolean)
  for (const u of urls) {
    let ok = false
    try {
      const parsed = new URL(u)
      ok = parsed.protocol === 'https:' || (!mainnet && parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname))
    } catch {
      ok = false
    }
    if (!ok) issue('NEARKIT_SIGNER_RPC_URLS', `${u} must be an https:// URL`)
  }
  const quorumRaw = raw.NEARKIT_SIGNER_RPC_QUORUM?.trim()
  const quorum = blank(quorumRaw) ? (mainnet ? 2 : 1) : Number(quorumRaw)
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > urls.length)
    issue('NEARKIT_SIGNER_RPC_QUORUM', `Must be a whole number from 1 to the number of RPC URLs (${urls.length})`)
  if (mainnet && (urls.length < 2 || quorum < 2)) issue('NEARKIT_SIGNER_RPC_QUORUM', 'Mainnet needs at least two RPC providers that agree (quorum 2 or more)')

  const slippageRaw = raw.NEARKIT_SIGNER_MAX_SLIPPAGE_PCT?.trim()
  const slippage = blank(slippageRaw) ? MAX_SLIPPAGE : Number(slippageRaw)
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > MAX_SLIPPAGE) issue('NEARKIT_SIGNER_MAX_SLIPPAGE_PCT', `Must be above 0 and at most ${MAX_SLIPPAGE}`)

  const host = blank(raw.NEARKIT_SIGNER_HOST) ? '127.0.0.1' : raw.NEARKIT_SIGNER_HOST.trim()
  const port = blank(raw.NEARKIT_SIGNER_PORT) ? 8790 : Number(raw.NEARKIT_SIGNER_PORT)
  // 0: any free port (tests).
  if (!Number.isInteger(port) || port < 0 || port > 65535) issue('NEARKIT_SIGNER_PORT', 'Must be a port number between 1 and 65535')
  const cert = raw.NEARKIT_SIGNER_TLS_CERT?.trim()
  const key = raw.NEARKIT_SIGNER_TLS_KEY?.trim()
  if (Boolean(cert) !== Boolean(key)) issue('NEARKIT_SIGNER_TLS_CERT', 'Set both NEARKIT_SIGNER_TLS_CERT and NEARKIT_SIGNER_TLS_KEY, or neither')
  const tlsDir = raw.NEARKIT_SIGNER_TLS_DIR?.trim()
  if (tlsDir && (cert || key))
    issue(
      'NEARKIT_SIGNER_TLS_DIR',
      'Set either NEARKIT_SIGNER_TLS_DIR (a certificate the signer makes and keeps there) or NEARKIT_SIGNER_TLS_CERT and NEARKIT_SIGNER_TLS_KEY, not both',
    )
  const tls = tlsDir ? { dir: resolve(tlsDir) } : cert && key ? { certPath: resolve(cert), keyPath: resolve(key) } : null
  if (mainnet && !tls && !LOCAL_HOSTS.has(host)) issue('NEARKIT_SIGNER_TLS_CERT', 'On mainnet the signer serves TLS unless it listens on this machine only (127.0.0.1)')

  const pausedRaw = raw.NEARKIT_SIGNER_PAUSED?.trim()
  if (!blank(pausedRaw) && pausedRaw !== 'true' && pausedRaw !== 'false') issue('NEARKIT_SIGNER_PAUSED', 'Expected "true" or "false"')
  const levelRaw = raw.LOG_LEVEL?.trim() ?? 'info'
  const logLevel: LogLevel = levelRaw === 'debug' || levelRaw === 'warn' || levelRaw === 'error' ? levelRaw : 'info'

  if (issues.length || !authKey || !kek || !database) return { config: null, issues }
  return {
    config: {
      network: { ...NETWORKS[networkId], rpcUrls: urls },
      authKey,
      database,
      kek,
      recipient,
      feeRecipient,
      rpc: { urls, quorum },
      maxSlippagePpm: Math.round(slippage * 10_000),
      listen: { host, port, tls },
      pause: { byEnv: pausedRaw === 'true', file: blank(raw.NEARKIT_SIGNER_PAUSE_FILE) ? null : resolve(raw.NEARKIT_SIGNER_PAUSE_FILE.trim()) },
      logLevel,
    },
    issues,
  }
}
