import type { BotMetrics } from './metrics'
import type { Health } from './risk'
import type { BotConfig, BotStatus, BotStrategy, FairValue, MarketSnapshot, RunProgress, TradeSide } from './types'

/**
 * The Volume Bot console's API, as NEARKITS's server answers it and NEARKITS web reads it
 * (server/src/volumebot/routes.ts). Every figure comes from the bot's executed trades and the
 * market it last read: nothing here is projected or planned.
 */

/** A bot as its list shows it: what it trades, how, its status and why, and its run's headline figures. */
export interface BotSummary {
  id: string
  token: string
  symbol: string
  strategy: BotStrategy
  status: BotStatus
  /** Why it is paused: `owner`, or the guardian's code. */
  pauseCode: string | null
  pauseReason: string | null
  /** Why it last waited or skipped a trade (running bots). */
  waiting: string | null
  startedAt: number | null
  stoppedAt: number | null
  walletIds: string[]
  runtimeSec: number
  /** Confirmed trades in the current run. */
  trades: number
  failed: number
  volumeNear: number
  /** Realized and unrealized, at the last price read; null before the first read. */
  pnlNear: number | null
  /** PnL over the value the run started with, in %; null until both are known. */
  roiPct: number | null
  /** When the worker looks at it next (a running bot). */
  nextTickAt: number | null
  priceNear: number | null
  inFlight: number
  lastTradeAt: number | null
  updatedAt: number
}

/** One of the bot's wallets: what it held at the bot's last read, and what it did. */
export interface BotWalletView {
  walletId: string
  name: string
  accountId: string | null
  frozen: boolean
  near: number | null
  tokens: number | null
  exposurePct: number | null
  pnlNear: number | null
  trades: number
  volumeNear: number
}

export interface BotTradeView {
  id: number
  at: number
  walletId: string
  side: TradeSide
  /** `submitted`: sent, not settled yet. Only `confirmed` trades count anywhere. */
  status: 'submitted' | 'confirmed' | 'failed'
  near: number
  tokens: number
  priceNear: number | null
  impactBps: number | null
  feeNear: number | null
  gasNear: number | null
  txHash: string | null
  message: string | null
}

export interface BotEventView {
  id: number
  kind: string
  code: string | null
  message: string
  at: number
}

/** A point of the bot's own record, written by its worker as it runs. */
export interface BotMetricPoint {
  at: number
  priceNear: number | null
  equityNear: number | null
  pnlNear: number | null
  tokenPct: number | null
  /** The bot's token inventory across its wallets, in whole tokens. */
  inventoryTokens: number | null
  volumeNear: number
  trades: number
}

export interface BotDetail {
  bot: BotSummary
  config: BotConfig
  metrics: BotMetrics
  market: MarketSnapshot | null
  fair: FairValue | null
  progress: RunProgress | null
  health: Health | null
  wallets: BotWalletView[]
  /** Newest first, up to 100. */
  trades: BotTradeView[]
  /** Newest first, up to 50. */
  events: BotEventView[]
  /** The last 7 days, oldest first. */
  series: BotMetricPoint[]
}

/** A configuration field the server refused, and why. */
export interface BotConfigIssue {
  field: string
  message: string
}
