import type { ConfigIssue, ExecutionStatus, StrategyConfig, StrategyKind, StrategyStatus } from './config'

/**
 * NEARKITS' trading automation API, as NEARKITS web and the Telegram bot see it. Every call carries the
 * web session (or comes from the user's own Telegram account); the server decides everything a
 * client could claim: whose strategy it is, which wallet, the token's real decimals, the limits.
 */

export interface AutomationFeatures {
  /** The kinds NEARKITS has switched on; the rest stay Coming Soon. */
  enabled: StrategyKind[]
  /** NEARKITS' kill switch for every automated trade (or trading as a whole). */
  paused: boolean
  pausedReason: string | null
  limits: { maxTradeNear: number; maxDailyNearPerUser: number; maxSlippagePct: number }
}

export interface StrategyView {
  id: string
  kind: StrategyKind
  status: StrategyStatus
  walletId: string
  walletName: string | null
  /** The token traded, or the account followed (Copy Trade). */
  subject: string
  config: StrategyConfig
  /** Why it is in its state now (a failure, a pause), or null. */
  statusReason: string | null
  /** What it waits for right now (a balance, a route, a switch), or null. */
  waiting: string | null
  /** The last executable price seen (limit orders), NEAR per whole token, as a decimal; null before the first. */
  lastPriceNear: string | null
  lastQuoteAt: number | null
  ocoGroup: string | null
  attempts: number
  expiresAt: number | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

export interface ExecutionView {
  id: string
  side: 'buy' | 'sell'
  token: string
  status: ExecutionStatus
  /** Raw amounts: what the quote expected, and what the chain moved once confirmed. */
  amountInRaw: string | null
  expectedOutRaw: string | null
  minOutRaw: string | null
  nearRaw: string | null
  tokenRaw: string | null
  priceNear: string | null
  txHashes: string[]
  message: string | null
  /** The copied transaction (Copy Trade). */
  source: string | null
  createdAt: number
  updatedAt: number
}

export interface DetectionView {
  sourceKey: string
  at: number
  side: 'buy' | 'sell' | null
  token: string | null
  tokenRaw: string | null
  nearRaw: string | null
  status: 'detected' | 'eligible' | 'skipped' | 'executing' | 'submitted' | 'confirmed' | 'failed'
  reason: string | null
}

export interface StrategyDetail {
  strategy: StrategyView
  executions: ExecutionView[]
  events: { at: number; kind: string; message: string }[]
  detections: DetectionView[]
}

/** What a strategy would trade now, from a fresh executable quote: shown before it is enabled. */
export interface StrategyPreview {
  side: 'buy' | 'sell'
  /** What it would spend now (decimal: NEAR on a buy, the token on a sell). */
  amountIn: string
  expectedOutRaw: string
  minOutRaw: string
  /** NEAR per whole token at that quote, as a decimal. */
  priceNear: string
  priceImpactPct: number | null
  /** NEARKITS' fee on this route, raw, in its token; null where none is charged. */
  feeRaw: string | null
  feeToken: string | null
  networkFeeNear: string
  /** Whether the trigger condition holds at this quote (limit orders). */
  wouldTrigger: boolean | null
  /** The wallet's NEAR and token balances (raw), as read from chain now. */
  balanceNearRaw: string | null
  balanceTokenRaw: string | null
}

export interface CreateStrategyInput {
  walletId: string
  config: StrategyConfig
  /** A second order on the same position (a take profit with a stop loss): the first to trigger cancels the other. */
  pair?: StrategyConfig
  /** A sniper that buys (not only notifies) needs this explicit yes. */
  confirmExecute?: boolean
}

export type CreateStrategyResult = { ok: true; strategies: StrategyView[] } | { ok: false; issues: ConfigIssue[] }
