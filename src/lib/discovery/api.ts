/**
 * Launch Radar's and Top Wallets' API (DISCOVERY.md), as NEARKITS' server answers it and the web app
 * reads it. Public and read-only, except followed wallets (a NEARKITS web session). Every figure is
 * what a source reported or what the documented accounting computed from indexed swaps; a figure that
 * isn't known is null, never zero.
 */

export type LaunchPeriod = '1h' | '6h' | '24h' | '7d'
export const LAUNCH_PERIODS: readonly LaunchPeriod[] = ['1h', '6h', '24h', '7d']
export const PERIOD_MS: Readonly<Record<LaunchPeriod, number>> = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000 }

export type SourceKind = 'launchpad' | 'bridge' | 'factory' | 'direct'
export type Reputation = 'Spam' | 'Unknown' | 'NotFake' | 'Reputable'

/** The trade index behind Top Wallets and the launch-to-wallet evidence. */
export interface IndexStatus {
  /** The indexer runs on this server. */
  on: boolean
  /** Where the trade index starts (Intear's trade history, or the configured start). */
  indexStart: number
  /** The newest swap applied. */
  tradesTo: number | null
  /** Still catching up on history. */
  backfilling: boolean
  /** The newest swap is older than 10 minutes. */
  stale: boolean
  /** When the launch list was last read. */
  launchesAt: number | null
}

export interface LaunchSourceView {
  /** The parent account; null for a token without a launch source ("Direct"). */
  id: string | null
  /** A known product's name; null otherwise (shown by its account). */
  name: string | null
  kind: SourceKind
  launches: number
}

export interface LaunchRow {
  token: string
  symbol: string | null
  name: string | null
  decimals: number | null
  /** The token's first block and time (its creation). */
  createdAt: number | null
  createdHeight: number | null
  /** When NEARKITS first saw it. */
  firstSeenAt: number
  /** The account that deployed it, as the indexer saw. */
  dev: string | null
  source: LaunchSourceView
  /** The main pool's venue (Rhea DCL, Ref v1, Intear…), its id and its page. */
  venue: string | null
  mainPool: string | null
  mainPoolUrl: string | null
  priceUsd: number | null
  priceChange5m: number | null
  priceChange1h: number | null
  priceChange6h: number | null
  priceChange24h: number | null
  volume1h: number | null
  volume6h: number | null
  volume24h: number | null
  liquidityUsd: number | null
  marketCapUsd: number | null
  buys24h: number | null
  sells24h: number | null
  traders24h: number | null
  holders: number | null
  reputation: Reputation | null
  /** Share of supply (0-1) of the ten largest holders and of the dev account, infrastructure left out. */
  top10Share: number | null
  devShare: number | null
  holdersAt: number | null
  /** Distinct tracked wallets (qualified Top Wallets) that traded it in the period. */
  tracked: number
  marketAt: number | null
}

export interface LaunchesResponse {
  period: LaunchPeriod
  asOf: number
  /** When the market figures were read; stale over 5 minutes. */
  marketAt: number | null
  stale: boolean
  launches: LaunchRow[]
  sources: LaunchSourceView[]
  /** How many wallets count as tracked (qualified over 30 days). */
  trackedWallets: number
  index: IndexStatus
}

/** Extras for the rows on screen: a 24h hourly price trace (USD) and the token's own small icon. */
export type LaunchExtras = Record<string, { spark: number[] | null; thumb: string | null }>

export interface TradeView {
  ts: number
  trader: string
  side: 'buy' | 'sell'
  token: string
  symbol: string | null
  /** Whole-token amount (decimals applied), when the decimals are known. */
  amount: number | null
  /** The other side, and its whole amount. */
  counterToken: string | null
  counterSymbol: string | null
  counterAmount: number | null
  usd: number | null
  tx: string
}

export interface WalletStats {
  realized: number
  returnPct: number | null
  winRate: number | null
  closed: number
  coverage: number | null
  qualified: boolean
}

/** A tracked wallet's swaps in one token: the evidence, and the wallet's record. */
export interface SignalView {
  trader: string
  /** Qualified over 30 days; Smart Money. */
  qualified: boolean
  smart: boolean
  stats30d: WalletStats | null
  trades: { side: 'buy' | 'sell'; usd: number | null; ts: number; tx: string }[]
}

export interface Candles {
  time: number[]
  open: (number | null)[]
  high: (number | null)[]
  low: (number | null)[]
  close: (number | null)[]
  volume: (number | null)[]
}

export interface LaunchDetail {
  launch: LaunchRow
  holders: { total: number | null; top: { account: string; share: number }[]; excluded: string[]; at: number } | null
  /** Hourly USD candles (up to 7 days). */
  candles: Candles | null
  /** The latest swaps in the token. */
  trades: TradeView[]
  tradesAt: number | null
  signals: SignalView[]
  index: IndexStatus
}

export type WalletWindowKey = '7d' | '30d' | '90d' | 'all'
export const WALLET_WINDOWS: readonly WalletWindowKey[] = ['all', '7d', '30d', '90d']
export type WalletCategory = 'all' | 'smart' | 'traders' | 'early' | 'fresh'
export type WalletMetric = 'pnl' | 'return' | 'winrate' | 'activity'
export type QualifyReason = 'closed-trades' | 'one-token' | 'coverage' | 'history'

export interface WalletRow {
  rank: number
  trader: string
  realized: number
  returnPct: number | null
  winRate: number | null
  closed: number
  wins: number
  avgGain: number | null
  avgLoss: number | null
  buyUsd: number
  sellUsd: number
  unmatchedUsd: number
  coverage: number | null
  tokensSold: number
  qualified: boolean
  reasons: QualifyReason[]
  automated: boolean
  categories: WalletCategory[]
  firstTs: number
  lastTs: number
  last: { side: 'buy' | 'sell'; token: string; symbol: string | null; usd: number | null; tx: string; ts: number } | null
  topTokens: { token: string; symbol: string | null }[]
}

export interface WalletsResponse {
  window: WalletWindowKey
  metric: WalletMetric
  category: WalletCategory
  asOf: number
  /** The window's days, and how many the index covers. */
  coverage: { days: number | null; covered: number }
  rows: WalletRow[]
  counts: { wallets: number; qualified: number }
  /** Fresh Wallets needs 28 indexed days. */
  freshAvailable: boolean
  index: IndexStatus
}

export interface WalletTokenView {
  token: string
  symbol: string | null
  realized: number
  closed: number
  wins: number
  buys: number
  sells: number
  buyUsd: number
  sellUsd: number
  /** The open position built from indexed buys: its cost, and an estimate of its value now. */
  open: boolean
  cost: number
  valueUsd: number | null
  unrealized: number | null
  /** Some of the open units have no known cost (bought without a price). */
  unknownCost: boolean
  avgHoldMs: number | null
  firstBuyAt: number | null
  lastAt: number | null
}

export interface WalletDetail {
  trader: string
  windows: Record<WalletWindowKey, Omit<WalletRow, 'rank' | 'last' | 'topTokens'> | null>
  /** Per UTC day: realized PnL, its running total from the first indexed day, and activity. */
  days: { day: number; realized: number; cumulative: number; closed: number; wins: number; legs: number }[]
  maxDrawdown: number
  tokens: WalletTokenView[]
  unrealized: { value: number | null; positions: number; unknown: number }
  holding: { avgMs: number | null; closedPositions: number }
  trades: TradeView[]
  firstTs: number | null
  lastTs: number | null
  automated: boolean
  smart: boolean
  index: IndexStatus
}

export interface WalletTradesPage {
  trades: TradeView[]
  nextCursor: string | null
}

export interface FollowView {
  account: string
  alerts: boolean
  createdAt: number
}

/** At most this many followed wallets per user (alerts). */
export const MAX_FOLLOWS = 50
