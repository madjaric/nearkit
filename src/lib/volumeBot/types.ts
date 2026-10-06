/**
 * The Volume Bot's vocabulary, shared by the web console, the API and the worker that trades.
 *
 * Units: amounts the strategy reasons about are human units (`near`: NEAR, `tokens`: whole tokens)
 * held in numbers, prices are NEAR per token. Raw on-chain amounts never travel as numbers: the
 * worker converts at the execution boundary (parseUnits) and checks raw balances again there.
 */

/**
 * - `market-maker`: buys below fair value and sells above it, each trade only when its executable
 *   price (after every fee and its own price impact) beats fair value by the configured edge, with
 *   inventory skew toward the target allocation.
 * - `accumulate`: buys a NEAR budget over a period in slices (TWAP), optionally under a price cap.
 * - `distribute`: sells a token amount over a period in slices (TWAP), optionally above a price floor.
 */
export type BotStrategy = 'market-maker' | 'accumulate' | 'distribute'

export const BOT_STRATEGIES: readonly BotStrategy[] = ['market-maker', 'accumulate', 'distribute']

/**
 * - `draft`: configured, never started (or edited after a stop).
 * - `running`: the worker evaluates it on schedule.
 * - `paused`: by its owner or by the guardian (pauseReason says which and why); nothing new is sent.
 * - `stopping`: stop or emergency stop pressed; no new trades, submitted ones are being reconciled.
 * - `stopped`: stopped by its owner (or an emergency stop), state kept.
 * - `completed`: reached its own end (budget spent, amount sold, runtime or trade count reached).
 */
export type BotStatus = 'draft' | 'running' | 'paused' | 'stopping' | 'stopped' | 'completed'

export type TradeSide = 'buy' | 'sell'

/**
 * Trade size, as NEAR value:
 * - `auto`: TWAP strategies spread what remains evenly over the time that remains;
 *   the market maker uses `fixedNear`.
 * - `fixed`: `fixedNear` per trade.
 * - `range`: between `minNear` and `maxNear`, drawn per trade.
 * - `capital-pct`: `pct` % of the trading wallet's available NEAR (buys) or token value (sells).
 * - `inventory-pct`: `pct` % of the bot's token inventory value.
 */
export type SizingMode = 'auto' | 'fixed' | 'range' | 'capital-pct' | 'inventory-pct'

export interface SizingConfig {
  mode: SizingMode
  fixedNear: number
  minNear: number
  maxNear: number
  pct: number
  /** Each trade is at most this % of the pool's liquidity; 0 turns the cap off. */
  maxLiquidityPct: number
  /** When a quote's price impact is over the limit, try a smaller trade instead of skipping it. */
  adaptiveImpact: boolean
}

/** UTC hours, [from, to): `from` 22 and `to` 6 spans midnight. */
export interface HourWindow {
  from: number
  to: number
}

export interface ScheduleConfig {
  /** Seconds between evaluations, drawn between the two each time. */
  minIntervalSec: number
  maxIntervalSec: number
  /** After a trade, wait at least this long before the next one. */
  cooldownSec: number
  /** Trades in flight at once (each from a different wallet). */
  maxConcurrent: number
  /** Stop after this many confirmed trades; null: no limit. */
  maxTrades: number | null
  /** Stop after running this long; null: no limit. */
  maxRuntimeSec: number | null
  /** Trade only inside this UTC window; null: any time. */
  activeHours: HourWindow | null
  /** Never trade inside these UTC windows. */
  pauseWindows: HourWindow[]
}

export interface RiskConfig {
  maxTradeNear: number
  /** A wallet's token share of its own value may not exceed this (buys stop there). */
  maxWalletExposurePct: number
  /** The bot's token share of its value across its wallets may not exceed this. */
  maxAggregateExposurePct: number
  /** Pause when the day's PnL (UTC) falls below minus this. */
  maxDailyLossNear: number
  /** Pause when value falls this far below its peak. */
  maxDrawdownPct: number
  /** Slippage the swap accepts below its quote. */
  maxSlippageBps: number
  /** The quoted price impact a trade may have. */
  maxPriceImpactBps: number
  /** Pause below this pool liquidity (USD). */
  minLiquidityUsd: number
  /** Skip trading while the cost to cross (ask over bid) exceeds this. */
  maxSpreadBps: number
  /** NEAR each wallet always keeps for gas. */
  gasReserveNear: number
  maxConsecutiveFailures: number
  /** Guardian: pause when the price is this far from fair value, or moved this much within the guard window. */
  maxPriceMovePct: number
  /** Guardian: market data older than this is stale. */
  maxDataAgeSec: number
  /** A quote older than this is not executed. */
  maxQuoteAgeSec: number
  /** Guardian: a submitted trade not confirmed within this has timed out. */
  txTimeoutSec: number
}

export interface InventoryConfig {
  /** Target share of the bot's value held in the token, in %. */
  targetTokenPct: number
  minTokenPct: number
  maxTokenPct: number
  /** The most NEAR value the bot may hold in the token at once (its exposure cap). */
  maxNearDeployed: number
}

export interface MarketMakerConfig {
  /** How far, in bps, a trade's executable price must beat fair value (after fees and impact). */
  minEdgeBps: number
  /** 0–1: how strongly inventory away from target shifts the edge toward rebalancing. */
  skew: number
  /** Fair value: an exponential average of the mid price over about this many seconds. */
  fairValueWindowSec: number
}

export interface TwapConfig {
  /** Accumulate: NEAR to spend in all. */
  totalNear: number
  /** Distribute: tokens to sell in all. */
  totalTokens: number
  durationSec: number
  /** Accumulate: never buy above this; distribute: never sell below it (NEAR per token). Null: no limit. */
  limitPriceNear: number | null
}

export interface BotConfig {
  tokenId: string
  tokenSymbol: string
  tokenDecimals: number
  /** The quote side is NEAR: the bot buys the token with NEAR and sells it for NEAR. */
  quote: 'near'
  strategy: BotStrategy
  /** NearKit wallets the bot trades from (never watch-only, connected or frozen ones). */
  walletIds: string[]
  sizing: SizingConfig
  schedule: ScheduleConfig
  risk: RiskConfig
  inventory: InventoryConfig
  marketMaker: MarketMakerConfig
  twap: TwapConfig
}

/** One of the bot's wallets as the worker sees it at a tick. */
export interface BotWallet {
  walletId: string
  label: string
  accountId: string
  /** Spendable NEAR (liquid balance less what storage locks). */
  near: number
  tokens: number
  frozen: boolean
  /** A trade from this wallet is in flight. */
  busy: boolean
}

/**
 * The market at a tick. `ask`: NEAR paid per token buying a small amount; `bid`: NEAR received per
 * token selling one; both through the route a trade would take, after every fee.
 */
export interface MarketSnapshot {
  at: number
  midNear: number
  askNear: number | null
  bidNear: number | null
  liquidityUsd: number | null
  nearUsd: number | null
  source: string
}

/** Fair value: a time-weighted exponential average of the mid price. */
export interface FairValue {
  value: number
  at: number
  samples: number
}

/** What the bot has done so far in the current run. */
export interface RunProgress {
  startedAt: number
  /** Confirmed trades in this run. */
  trades: number
  boughtNear: number
  soldTokens: number
  lastTradeAt: number | null
  inFlight: number
}

/** The strategy's answer at a tick, before quoting. */
export type Intent =
  | { kind: 'trade'; side: TradeSide; walletId: string; sizeNear: number; reason: string; maxPriceNear: number | null; minPriceNear: number | null }
  | { kind: 'wait'; reason: string }
  | { kind: 'complete'; reason: string }

/** Why the guardian paused a bot: one code per condition, each with its own words. */
export type GuardianCode =
  | 'abnormal-price'
  | 'liquidity-collapse'
  | 'low-liquidity'
  | 'stale-market-data'
  | 'stale-quote'
  | 'rpc-degraded'
  | 'provider-failure'
  | 'unexpected-balance'
  | 'tx-timeout'
  | 'excessive-slippage'
  | 'excessive-impact'
  | 'daily-loss'
  | 'drawdown'
  | 'consecutive-failures'
  | 'operator'

export interface GuardianPause {
  code: GuardianCode
  detail: string
}

/** A quote for one trade, as the worker obtained it. */
export interface TradeQuote {
  side: TradeSide
  /** NEAR value of the trade: NEAR in for a buy, NEAR out for a sell. */
  near: number
  tokens: number
  /** NEAR per token, after every fee and the trade's own impact. */
  priceNear: number
  priceImpactBps: number | null
  at: number
}
