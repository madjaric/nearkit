/**
 * Every external NEAR endpoint and contract NearKit talks to, per network.
 * This is the only module that names contract accounts or service hosts; all
 * values were verified live on 2026-09-28 (see PHASE2_IMPLEMENTATION.md §4).
 * Token metadata (symbol, decimals) is never written here: it is read from chain.
 */

export type NetworkId = 'mainnet' | 'testnet'

export interface RheaNetworkConfig {
  /** Classic exchange (v2.ref-finance.near) and its Smart Router `findPath` host. */
  classic: { exchange: string; findPathUrl: string }
  /**
   * Smart Router V2 / Aggregated DEX: server-signed routes executed by the aggregator
   * contract. It carries Rhea's app-fee mechanism. Mainnet only.
   */
  aggregator: RheaAggregatorConfig | null
  /** Rhea indexer for USD prices and pool data. Null where no usable data exists. */
  indexerUrl: string | null
}

export interface RheaAggregatorConfig {
  contract: string
  quoteUrl: string
  /**
   * Public key Rhea's quote server signs routes with. It is compiled into the
   * aggregator contract (read from its code on 2026-09-28); the contract rejects
   * anything else. If Rhea rotates it, quotes fail verification and NearKit
   * refuses to sign until this value is updated.
   */
  signerKey: string
  /** DEX contracts a signed route may hand tokens to. */
  dexReceivers: readonly string[]
  /** Referral accounts Rhea injects into its own routes (seen on every live route, 2026-09-28). Any other is refused. */
  referrals: readonly string[]
  /** `tokens_storage_deposit` price per token (yocto): 0.005 NEAR per Rhea's docs and two real transactions. */
  tokenStorageDeposit: string
  /** Rhea's share of the app fee, in bps of the fee (20%), per Rhea's docs and on-chain `earn_app_*` events. */
  appFeeRouterShareBps: number
}

export interface NetworkConfig {
  id: NetworkId
  label: 'Mainnet' | 'Testnet'
  /** Failover order: first is primary. All send CORS headers (verified). */
  rpcUrls: readonly string[]
  explorerUrl: string
  /** Wrapped NEAR (NEP-141), used for swaps. */
  wrapContract: string
  discovery: {
    /** FastNEAR API base: `/v1/account/{id}/ft`. */
    fastnearUrl: string
    /** NearBlocks API base and which account-assets endpoint works on this network. */
    nearblocksUrl: string
    nearblocksAssets: 'v3' | 'v1'
    /** FastNEAR transaction API (account first-activity lookups). */
    fastnearTxUrl: string
  }
  /** NEAR/USD ticker sources; null on testnet (testnet NEAR has no price). */
  nearUsd: { coinbase: string; coingecko: string } | null
  rhea: RheaNetworkConfig
  /** Contract IDs NearKit lists by default. Metadata is always fetched from chain. */
  knownTokens: readonly string[]
  /** Token the trade tickets open on. */
  defaultTradeToken: string
  /**
   * USD stablecoins, valued at face value in PnL (a trade paid in one has a known USD
   * value). Empty on testnet, where no token has a price.
   */
  stableTokens: readonly { contract: string; decimals: number }[]
}

export const NETWORKS: Readonly<Record<NetworkId, NetworkConfig>> = Object.freeze({
  mainnet: Object.freeze({
    id: 'mainnet',
    label: 'Mainnet',
    rpcUrls: Object.freeze(['https://free.rpc.fastnear.com', 'https://rpc.intea.rs', 'https://near.drpc.org']),
    explorerUrl: 'https://nearblocks.io',
    wrapContract: 'wrap.near',
    discovery: Object.freeze({
      fastnearUrl: 'https://api.fastnear.com',
      nearblocksUrl: 'https://api.nearblocks.io',
      nearblocksAssets: 'v3',
      fastnearTxUrl: 'https://tx.main.fastnear.com',
    }),
    nearUsd: Object.freeze({
      coinbase: 'https://api.exchange.coinbase.com/products/NEAR-USD',
      coingecko: 'https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_24hr_change=true',
    }),
    rhea: Object.freeze({
      classic: Object.freeze({ exchange: 'v2.ref-finance.near', findPathUrl: 'https://smartrouter.rhea.finance/findPath' }),
      aggregator: Object.freeze({
        contract: 'aggregatedex.near',
        quoteUrl: 'https://smartx.rhea.finance/swapMultiDexPath',
        signerKey: 'ed25519:ErtuMcHm3nX3jRWWNkR8fodpbJvX2mK3rKnjHQN77d9K',
        dexReceivers: Object.freeze(['v2.ref-finance.near', 'dclv2.ref-labs.near']),
        referrals: Object.freeze(['onebot.near']),
        tokenStorageDeposit: '5000000000000000000000',
        appFeeRouterShareBps: 2000,
      }),
      indexerUrl: 'https://api.rhea.finance',
    }),
    knownTokens: Object.freeze([
      'wrap.near',
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // native USDC
      'usdt.tether-token.near',
      'blackdragon.tkn.near',
      'token.0xshitzu.near',
    ]),
    defaultTradeToken: 'blackdragon.tkn.near',
    stableTokens: Object.freeze([
      Object.freeze({ contract: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 }),
      Object.freeze({ contract: 'usdt.tether-token.near', decimals: 6 }),
    ]),
  }),
  testnet: Object.freeze({
    id: 'testnet',
    label: 'Testnet',
    rpcUrls: Object.freeze(['https://test.rpc.fastnear.com', 'https://testnet-rpc.intea.rs', 'https://near-testnet.drpc.org']),
    explorerUrl: 'https://testnet.nearblocks.io',
    wrapContract: 'wrap.testnet',
    discovery: Object.freeze({
      fastnearUrl: 'https://test.api.fastnear.com',
      nearblocksUrl: 'https://api-testnet.nearblocks.io',
      nearblocksAssets: 'v1',
      fastnearTxUrl: 'https://tx.test.fastnear.com',
    }),
    nearUsd: null,
    rhea: Object.freeze({
      // Rhea's own app uses this host for testnet routing; there is no testnet aggregator.
      classic: Object.freeze({ exchange: 'ref-finance-101.testnet', findPathUrl: 'https://smartroutertest.refburrow.top/findPath' }),
      aggregator: null,
      indexerUrl: null,
    }),
    // Testnet tokens with the deepest wrap.testnet pools on ref-finance-101.testnet (verified 2026-09-28).
    knownTokens: Object.freeze(['wrap.testnet', 'usdt.itachicara.testnet', 'usdc.itachicara.testnet', 'ref.fakes.testnet']),
    defaultTradeToken: 'usdt.itachicara.testnet',
    stableTokens: Object.freeze([]),
  }),
})

/** The native token's ID inside NearKit. Every other token ID is its NEP-141 contract account. */
export const NATIVE_TOKEN_ID = 'near'
export const NEAR_DECIMALS = 24
