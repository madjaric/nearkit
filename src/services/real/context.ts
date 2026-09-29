import type { AppEnv, EnvIssue } from '@/config/env'
import type { NetworkConfig } from '@/config/networks'
import { accountState, type AccountState } from '@/services/near/account'
import { mapLimit } from '@/lib/async'
import { discoverFtHoldings } from '@/services/near/discovery'
import type { ExecutionPolicy } from '@/services/near/executor'
import { explorerTxUrl } from '@/services/near/explorer'
import { createRpcClient, type RpcClient } from '@/services/near/rpc'
import { createTokenReader, type TokenReader } from '@/services/near/tokens'
import type { WalletAdapter } from '@/services/near/wallet'
import type { Session } from '@/types/domain'
import type { Capabilities } from '../types'
import { browserStorage, createStores, type KeyValue, type Stores } from './stores'

/**
 * Everything the real services share: configuration, the RPC client, token
 * reader, stores, the wallet adapter, the execution policy and a short-lived
 * balance cache. Dependencies are injectable so the services can be tested
 * against a mocked `fetch` and a fake wallet.
 */

export interface NearContextOptions {
  env: AppEnv
  network: NetworkConfig
  issues?: readonly EnvIssue[]
  fetch?: typeof fetch
  kv?: KeyValue
  wallet?: () => Promise<WalletAdapter>
  now?: () => number
}

export interface AccountBalances {
  accountId: string
  state: AccountState | null
  /** Positive balances only. `verified` means read from chain; otherwise indexer-reported. */
  fts: { contract: string; raw: bigint; verified: boolean }[]
  at: number
}

export interface NearContext {
  env: AppEnv
  network: NetworkConfig
  rpc: RpcClient
  fetch: typeof fetch
  reader: TokenReader
  stores: Stores
  wallet: () => Promise<WalletAdapter>
  now: () => number
  policy: ExecutionPolicy
  capabilities: Capabilities
  session: { current: Session | null; restored: boolean }
  explorerTx: (hash: string) => string
  balances: {
    get(accountId: string): Promise<AccountBalances>
    invalidate(accountId?: string): void
    /** Also read these token contracts for this account for a while (tokens it just traded). */
    track(accountId: string, contracts: readonly string[]): void
  }
  /** Token contracts NearKit tracks besides discovered ones: configured, imported and $KIT. */
  trackedTokens(): string[]
}

const BALANCE_TTL_MS = 12_000
const VERIFY_LIMIT = 40

export function mainnetDisabledReason(): string {
  return 'Mainnet execution is disabled in this build (VITE_ENABLE_MAINNET_EXECUTION is not "true"). Balances and quotes work; nothing can be signed.'
}

export function createNearContext(options: NearContextOptions): NearContext {
  const { env, network } = options
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const rpc = createRpcClient({ urls: network.rpcUrls, fetch: fetchImpl })
  const kv = options.kv ?? browserStorage
  const stores = createStores(kv, network.id)
  const reader = createTokenReader(rpc, { network: network.id, persist: kv === browserStorage })
  const now = options.now ?? Date.now

  let adapter: Promise<WalletAdapter> | null = null
  const wallet =
    options.wallet ??
    (() => {
      // NEAR Connect loads on first use (restore, connect or sign), keeping it out of the first paint.
      adapter ??= __NEARKIT_E2E__
        ? import('@/services/near/testWallet').then((m) => m.createTestWalletAdapter(network))
        : import('@/services/near/wallet').then((m) => m.createNearConnectAdapter(network))
      return adapter
    })

  const executionEnabled = network.id === 'testnet' || env.mainnetExecution
  const policy: ExecutionPolicy = {
    network: network.id,
    enabled: executionEnabled,
    reason: executionEnabled ? null : mainnetDisabledReason(),
    feeRecipient: network.id === 'mainnet' ? env.feeRecipient : null,
  }

  const tradingReason = !executionEnabled
    ? mainnetDisabledReason()
    : network.id === 'mainnet' && !env.feeRecipient
      ? 'The NearKit fee account (VITE_NEARKIT_FEE_RECIPIENT) is not configured, so trades are blocked on mainnet. Transfers still work.'
      : null

  const capabilities: Capabilities = {
    mode: 'near',
    network: network.id,
    networkLabel: network.label,
    explorerUrl: network.explorerUrl,
    rpcUrls: network.rpcUrls,
    prices: network.nearUsd !== null,
    // From on-chain history: exact in NEAR, USD where the hour's NEAR price is known.
    pnl: true,
    automation: 'drafts',
    execution: {
      enabled: executionEnabled,
      simulated: false,
      reason: policy.reason,
      trading: {
        enabled: tradingReason === null,
        reason: tradingReason,
        router: network.rhea.aggregator ? 'aggregator' : 'classic',
        feeCharged: network.id === 'mainnet',
        feeRecipient: policy.feeRecipient,
      },
    },
    kitContract: env.kitContract,
    configIssues: options.issues ?? [],
  }

  const trackedTokens = () => [...new Set([...network.knownTokens, ...stores.tokens.list(), ...(env.kitContract ? [env.kitContract] : [])])]

  const cache = new Map<string, { at: number; promise: Promise<AccountBalances> }>()
  // Tokens an account just traded, read from chain directly until the indexer catches up.
  const recent = new Map<string, Map<string, number>>()
  const TRACK_MS = 15 * 60_000
  const recentOf = (accountId: string) => {
    const m = recent.get(accountId)
    if (!m) return []
    for (const [c, at] of m) if (now() - at > TRACK_MS) m.delete(c)
    return [...m.keys()]
  }
  async function loadBalances(accountId: string): Promise<AccountBalances> {
    const [state, discovered] = await Promise.all([accountState(rpc, accountId).catch(() => null), discoverFtHoldings(fetchImpl, network, accountId).catch(() => null)])
    // Discovery proposes; the chain decides. Without discovery, check the tracked tokens directly.
    const indexer = new Map((discovered ?? []).map((d) => [d.contract, d.raw]))
    const candidates = [
      ...new Set([...recentOf(accountId), ...indexer.keys(), ...(discovered ? stores.tokens.list() : trackedTokens()), ...(env.kitContract ? [env.kitContract] : [])]),
    ]
    const checked = await mapLimit(candidates.slice(0, VERIFY_LIMIT), 4, async (contract) => {
      try {
        return { contract, raw: await reader.balanceOf(contract, accountId), verified: true }
      } catch {
        const reported = indexer.get(contract)
        return reported !== undefined ? { contract, raw: reported, verified: false } : null
      }
    })
    const beyond = candidates.slice(VERIFY_LIMIT).flatMap((contract) => {
      const reported = indexer.get(contract)
      return reported !== undefined ? [{ contract, raw: reported, verified: false }] : []
    })
    const fts = [...checked, ...beyond].filter((f): f is NonNullable<typeof f> => f !== null && f.raw > 0n)
    return { accountId, state, fts, at: now() }
  }

  return {
    env,
    network,
    rpc,
    fetch: fetchImpl,
    reader,
    stores,
    wallet,
    now,
    policy,
    capabilities,
    session: { current: null, restored: false },
    explorerTx: (hash) => explorerTxUrl(network, hash),
    balances: {
      get(accountId) {
        const hit = cache.get(accountId)
        if (hit && now() - hit.at < BALANCE_TTL_MS) return hit.promise
        const promise = loadBalances(accountId)
        cache.set(accountId, { at: now(), promise })
        promise.catch(() => cache.delete(accountId))
        return promise
      },
      invalidate(accountId) {
        if (accountId) cache.delete(accountId)
        else cache.clear()
      },
      track(accountId, contracts) {
        const m = recent.get(accountId) ?? new Map<string, number>()
        for (const c of contracts) m.set(c, now())
        recent.set(accountId, m)
      },
    },
    trackedTokens,
  }
}
