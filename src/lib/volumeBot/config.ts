import { GAS_RESERVE_NEAR, MAX_SLIPPAGE } from '@/lib/fees'
import { isValidAccountId } from '@/lib/validation'
import { BOT_STRATEGIES, type BotConfig, type BotStrategy, type HourWindow, type SizingMode } from './types'

/**
 * Bounds of a Volume Bot configuration. None of them is a monetary ceiling: how much the bot may
 * trade, deploy or lose is the owner's to set. They keep it from trading without an edge over fair
 * value, from evaluating too often to be safe, and from contradictions.
 */

/** The market maker trades only when its executable price beats fair value by at least this. */
export const MIN_EDGE_BPS = 10
/** Evaluations no closer together than this. */
export const MIN_INTERVAL_SEC = 10
/** Wallets one bot may trade from (an operational bound on the worker, not on money). */
export const MAX_BOT_WALLETS = 20
/** Live bots (running, paused or stopping) one user may have at once: the worker is shared, so one user never crowds out the rest. */
export const MAX_LIVE_BOTS_PER_USER = 5
/** TWAP periods: at least ten minutes, at most 30 days. */
export const MIN_TWAP_SEC = 600
export const MAX_TWAP_SEC = 30 * 86_400
const MAX_SLIPPAGE_BPS = MAX_SLIPPAGE * 100
const SIZING_MODES: readonly SizingMode[] = ['auto', 'fixed', 'range', 'capital-pct', 'inventory-pct']

/** The quote side's own contracts: the bot trades a token against NEAR, never NEAR against itself. */
const NEAR_IDS: readonly string[] = ['near', 'wrap.near', 'wrap.testnet']

export interface ConfigIssue {
  field: string
  message: string
}

/** A starting point for each strategy; every number is the owner's to change. */
export function defaultBotConfig(strategy: BotStrategy, token: { id: string; symbol: string; decimals: number }, walletIds: string[]): BotConfig {
  return {
    tokenId: token.id,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    quote: 'near',
    strategy,
    walletIds: [...walletIds],
    sizing: { mode: strategy === 'market-maker' ? 'fixed' : 'auto', fixedNear: 1, minNear: 0.5, maxNear: 2, pct: 10, maxLiquidityPct: 1, adaptiveImpact: true },
    schedule: {
      minIntervalSec: strategy === 'market-maker' ? 30 : 120,
      maxIntervalSec: strategy === 'market-maker' ? 90 : 300,
      cooldownSec: strategy === 'market-maker' ? 120 : 60,
      maxConcurrent: 1,
      maxTrades: null,
      maxRuntimeSec: null,
      activeHours: null,
      pauseWindows: [],
    },
    risk: {
      maxTradeNear: 5,
      maxWalletExposurePct: 90,
      maxAggregateExposurePct: 80,
      maxDailyLossNear: 5,
      maxDrawdownPct: 20,
      maxSlippageBps: 100,
      maxPriceImpactBps: 150,
      minLiquidityUsd: 10_000,
      maxSpreadBps: 400,
      gasReserveNear: 0.25,
      maxConsecutiveFailures: 3,
      maxPriceMovePct: 20,
      maxDataAgeSec: 180,
      maxQuoteAgeSec: 20,
      txTimeoutSec: 120,
    },
    inventory: { targetTokenPct: 50, minTokenPct: 20, maxTokenPct: 80, maxNearDeployed: 25 },
    marketMaker: { minEdgeBps: 50, skew: 0.5, fairValueWindowSec: 3600 },
    twap: { totalNear: 0, totalTokens: 0, durationSec: 86_400, limitPriceNear: null },
  }
}

const positive = (n: number) => Number.isFinite(n) && n > 0
const within = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi
const wholeWithin = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi
const validWindow = (w: HourWindow) => wholeWithin(w.from, 0, 23) && wholeWithin(w.to, 0, 24) && w.from !== w.to % 24

/** Every problem with a configuration, by field; empty when it can run. */
export function validateBotConfig(c: BotConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const issue = (field: string, message: string) => issues.push({ field, message })
  const money = (field: string, n: number) => {
    if (!positive(n)) issue(field, 'Enter an amount above zero')
  }

  if (!isValidAccountId(c.tokenId)) issue('tokenId', 'Choose a token by its contract')
  else if (NEAR_IDS.includes(c.tokenId)) issue('tokenId', 'The bot trades a token against NEAR: choose a token other than NEAR')
  if (!wholeWithin(c.tokenDecimals, 0, 255)) issue('tokenDecimals', 'The token’s decimals are not known')
  if (!BOT_STRATEGIES.includes(c.strategy)) issue('strategy', 'Choose a strategy')

  if (c.walletIds.length === 0) issue('walletIds', 'Choose at least one NEARKITS wallet')
  else if (new Set(c.walletIds).size !== c.walletIds.length) issue('walletIds', 'Each wallet can be chosen once')
  else if (c.walletIds.length > MAX_BOT_WALLETS) issue('walletIds', `One bot trades from at most ${MAX_BOT_WALLETS} wallets`)

  const s = c.sizing
  if (!SIZING_MODES.includes(s.mode)) issue('sizing.mode', 'Choose how trades are sized')
  if (s.mode === 'fixed') money('sizing.fixedNear', s.fixedNear)
  if (s.mode === 'range') {
    money('sizing.minNear', s.minNear)
    if (!positive(s.maxNear) || s.maxNear < s.minNear) issue('sizing.maxNear', 'The largest size must be at least the smallest')
  }
  if ((s.mode === 'capital-pct' || s.mode === 'inventory-pct') && !(Number.isFinite(s.pct) && s.pct > 0 && s.pct <= 100))
    issue('sizing.pct', 'Enter a percentage above 0 and up to 100')
  if (!within(s.maxLiquidityPct, 0, 100)) issue('sizing.maxLiquidityPct', 'Enter a percentage from 0 (off) to 100')
  if (c.strategy === 'market-maker' && s.mode === 'auto') money('sizing.fixedNear', s.fixedNear)

  const sc = c.schedule
  if (!(Number.isFinite(sc.minIntervalSec) && sc.minIntervalSec >= MIN_INTERVAL_SEC)) issue('schedule.minIntervalSec', `At least ${MIN_INTERVAL_SEC} seconds between evaluations`)
  if (!(Number.isFinite(sc.maxIntervalSec) && sc.maxIntervalSec >= sc.minIntervalSec && sc.maxIntervalSec <= 86_400))
    issue('schedule.maxIntervalSec', 'The longest interval must be at least the shortest, and at most a day')
  if (!within(sc.cooldownSec, 0, 86_400)) issue('schedule.cooldownSec', 'Enter a cooldown from 0 seconds to a day')
  if (!wholeWithin(sc.maxConcurrent, 1, Math.max(1, Math.min(5, c.walletIds.length)))) issue('schedule.maxConcurrent', 'At most one trade per wallet in flight, and at most 5')
  if (sc.maxTrades !== null && !wholeWithin(sc.maxTrades, 1, 1_000_000)) issue('schedule.maxTrades', 'Enter a whole number of trades, or no limit')
  if (sc.maxRuntimeSec !== null && !(Number.isFinite(sc.maxRuntimeSec) && sc.maxRuntimeSec >= 60)) issue('schedule.maxRuntimeSec', 'Run at least a minute, or without a limit')
  if (sc.activeHours !== null && !validWindow(sc.activeHours)) issue('schedule.activeHours', 'Use whole UTC hours, with different start and end')
  if (sc.pauseWindows.length > 6 || sc.pauseWindows.some((w) => !validWindow(w)))
    issue('schedule.pauseWindows', 'Up to 6 windows of whole UTC hours, each with different start and end')

  const r = c.risk
  money('risk.maxTradeNear', r.maxTradeNear)
  money('risk.maxDailyLossNear', r.maxDailyLossNear)
  if (!(Number.isFinite(r.maxWalletExposurePct) && r.maxWalletExposurePct > 0 && r.maxWalletExposurePct <= 100))
    issue('risk.maxWalletExposurePct', 'Enter a percentage above 0 and up to 100')
  if (!(Number.isFinite(r.maxAggregateExposurePct) && r.maxAggregateExposurePct > 0 && r.maxAggregateExposurePct <= 100))
    issue('risk.maxAggregateExposurePct', 'Enter a percentage above 0 and up to 100')
  if (!(Number.isFinite(r.maxDrawdownPct) && r.maxDrawdownPct > 0 && r.maxDrawdownPct <= 100)) issue('risk.maxDrawdownPct', 'Enter a percentage above 0 and up to 100')
  if (!wholeWithin(r.maxSlippageBps, 1, MAX_SLIPPAGE_BPS)) issue('risk.maxSlippageBps', `Slippage from 0.01% to ${MAX_SLIPPAGE}%`)
  if (!wholeWithin(r.maxPriceImpactBps, 1, 5_000)) issue('risk.maxPriceImpactBps', 'Price impact from 0.01% to 50%')
  if (!(Number.isFinite(r.minLiquidityUsd) && r.minLiquidityUsd >= 0)) issue('risk.minLiquidityUsd', 'Enter a liquidity floor of 0 or more')
  if (!wholeWithin(r.maxSpreadBps, 1, 10_000)) issue('risk.maxSpreadBps', 'Spread from 0.01% to 100%')
  if (!(Number.isFinite(r.gasReserveNear) && r.gasReserveNear >= GAS_RESERVE_NEAR)) issue('risk.gasReserveNear', `Keep at least ${GAS_RESERVE_NEAR} NEAR in each wallet for gas`)
  if (!wholeWithin(r.maxConsecutiveFailures, 1, 50)) issue('risk.maxConsecutiveFailures', 'From 1 to 50 failures in a row')
  if (!(Number.isFinite(r.maxPriceMovePct) && r.maxPriceMovePct > 0 && r.maxPriceMovePct <= 95)) issue('risk.maxPriceMovePct', 'Enter a percentage above 0 and up to 95')
  if (!within(r.maxDataAgeSec, 15, 3_600)) issue('risk.maxDataAgeSec', 'From 15 seconds to an hour')
  if (!within(r.maxQuoteAgeSec, 2, 300)) issue('risk.maxQuoteAgeSec', 'From 2 seconds to 5 minutes')
  if (!within(r.txTimeoutSec, 15, 1_800)) issue('risk.txTimeoutSec', 'From 15 seconds to 30 minutes')

  const inv = c.inventory
  const pct = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100
  if (!pct(inv.minTokenPct)) issue('inventory.minTokenPct', 'Enter a percentage from 0 to 100')
  if (!pct(inv.maxTokenPct)) issue('inventory.maxTokenPct', 'Enter a percentage from 0 to 100')
  if (!pct(inv.targetTokenPct) || inv.targetTokenPct < inv.minTokenPct || inv.targetTokenPct > inv.maxTokenPct)
    issue('inventory.targetTokenPct', 'The target must lie between the minimum and the maximum')
  money('inventory.maxNearDeployed', inv.maxNearDeployed)

  if (c.strategy === 'market-maker') {
    const m = c.marketMaker
    if (!wholeWithin(m.minEdgeBps, MIN_EDGE_BPS, 5_000))
      issue('marketMaker.minEdgeBps', `The edge over fair value is at least ${MIN_EDGE_BPS / 100}%: the bot never trades without one`)
    if (!within(m.skew, 0, 1)) issue('marketMaker.skew', 'Skew from 0 to 1')
    if (!within(m.fairValueWindowSec, 300, 7 * 86_400)) issue('marketMaker.fairValueWindowSec', 'Fair value over 5 minutes to 7 days')
  } else {
    const t = c.twap
    if (c.strategy === 'accumulate') money('twap.totalNear', t.totalNear)
    if (c.strategy === 'distribute') money('twap.totalTokens', t.totalTokens)
    if (!within(t.durationSec, MIN_TWAP_SEC, MAX_TWAP_SEC)) issue('twap.durationSec', 'Spread it over 10 minutes to 30 days')
    if (t.limitPriceNear !== null && !positive(t.limitPriceNear)) issue('twap.limitPriceNear', 'Enter a price above zero, or no limit')
  }
  return issues
}

type Reader = { issues: ConfigIssue[] }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function num(r: Reader, o: Record<string, unknown>, key: string, field: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    r.issues.push({ field, message: 'Expected a number' })
    return Number.NaN
  }
  return v
}
function numOrNull(r: Reader, o: Record<string, unknown>, key: string, field: string): number | null {
  return o[key] === null ? null : num(r, o, key, field)
}
function str(r: Reader, o: Record<string, unknown>, key: string, field: string): string {
  const v = o[key]
  if (typeof v !== 'string') {
    r.issues.push({ field, message: 'Expected text' })
    return ''
  }
  return v
}
function obj(r: Reader, o: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = o[key]
  if (!isObject(v)) {
    r.issues.push({ field: key, message: 'Expected an object' })
    return {}
  }
  return v
}
function windowOf(r: Reader, v: unknown, field: string): HourWindow {
  if (!isObject(v)) {
    r.issues.push({ field, message: 'Expected a UTC hour window' })
    return { from: 0, to: 0 }
  }
  return { from: num(r, v, 'from', field), to: num(r, v, 'to', field) }
}

/**
 * A configuration as the API receives it (JSON): every field checked for its type, nothing coerced,
 * then validated. Unknown fields are dropped.
 */
export function parseBotConfig(input: unknown): { ok: true; config: BotConfig } | { ok: false; issues: ConfigIssue[] } {
  if (!isObject(input)) return { ok: false, issues: [{ field: '', message: 'Expected a configuration object' }] }
  const r: Reader = { issues: [] }
  const strategyRaw = str(r, input, 'strategy', 'strategy')
  const strategy = (BOT_STRATEGIES as readonly string[]).includes(strategyRaw) ? (strategyRaw as BotStrategy) : null
  if (strategy === null && !r.issues.some((i) => i.field === 'strategy')) r.issues.push({ field: 'strategy', message: 'Choose a strategy' })
  const walletIds = Array.isArray(input.walletIds) && input.walletIds.every((w) => typeof w === 'string') ? (input.walletIds as string[]) : null
  if (walletIds === null) r.issues.push({ field: 'walletIds', message: 'Expected a list of wallet ids' })
  if (input.quote !== 'near') r.issues.push({ field: 'quote', message: 'The quote side is NEAR' })

  const sizing = obj(r, input, 'sizing')
  const schedule = obj(r, input, 'schedule')
  const risk = obj(r, input, 'risk')
  const inventory = obj(r, input, 'inventory')
  const marketMaker = obj(r, input, 'marketMaker')
  const twap = obj(r, input, 'twap')
  const mode = str(r, sizing, 'mode', 'sizing.mode') as SizingMode
  if (typeof sizing.adaptiveImpact !== 'boolean') r.issues.push({ field: 'sizing.adaptiveImpact', message: 'Expected true or false' })
  const active = schedule.activeHours === null ? null : windowOf(r, schedule.activeHours, 'schedule.activeHours')
  const pauses = Array.isArray(schedule.pauseWindows) ? schedule.pauseWindows.map((w) => windowOf(r, w, 'schedule.pauseWindows')) : null
  if (pauses === null) r.issues.push({ field: 'schedule.pauseWindows', message: 'Expected a list of UTC hour windows' })

  const config: BotConfig = {
    tokenId: str(r, input, 'tokenId', 'tokenId'),
    tokenSymbol: str(r, input, 'tokenSymbol', 'tokenSymbol'),
    tokenDecimals: num(r, input, 'tokenDecimals', 'tokenDecimals'),
    quote: 'near',
    strategy: strategy ?? 'market-maker',
    walletIds: walletIds ?? [],
    sizing: {
      mode,
      fixedNear: num(r, sizing, 'fixedNear', 'sizing.fixedNear'),
      minNear: num(r, sizing, 'minNear', 'sizing.minNear'),
      maxNear: num(r, sizing, 'maxNear', 'sizing.maxNear'),
      pct: num(r, sizing, 'pct', 'sizing.pct'),
      maxLiquidityPct: num(r, sizing, 'maxLiquidityPct', 'sizing.maxLiquidityPct'),
      adaptiveImpact: sizing.adaptiveImpact === true,
    },
    schedule: {
      minIntervalSec: num(r, schedule, 'minIntervalSec', 'schedule.minIntervalSec'),
      maxIntervalSec: num(r, schedule, 'maxIntervalSec', 'schedule.maxIntervalSec'),
      cooldownSec: num(r, schedule, 'cooldownSec', 'schedule.cooldownSec'),
      maxConcurrent: num(r, schedule, 'maxConcurrent', 'schedule.maxConcurrent'),
      maxTrades: numOrNull(r, schedule, 'maxTrades', 'schedule.maxTrades'),
      maxRuntimeSec: numOrNull(r, schedule, 'maxRuntimeSec', 'schedule.maxRuntimeSec'),
      activeHours: active,
      pauseWindows: pauses ?? [],
    },
    risk: {
      maxTradeNear: num(r, risk, 'maxTradeNear', 'risk.maxTradeNear'),
      maxWalletExposurePct: num(r, risk, 'maxWalletExposurePct', 'risk.maxWalletExposurePct'),
      maxAggregateExposurePct: num(r, risk, 'maxAggregateExposurePct', 'risk.maxAggregateExposurePct'),
      maxDailyLossNear: num(r, risk, 'maxDailyLossNear', 'risk.maxDailyLossNear'),
      maxDrawdownPct: num(r, risk, 'maxDrawdownPct', 'risk.maxDrawdownPct'),
      maxSlippageBps: num(r, risk, 'maxSlippageBps', 'risk.maxSlippageBps'),
      maxPriceImpactBps: num(r, risk, 'maxPriceImpactBps', 'risk.maxPriceImpactBps'),
      minLiquidityUsd: num(r, risk, 'minLiquidityUsd', 'risk.minLiquidityUsd'),
      maxSpreadBps: num(r, risk, 'maxSpreadBps', 'risk.maxSpreadBps'),
      gasReserveNear: num(r, risk, 'gasReserveNear', 'risk.gasReserveNear'),
      maxConsecutiveFailures: num(r, risk, 'maxConsecutiveFailures', 'risk.maxConsecutiveFailures'),
      maxPriceMovePct: num(r, risk, 'maxPriceMovePct', 'risk.maxPriceMovePct'),
      maxDataAgeSec: num(r, risk, 'maxDataAgeSec', 'risk.maxDataAgeSec'),
      maxQuoteAgeSec: num(r, risk, 'maxQuoteAgeSec', 'risk.maxQuoteAgeSec'),
      txTimeoutSec: num(r, risk, 'txTimeoutSec', 'risk.txTimeoutSec'),
    },
    inventory: {
      targetTokenPct: num(r, inventory, 'targetTokenPct', 'inventory.targetTokenPct'),
      minTokenPct: num(r, inventory, 'minTokenPct', 'inventory.minTokenPct'),
      maxTokenPct: num(r, inventory, 'maxTokenPct', 'inventory.maxTokenPct'),
      maxNearDeployed: num(r, inventory, 'maxNearDeployed', 'inventory.maxNearDeployed'),
    },
    marketMaker: {
      minEdgeBps: num(r, marketMaker, 'minEdgeBps', 'marketMaker.minEdgeBps'),
      skew: num(r, marketMaker, 'skew', 'marketMaker.skew'),
      fairValueWindowSec: num(r, marketMaker, 'fairValueWindowSec', 'marketMaker.fairValueWindowSec'),
    },
    twap: {
      totalNear: num(r, twap, 'totalNear', 'twap.totalNear'),
      totalTokens: num(r, twap, 'totalTokens', 'twap.totalTokens'),
      durationSec: num(r, twap, 'durationSec', 'twap.durationSec'),
      limitPriceNear: numOrNull(r, twap, 'limitPriceNear', 'twap.limitPriceNear'),
    },
  }
  if (r.issues.length > 0) return { ok: false, issues: r.issues }
  const issues = validateBotConfig(config)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config }
}
