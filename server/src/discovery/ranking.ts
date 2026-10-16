/**
 * Top Wallets' ranking rules (DISCOVERY.md, "Top Wallets: ranking integrity"): qualification for a PnL
 * ranking, the categories, and the metrics. Pure: the indexer's daily rows come in, a ranked list goes out.
 */

export type WindowKey = '7d' | '30d' | '90d' | 'all'
export type Category = 'all' | 'smart' | 'traders' | 'early' | 'fresh'
export type Metric = 'pnl' | 'return' | 'winrate' | 'activity'

export const WINDOW_DAYS: Readonly<Record<WindowKey, number | null>> = { '7d': 7, '30d': 30, '90d': 90, all: null }
/** Closed trades a wallet needs in the window to be ranked by PnL. */
export const MIN_CLOSED: Readonly<Record<WindowKey, number>> = { '7d': 5, '30d': 10, '90d': 15, all: 15 }
export const MIN_COVERAGE = 0.8
export const MIN_TOKENS = 2
export const MIN_HISTORY_MS = 2 * 86_400_000
/** Swap legs on one day above which a wallet is automated. */
export const AUTOMATED_LEGS_PER_DAY = 300
export const SMART = { closed: 20, winRate: 0.55, realized: 250, profitableTokens: 3 } as const
export const TRADERS_MIN_CLOSED = 10
export const EARLY_TOKENS = 3
/** An early buy: within this long of the token's creation. */
export const EARLY_MS = 60 * 60_000
export const FRESH_MS = 14 * 86_400_000
/** Fresh Wallets need this much indexed history (before it, every wallet would look fresh). */
export const FRESH_NEEDS_INDEX_MS = 28 * 86_400_000

/** A wallet's figures over one window, summed from its daily rows. */
export interface WalletWindow {
  trader: string
  realized: number
  costClosed: number
  closed: number
  wins: number
  gains: number
  losses: number
  buyUsd: number
  sellUsd: number
  unmatchedUsd: number
  unpriced: number
  legs: number
  /** The most swap legs on a single day of the window. */
  peakDayLegs: number
  activeDays: number
  /** Distinct tokens sold in the window. */
  tokensSold: number
  /** Distinct tokens with realized profit over the indexed history. */
  profitableTokens: number
  /** Distinct tokens bought within EARLY_MS of their creation, in the window. */
  earlyTokens: number
  firstTs: number
  lastTs: number
}

export type Reason = 'closed-trades' | 'one-token' | 'coverage' | 'history'

export interface Assessed extends WalletWindow {
  /** Matched sale value ÷ all sale value; null without sales. */
  coverage: number | null
  winRate: number | null
  /** Realized ÷ cost basis of the units sold, in percent. */
  returnPct: number | null
  avgGain: number | null
  avgLoss: number | null
  automated: boolean
  qualified: boolean
  reasons: Reason[]
  categories: Category[]
}

export interface RankContext {
  now: number
  /** When the trade index starts. */
  indexStart: number
  /** Smart Money (from the 30-day window: smartMoney). */
  smart?: ReadonlySet<string>
}

export function assess(w: WalletWindow, window: WindowKey, ctx: RankContext): Assessed {
  const coverage = w.sellUsd > 0 ? Math.max(0, (w.sellUsd - w.unmatchedUsd) / w.sellUsd) : null
  const winRate = w.closed > 0 ? w.wins / w.closed : null
  const returnPct = w.costClosed > 0 ? (w.realized / w.costClosed) * 100 : null
  const losses = w.closed - w.wins
  const automated = w.peakDayLegs > AUTOMATED_LEGS_PER_DAY
  const reasons: Reason[] = []
  if (w.closed < MIN_CLOSED[window]) reasons.push('closed-trades')
  if (w.tokensSold < MIN_TOKENS) reasons.push('one-token')
  if (coverage === null || coverage < MIN_COVERAGE) reasons.push('coverage')
  if (w.lastTs - w.firstTs < MIN_HISTORY_MS) reasons.push('history')
  const qualified = reasons.length === 0
  const categories: Category[] = ['all']
  if (!automated) {
    if (ctx.smart?.has(w.trader)) categories.push('smart')
    if (qualified && w.closed >= TRADERS_MIN_CLOSED) categories.push('traders')
    if (w.earlyTokens >= EARLY_TOKENS) categories.push('early')
    if (ctx.now - ctx.indexStart >= FRESH_NEEDS_INDEX_MS && w.firstTs >= ctx.now - FRESH_MS) categories.push('fresh')
  }
  return {
    ...w,
    coverage,
    winRate,
    returnPct,
    avgGain: w.wins > 0 ? w.gains / w.wins : null,
    avgLoss: losses > 0 ? w.losses / losses : null,
    automated,
    qualified,
    reasons,
    categories,
  }
}

/** Smart Money, from the 30-day window's assessed rows. */
export function smartMoney(rows30d: readonly Assessed[]): Set<string> {
  return new Set(
    rows30d
      .filter(
        (r) =>
          r.qualified &&
          !r.automated &&
          r.closed >= SMART.closed &&
          (r.winRate ?? 0) >= SMART.winRate &&
          r.realized >= SMART.realized &&
          r.profitableTokens >= SMART.profitableTokens,
      )
      .map((r) => r.trader),
  )
}

const BY: Record<Metric, (r: Assessed) => number> = {
  pnl: (r) => r.realized,
  return: (r) => r.returnPct ?? -Infinity,
  winrate: (r) => r.winRate ?? -Infinity,
  activity: (r) => r.buyUsd + r.sellUsd,
}

/**
 * A ranked list: PnL, return and win rate rank qualified wallets only; activity ranks every wallet by
 * volume (and says nothing about profit). Ties: more closed trades, then the account name.
 */
export function rank(rows: readonly Assessed[], opts: { metric: Metric; category: Category; limit: number }): Assessed[] {
  const by = BY[opts.metric]
  return rows
    .filter((r) => (opts.metric === 'activity' || r.qualified) && r.categories.includes(opts.category))
    .sort((a, b) => by(b) - by(a) || b.closed - a.closed || a.trader.localeCompare(b.trader))
    .slice(0, opts.limit)
}

/** The largest fall of a cumulative series from a previous peak (the series starts from zero). */
export function maxDrawdown(cumulative: readonly number[]): number {
  let peak = 0
  let worst = 0
  for (const v of cumulative) {
    peak = Math.max(peak, v)
    worst = Math.max(worst, peak - v)
  }
  return worst
}

/** How many of a window's days the index covers. */
export function windowCoverage(window: WindowKey, ctx: Pick<RankContext, 'now' | 'indexStart'>): { days: number | null; covered: number } {
  const indexed = Math.max(0, Math.floor((ctx.now - ctx.indexStart) / 86_400_000))
  const days = WINDOW_DAYS[window]
  return { days, covered: days === null ? indexed : Math.min(days, indexed) }
}
