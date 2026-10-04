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

/** A token screen's chart window, looking back from now. */
export type ChartRange = '1H' | '4H' | '1D' | '1W' | '1M'

/** One observed USD price: from a history source, or seen live by this page. */
export interface PricePoint {
  t: Timestamp
  usd: number
}

/** Real market prices over a window: a history source's candle closes, oldest first. */
export interface PriceHistory {
  points: PricePoint[]
  /** Where the candles come from, and which market they are of (e.g. "SINGULARTY/wNEAR on Rhea"). */
  source: { name: string; market: string }
  /** The candle size, in seconds. A window shows only the candles that had trades. */
  candleSec: number
  /** When this market started, when known: a window reaching further back has nothing before it. */
  since: Timestamp | null
}

/**
 * One figure of a token's market data, with where it comes from, or why there is none. A
 * figure is never invented: `unavailable` says what is missing, `not-applicable` what can't
 * exist (testnet, NEAR's "liquidity"), and `stale` keeps the last known value when its source
 * stops answering, saying so.
 */
export type MarketFigure =
  | { state: 'known'; value: number; source: string; at: Timestamp }
  | { state: 'stale'; value: number; source: string; at: Timestamp; reason: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'not-applicable'; reason: string }

/** The market a token's figures are read from: its deepest indexed pair. */
export interface TokenMarketPair {
  /** The pair's id at its DEX (Rhea's DCL pools: `refv2-<x>:<y>:<fee>`). */
  id: string
  dex: string
  baseSymbol: string
  /** What the token is priced against on this pair. */
  quoteSymbol: string
  createdAt: Timestamp | null
  /** The pair's page at the data source, when it has one. */
  url: string | null
  /** Buys and sells on it in the last 24 h. */
  txns24h: { buys: number; sells: number } | null
}

/** A token's market data for its screen. Each figure says where it comes from or why it is missing. */
export interface TokenMarket {
  tokenId: TokenId
  priceUsd: MarketFigure
  /** The price in NEAR: the pair's own quote when it is wNEAR, else USD over NEAR's price. */
  priceNear: MarketFigure
  change24hPct: MarketFigure
  /** Circulating supply × price, only from a source that knows the circulating supply. */
  marketCapUsd: MarketFigure
  /** Total supply × price. */
  fdvUsd: MarketFigure
  liquidityUsd: MarketFigure
  volume24hUsd: MarketFigure
  /** Supplies the sources report, in whole tokens. */
  supply: { circulating: number | null; total: number | null; source: string | null }
  pair: TokenMarketPair | null
  updatedAt: Timestamp
}

/** A buy or sell of a token against NEAR, as the chain recorded it. */
export interface TokenTrade {
  hash: string
  side: TradeSide
  /** Who started it: the buyer or seller. */
  account: string
  /** Tokens bought or sold, raw units. */
  amount: string
  /** yoctoNEAR paid (buy) or received (sell), without gas and storage deposits. */
  near: string
  at: Timestamp
}

// ─── wallets ────────────────────────────────────────────────────────────────

export interface Wallet {
  id: WalletId
  label: string
  accountId: string
  kind: 'named' | 'implicit'
  isMain: boolean
  /** `signer`: can act (a NearKit wallet, or in the connected wallet session). `watch`: read-only. */
  access?: 'signer' | 'watch'
  /**
   * Where its authority comes from. `nearkit`: a NearKit wallet of the signed-in Telegram user,
   * executed by NearKit's server (from NearKit web or Telegram). `external`: an account of the connected
   * wallet, signed there. `watch`: observed only (added by ID, or connected before but not now).
   * See `src/lib/wallets.ts`.
   */
  source?: 'nearkit' | 'external' | 'watch'
  /** A NearKit wallet's id on NearKit's server (every server call names it by this). */
  nearkitId?: string
  /** A NearKit wallet's owner wallet; null: controlled by the user's Telegram account. */
  owner?: string | null
  /** A NearKit wallet NearKit froze for the user's protection: it doesn't trade or send. */
  frozen?: boolean
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

/**
 * One account object as the wallet returned it, cut down to plain fields (src/lib/walletDetails.ts),
 * so the user can see what the wallet sent. Shown, never used to decide anything.
 */
export interface WalletAccountDetail {
  /** Its `accountId`: the field NearKit reads (NEAR Connect's). Null when it had none. */
  accountId: string | null
  publicKey: string | null
  /** Its other plain fields as `name=value`, values cut short; never one whose name looks secret. */
  extra: string[]
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
  /** What the wallet returned for its accounts (real mode), for the user to see. Never used to decide anything. */
  walletDetails?: WalletAccountDetail[]
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
  /** Every wallet NearKit shows, watch-only ones included. */
  walletCount: number
  /** The wallets the figures above are made of: never a watch-only one. */
  executableWalletCount: number
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
  /** Null when unknown (sales whose results aren't known). Never 0 for unknown. */
  realizedUsd: number | null
  /** Null when unknown (no current price, or no unit with a known cost). Never 0 for unknown. */
  unrealizedUsd: number | null
  winRatePct: number
  /** Sales with a known result in the range: the win rate covers these only. Absent in demo data, where every trade is closed. */
  closed?: number
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
  /** Real mode: NEAR paid as gas by these accounts over the history read (swap fees are inside trade values). */
  gasNear?: number
  /** Real mode: the history read. Not complete when it was capped: older trades and gas are not in this report. */
  history?: { complete: boolean; txs: number }
  points: PnlPoint[]
  /** Null when unknown; `limitations` says why. Never 0 for unknown. */
  realizedUsd: number | null
  /** Open positions now; null when none has a known figure. Never 0 for unknown. */
  unrealizedUsd: number | null
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
  router: 'aggregator' | 'classic' | 'dcl' | 'demo'
  /** Where the route comes from (Rhea's aggregator, Rhea's classic router, DCL directly); absent in the demo. */
  source?: 'rhea-aggregator' | 'rhea-classic' | 'dcl'
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
