/**
 * NearKit domain model. Display amounts are human units (1.5 NEAR, not yoctoNEAR).
 * Anything that will be executed travels as an exact decimal string and is
 * converted to raw units inside a service (see src/lib/amounts.ts); a float
 * never becomes an on-chain amount. `null` means "unknown here", never zero.
 */

export type TokenId = string
export type WalletId = string
export type Timestamp = number

// ─── tokens & market ────────────────────────────────────────────────────────

export interface Token {
  id: TokenId
  symbol: string
  name: string
  decimals: number
  /** Contract account on NEAR; null for native NEAR and for a token not yet deployed. */
  contract: string | null
  isNative?: boolean
  status: 'listed' | 'prelaunch'
  /** Sanitized image data URL from NEP-148 metadata. */
  icon?: string | null
  /** Why the token is in the list. */
  source?: 'native' | 'known' | 'discovered' | 'imported' | 'demo'
}

export interface MarketQuote {
  tokenId: TokenId
  priceUsd: number
  priceNear: number
  /** Null where the price source doesn't report it (Rhea's price list has no 24h change). */
  change24hPct: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  updatedAt: Timestamp
}

export interface TokenListing extends Token {
  market: MarketQuote | null
}

// ─── wallets ────────────────────────────────────────────────────────────────

export interface Wallet {
  id: WalletId
  label: string
  accountId: string
  kind: 'named' | 'implicit'
  isMain: boolean
  /** `signer`: available in the connected wallet session. `watch`: read-only, added by account ID. */
  access?: 'signer' | 'watch'
}

export interface Holding {
  walletId: WalletId
  tokenId: TokenId
  /** Display amount (lossy for huge values); use `raw` for anything executed. */
  amount: number
  /** Exact raw units when known (real mode). */
  raw?: string
  /** False when only an indexer reported it; true once `ft_balance_of`/`view_account` confirmed it. */
  verified?: boolean
}

export interface WalletSnapshot extends Wallet {
  nearBalance: number
  holdings: Holding[]
  /** Null when prices are unknown (testnet). */
  valueUsd: number | null
}

export interface Session {
  accountId: string
  walletId: WalletId
  connectedAt: Timestamp
  mode: 'demo' | 'near'
  /** Wallet provider name, e.g. "Meteor Wallet". */
  walletName?: string
  /** Every account the wallet session exposes (real mode). */
  accounts?: string[]
  /** A problem that blocks execution: account from the other network, or not found on this one. */
  issue?: 'network-mismatch' | 'account-missing' | null
  /** The account on the network's explorer (real mode). */
  explorerUrl?: string | null
}

export interface WalletPreset {
  id: string
  name: string
  walletIds: WalletId[]
  note: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface PresetInput {
  name: string
  walletIds: WalletId[]
  note?: string
}

// ─── portfolio ──────────────────────────────────────────────────────────────

export interface PortfolioSummary {
  /** Null when prices are unknown (testnet). */
  valueUsd: number | null
  /** Null when PnL is not tracked. */
  pnl24hUsd: number | null
  pnl24hPct: number | null
  unrealizedPnlUsd: number | null
  availableNear: number
  availableNearUsd: number | null
  mainNear: number
  activePositions: number
  openOrders: number
  walletCount: number
  updatedAt: Timestamp
}

export interface PositionWalletShare {
  walletId: WalletId
  amount: number
}

export interface Position {
  token: Token
  balance: number
  /** Null when cost basis is not tracked: never inferred from a balance. */
  avgEntryUsd: number | null
  priceUsd: number | null
  change24hPct: number | null
  valueUsd: number | null
  /** Cost basis of the units whose cost is known (see `pnl` for what that covers). */
  costUsd: number | null
  /** Unrealized PnL of those units. */
  pnlUsd: number | null
  /** Unrealized PnL ÷ their cost basis. */
  pnlPct: number | null
  wallets: PositionWalletShare[]
  /** Real mode: PnL from the accounts' on-chain history (src/lib/pnl.ts). Undefined where not tracked. */
  pnl?: PositionPnl | null
  /** `loading`: history is still being read; figures arrive on a later refresh. */
  pnlStatus?: 'ready' | 'loading' | 'unavailable'
}

/** Why a PnL figure is partial (see src/lib/pnl.ts). */
export type PnlLimitation = 'unknown-cost-units' | 'unknown-proceeds' | 'history-incomplete' | 'no-current-price'

/** One currency's figures, in whole units (NEAR or USD). */
export interface PnlFiguresView {
  costBasis: number
  /** Per whole token. */
  avgEntry: number | null
  realized: number
  unrealized: number | null
  total: number | null
  invested: number
  /** Total PnL ÷ everything invested. */
  pnlPct: number | null
  /** Proceeds from selling units whose cost was unknown (not counted as profit). */
  unmatchedProceeds: number
  complete: boolean
}

export interface PositionEvent {
  at: Timestamp
  tx: string
  kind: 'buy' | 'sell' | 'transfer-in' | 'transfer-out'
  accountId: string
  amount: number
  valueNear: number | null
  valueUsd: number | null
  counterparty: string | null
}

export interface PositionPnl {
  method: 'average-cost'
  /** Exact: from on-chain amounts. */
  near: PnlFiguresView
  /** NEAR amounts at the hour's NEAR/USD (Coinbase), stablecoins at face. */
  usd: PnlFiguresView
  /** Units held whose cost is unknown (arrived by transfer, or paid in an unpriced token). */
  unknownCostAmount: number
  bought: { amount: number; near: number | null; usd: number | null }
  sold: { amount: number; near: number | null; usd: number | null }
  trades: number
  /** Every unit and trade is accounted for in NEAR. */
  complete: boolean
  limitations: PnlLimitation[]
  /** Newest first, at most 50. */
  history: PositionEvent[]
}

export interface ValuePoint {
  t: Timestamp
  valueUsd: number
}

export type PnlRange = '7d' | '30d' | '90d' | 'all'

export interface PnlPoint {
  t: Timestamp
  /** Realized PnL booked that day. */
  daily: number
  /** Cumulative realized PnL at end of day. */
  cumulative: number
  /** Value traded that day (entries + exits), the basis for return-on-volume. */
  volumeUsd: number
}

export interface TokenPnl {
  token: Token
  trades: number
  volumeUsd: number
  realizedUsd: number
  unrealizedUsd: number
  winRatePct: number
}

export interface ClosedTrade {
  id: string
  tokenId: TokenId
  side: TradeSide
  amount: number
  priceUsd: number
  valueUsd: number
  pnlUsd: number
  walletId: WalletId
  at: Timestamp
}

export interface PnlReport {
  range: PnlRange
  /**
   * Unit of every money field below (named …Usd for the demo's sake). Real mode uses
   * NEAR where no USD price exists (testnet). Absent means USD.
   */
  currency?: 'USD' | 'NEAR'
  /** `chain`: computed from the accounts' on-chain history. Absent: demo data. */
  source?: 'demo' | 'chain'
  /** Every trade and unit was valued; false lists why in `limitations`. */
  complete?: boolean
  limitations?: PnlLimitation[]
  /** Real mode: NEAR paid as gas by these accounts across their history (swap fees are inside trade values). */
  gasNear?: number
  points: PnlPoint[]
  realizedUsd: number
  unrealizedUsd: number
  volumeUsd: number
  feesUsd: number
  trades: number
  wins: number
  losses: number
  winRatePct: number
  byToken: TokenPnl[]
  recentTrades: ClosedTrade[]
}

export type ActivityKind = 'swap' | 'multi-trade' | 'split' | 'consolidate' | 'batch-send' | 'order' | 'automation'

export type ActivityStatus = 'pending' | 'success' | 'partial' | 'failed' | 'unknown'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  title: string
  detail: string
  at: Timestamp
  /** seed: demo history; simulated: demo action this session; nearkit: a real operation NearKit sent. */
  origin: 'seed' | 'simulated' | 'nearkit'
  /** Real operations only. */
  status?: ActivityStatus
  network?: string
  accountId?: string
  txHashes?: string[]
  explorerUrl?: string | null
}

// ─── trading ────────────────────────────────────────────────────────────────

export type TradeSide = 'buy' | 'sell'

/**
 * A swap of `amountIn` of `tokenIn` for `tokenOut`. Quick buy is NEAR → token,
 * quick sell is token → NEAR; token → token swaps hop through NEAR.
 */
export interface QuoteRequest {
  tokenIn: TokenId
  tokenOut: TokenId
  /** Exact decimal string as entered; converted with the token's decimals in the service. */
  amountIn: string
  slippagePct: number
  walletId: WalletId
}

export interface QuoteFee {
  /** NearKit fee in NEAR for display (the exact figure is in the plan); null when it can't be priced in NEAR. */
  amountNear: number | null
  amountUsd: number | null
  bps: number
  /** False where the fee is not collected (e.g. testnet). */
  charged: boolean
  /** Share NearKit receives after the router's cut, in bps of the trade (160 when Rhea keeps 20%). */
  receivedBps: number | null
  /** Router's share of the NearKit fee, in bps of the trade. */
  routerShareBps: number | null
  /** Router's own fee on every swap, in bps. */
  routerFeeBps: number | null
}

export interface Quote {
  request: QuoteRequest
  amountOut: number
  minAmountOut: number
  /** Exact raw strings where a real router quoted them. */
  amountOutRaw: string | null
  minAmountOutRaw: string | null
  /** tokenOut received per tokenIn, after fee and impact. */
  rate: number
  /** Estimated from spot prices; null when it can't be estimated (testnet). */
  priceImpactPct: number | null
  nearkitFee: QuoteFee
  networkFeeNear: number
  /** Route through pools, as token symbols. */
  path: string[]
  router: 'aggregator' | 'classic' | 'demo'
  quotedAt: Timestamp
  expiresAt: Timestamp
}

export interface MultiTradeLeg {
  walletId: WalletId
  /** Exact decimal string. */
  amountIn: string
}

export interface MultiTradeRequest {
  side: TradeSide
  tokenId: TokenId
  slippagePct: number
  legs: MultiTradeLeg[]
}

export interface MultiTradeLegQuote extends MultiTradeLeg {
  amountInValue: number
  amountOut: number
  minAmountOut: number
  nearkitFee: number
  shortfall: number
}

export interface MultiTradeQuote {
  request: MultiTradeRequest
  legs: MultiTradeLegQuote[]
  totalIn: number
  totalOut: number
  totalMinOut: number
  nearkitFeeTotal: number
  feeTokenId: TokenId
  networkFeeNear: number
  /** Null when it can't be estimated (no prices on testnet). */
  priceImpactPct: number | null
  quotedAt: Timestamp
  expiresAt: Timestamp
}

export type OrderType = 'limit' | 'take-profit' | 'stop-loss'
/** `draft`: saved in this browser in real mode; nothing watches the price or executes it. */
export type OrderStatus = 'open' | 'draft' | 'filled' | 'cancelled' | 'expired'
export type OrderExpiry = '1h' | '24h' | '7d' | '30d' | 'gtc'

export interface LimitOrder {
  id: string
  tokenId: TokenId
  side: TradeSide
  type: OrderType
  triggerPriceUsd: number
  /** Buy: NEAR to spend. Sell: tokens to sell. */
  amount: number
  walletId: WalletId
  createdAt: Timestamp
  expiresAt: Timestamp | null
  status: OrderStatus
  closedAt: Timestamp | null
}

export interface OrderInput {
  tokenId: TokenId
  side: TradeSide
  type: OrderType
  triggerPriceUsd: number
  amount: number
  walletId: WalletId
  expiry: OrderExpiry
}

// ─── wallet tools ───────────────────────────────────────────────────────────

/** One recipient of a transfer, with the exact decimal amount as shown to the user. */
export interface TransferLine {
  accountId: string
  /** Wallet label or name the user knows the recipient by. */
  label?: string
  amount: string
}

export type TransferRequest =
  | {
      kind: 'batch-send' | 'split'
      tokenId: TokenId
      sourceWalletId: WalletId
      lines: TransferLine[]
      /** Duplicate lines the parser dropped, so the review can say so. */
      skippedLines?: number
    }
  | { kind: 'consolidate'; tokenId: TokenId; destinationAccountId: string; destinationLabel?: string; sources: { walletId: WalletId; amount: string }[] }

// ─── intelligence ───────────────────────────────────────────────────────────

export type RiskLevel = 'high' | 'elevated' | 'info'

export interface RiskFlag {
  id: string
  level: RiskLevel
  label: string
  detail: string
}

/** Demo scanner report (fictional sample tokens). Real mode returns a `ChainScan`. */
export interface ScanReport {
  kind?: 'sample'
  query: string
  symbol: string
  name: string
  contract: string
  /** Sample reports are fictional tokens used to demonstrate the scanner. */
  sample: boolean
  decimals: number
  totalSupply: number
  holders: number
  top10Pct: number
  creatorPct: number
  liquidityUsd: number
  createdAt: Timestamp
  indicators: {
    contractVerified: boolean
    mintEnabled: boolean
    transferRestrictions: 'none' | 'pausable' | 'allowlist'
    liquidity: 'locked' | 'unlocked' | 'low'
  }
  holderBreakdown: { label: string; pct: number }[]
  flags: RiskFlag[]
  scannedAt: Timestamp
}

/**
 * How NearKit knows a scanner figure:
 * - `verified`: read from the chain by NearKit (RPC), exact.
 * - `derived`: computed or reported by a third party (indexer, price feed); may lag or be wrong.
 * - `unknown`: can't be established from public data, so no value is shown.
 * NearKit never condenses these into a safe/scam verdict.
 */
export type FactKind = 'verified' | 'derived' | 'unknown'

export interface ScanFact {
  id: string
  label: string
  /** Display value; null when unknown. */
  value: string | null
  kind: FactKind
  /** Where the value comes from, e.g. "RPC · ft_total_supply" or "NearBlocks indexer". */
  source: string
  note?: string
}

export interface ChainScan {
  kind: 'chain'
  query: string
  network: 'mainnet' | 'testnet'
  contract: string
  symbol: string
  name: string
  icon: string | null
  decimals: number
  facts: ScanFact[]
  /** Largest holders by indexer ranking, share of total supply. Null when the indexer didn't answer or didn't add up. */
  topHolders: { accountId: string; pct: number; burn?: boolean }[] | null
  /** Neutral observations worth a look (never a verdict). */
  observations: RiskFlag[]
  scannedAt: Timestamp
}

export type ScanResult = ScanReport | ChainScan

// ─── automation ─────────────────────────────────────────────────────────────

/** Rules are stored but nothing runs them: `standby` in the demo, `draft` (saved in this browser) in real mode. */
export type RuleStatus = 'standby' | 'draft'

export type DcaFrequency = '1h' | '4h' | '12h' | '1d' | '1w'

export interface DcaPlan {
  id: string
  tokenId: TokenId
  amountNear: number
  frequency: DcaFrequency
  startAt: Timestamp
  endAt: Timestamp | null
  walletId: WalletId
  createdAt: Timestamp
  status: RuleStatus
}

export type DcaInput = Omit<DcaPlan, 'id' | 'createdAt' | 'status'>

export type CopySide = 'buy' | 'sell' | 'both'

export type CopySizing = { mode: 'fixed'; amountNear: number } | { mode: 'percent'; pct: number }

export interface CopyRule {
  id: string
  target: string
  copy: CopySide
  sizing: CopySizing
  maxTradeNear: number
  slippagePct: number
  minTradeNear: number | null
  maxMarketCapUsd: number | null
  blacklist: string[]
  createdAt: Timestamp
  status: RuleStatus
}

export type CopyRuleInput = Omit<CopyRule, 'id' | 'createdAt' | 'status'>

export type SniperTrigger = 'liquidity-added' | 'first-trade' | 'at-time'
export type SniperPriority = 'standard' | 'fast' | 'max'

export interface SniperConfig {
  id: string
  target: string
  presetId: string
  amountNearPerWallet: number
  slippagePct: number
  trigger: SniperTrigger
  triggerAt: Timestamp | null
  priority: SniperPriority
  gasTgas: number
  retries: number
  maxMarketCapUsd: number | null
  minLiquidityUsd: number | null
  takeProfitPct: number | null
  stopLossPct: number | null
  createdAt: Timestamp
  status: RuleStatus
}

export type SniperInput = Omit<SniperConfig, 'id' | 'createdAt' | 'status'>
