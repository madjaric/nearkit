import type { FairValue, GuardianPause, MarketSnapshot, RiskConfig, TradeQuote } from './types'

/**
 * The Volume Bot's guardian: conditions under which it stops trading on its own and says exactly
 * why (the bot is PAUSED with that reason until its owner resumes it). Pure checks; the worker
 * runs them every tick, before and after each trade.
 */

/** Liquidity at half (or less) of what it was when the run began is a collapse. */
export const LIQUIDITY_COLLAPSE_RATIO = 0.5
/** RPC calls or market-data reads failing this many times in a row degrade the bot to a pause. */
export const RPC_ERRORS_LIMIT = 3
export const PROVIDER_ERRORS_LIMIT = 3
/** A jump since the previous reading counts within this window. */
const JUMP_WINDOW_MS = 5 * 60_000

const pct = (n: number) => `${(n * 100).toFixed(2)}%`

export function guardMarket(i: {
  market: MarketSnapshot | null
  prev: MarketSnapshot | null
  fair: FairValue | null
  risk: RiskConfig
  now: number
  baselineLiquidityUsd: number | null
}): GuardianPause | null {
  const { market, prev, fair, risk, now } = i
  if (!market) return { code: 'provider-failure', detail: 'No market data source answered' }
  const age = (now - market.at) / 1000
  if (age > risk.maxDataAgeSec) return { code: 'stale-market-data', detail: `The market data is ${Math.round(age)} s old (limit ${risk.maxDataAgeSec} s)` }
  if (market.liquidityUsd !== null && market.liquidityUsd < risk.minLiquidityUsd)
    return {
      code: 'low-liquidity',
      detail: `Pool liquidity $${Math.round(market.liquidityUsd).toLocaleString('en-US')} is under the floor of $${risk.minLiquidityUsd.toLocaleString('en-US')}`,
    }
  if (market.liquidityUsd !== null && i.baselineLiquidityUsd !== null && i.baselineLiquidityUsd > 0 && market.liquidityUsd <= i.baselineLiquidityUsd * LIQUIDITY_COLLAPSE_RATIO)
    return { code: 'liquidity-collapse', detail: `Pool liquidity fell ${pct(1 - market.liquidityUsd / i.baselineLiquidityUsd)} since the run began` }
  const limit = risk.maxPriceMovePct / 100
  if (fair && fair.value > 0) {
    const off = Math.abs(market.midNear - fair.value) / fair.value
    if (off > limit) return { code: 'abnormal-price', detail: `The price is ${pct(off)} from fair value (limit ${risk.maxPriceMovePct}%)` }
  }
  if (prev && prev.midNear > 0 && market.at - prev.at <= JUMP_WINDOW_MS) {
    const jump = Math.abs(market.midNear - prev.midNear) / prev.midNear
    if (jump > limit) return { code: 'abnormal-price', detail: `The price moved ${pct(jump)} in ${Math.round((market.at - prev.at) / 1000)} s (limit ${risk.maxPriceMovePct}%)` }
  }
  return null
}

/** The cost to cross (ask over bid) over its limit: this tick is skipped, with the reason. */
export function spreadCheck(market: MarketSnapshot, risk: RiskConfig): string | null {
  if (market.askNear === null || market.bidNear === null || !(market.midNear > 0)) return null
  const spread = (market.askNear - market.bidNear) / market.midNear
  return spread * 10_000 > risk.maxSpreadBps ? `Spread ${pct(spread)} is over its limit of ${(risk.maxSpreadBps / 100).toFixed(2)}%` : null
}

export interface Health {
  consecutiveFailures: number
  rpcErrors: number
  providerErrors: number
}

export function guardHealth(h: Health, risk: RiskConfig): GuardianPause | null {
  if (h.consecutiveFailures >= risk.maxConsecutiveFailures)
    return { code: 'consecutive-failures', detail: `${h.consecutiveFailures} trades failed in a row (limit ${risk.maxConsecutiveFailures})` }
  if (h.rpcErrors >= RPC_ERRORS_LIMIT) return { code: 'rpc-degraded', detail: `The NEAR RPC failed ${h.rpcErrors} times in a row` }
  if (h.providerErrors >= PROVIDER_ERRORS_LIMIT) return { code: 'provider-failure', detail: `The market data sources failed ${h.providerErrors} times in a row` }
  return null
}

export function guardLoss(e: { pnlTodayNear: number; peakEquityNear: number; equityNear: number }, risk: RiskConfig): GuardianPause | null {
  if (e.pnlTodayNear <= -risk.maxDailyLossNear)
    return { code: 'daily-loss', detail: `Today’s PnL ${e.pnlTodayNear.toFixed(4)} NEAR reached the loss limit of ${risk.maxDailyLossNear} NEAR` }
  if (e.peakEquityNear > 0) {
    const dd = (e.peakEquityNear - e.equityNear) / e.peakEquityNear
    if (dd * 100 >= risk.maxDrawdownPct) return { code: 'drawdown', detail: `Value is ${pct(dd)} below its peak (limit ${risk.maxDrawdownPct}%)` }
  }
  return null
}

/** A fill worse than its quote by more than the slippage the swap allowed: the market moved against it. */
export function guardFill(i: { quote: TradeQuote; filled: { near: number; tokens: number }; risk: RiskConfig }): GuardianPause | null {
  const allowed = 1 - i.risk.maxSlippageBps / 10_000
  if (i.quote.side === 'buy' && i.filled.tokens < i.quote.tokens * allowed - 1e-12)
    return { code: 'excessive-slippage', detail: `It received ${i.filled.tokens} tokens against ${i.quote.tokens} quoted` }
  if (i.quote.side === 'sell' && i.filled.near < i.quote.near * allowed - 1e-12)
    return { code: 'excessive-slippage', detail: `It received ${i.filled.near.toFixed(6)} NEAR against ${i.quote.near.toFixed(6)} quoted` }
  return null
}

/** NEAR may grow (gas refunds, deposits) and dip by gas; tokens move only by the bot's own trades. */
const NEAR_DROP_TOLERANCE = 0.05
const NEAR_DROP_SHARE = 0.02
const TOKEN_TOLERANCE_SHARE = 0.005

/** A wallet's balance moved in a way its own trades don't explain (a withdrawal, a manual trade). */
export function guardBalances(i: {
  expected: readonly { walletId: string; near: number; tokens: number }[]
  actual: readonly { walletId: string; near: number; tokens: number }[]
}): GuardianPause | null {
  for (const e of i.expected) {
    const a = i.actual.find((w) => w.walletId === e.walletId)
    if (!a) return { code: 'unexpected-balance', detail: `Wallet ${e.walletId} could not be read or is no longer the bot’s` }
    const drop = e.near - a.near
    if (drop > Math.max(NEAR_DROP_TOLERANCE, e.near * NEAR_DROP_SHARE))
      return { code: 'unexpected-balance', detail: `Wallet ${e.walletId} holds ${drop.toFixed(4)} NEAR less than its trades explain` }
    if (Math.abs(a.tokens - e.tokens) > Math.max(e.tokens * TOKEN_TOLERANCE_SHARE, 1e-9))
      return { code: 'unexpected-balance', detail: `Wallet ${e.walletId}’s token balance changed outside the bot’s trades` }
  }
  return null
}

/** The words each pause reason is shown with. */
export const GUARDIAN_LABEL: Record<GuardianPause['code'], string> = {
  'abnormal-price': 'Abnormal price movement',
  'liquidity-collapse': 'Liquidity collapse',
  'low-liquidity': 'Liquidity under the floor',
  'stale-market-data': 'Stale market data',
  'stale-quote': 'Stale quote',
  'rpc-degraded': 'NEAR RPC degraded',
  'provider-failure': 'Market data source failing',
  'unexpected-balance': 'Unexpected balance change',
  'tx-timeout': 'Transaction timeout',
  'excessive-slippage': 'Excessive slippage',
  'excessive-impact': 'Excessive price impact',
  'daily-loss': 'Daily loss limit',
  drawdown: 'Drawdown limit',
  'consecutive-failures': 'Too many failures in a row',
  operator: 'Paused by NEARKITS operations',
}
