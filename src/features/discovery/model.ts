import type { IndexStatus, LaunchPeriod, LaunchRow, QualifyReason, TradeView, WalletCategory, WalletMetric, WalletWindowKey } from '@/lib/discovery/api'

/**
 * Launch Radar's and Top Wallets' page rules (DISCOVERY.md): the quality score, the tabs' order, the
 * summary, the risk flags with their evidence, and the labels. Pure: the pages render what these return.
 */

export type RadarTab = 'last' | 'best' | 'top'

export interface ScoreWeights {
  liquidity: number
  holders: number
  traders: number
  buys: number
  reputation: number
}

export const DEFAULT_WEIGHTS: Readonly<ScoreWeights> = { liquidity: 3, holders: 2, traders: 2, buys: 1, reputation: 1 }

/** Top: launches with at least this liquidity and this many trades in 24h. */
export const TOP_MIN_LIQUIDITY = 1_000
export const TOP_MIN_TRADES = 10
export const LOW_LIQUIDITY = 1_000
export const CONCENTRATED = 0.5
export const DEV_HEAVY = 0.1

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const logShare = (v: number | null, full: number) => (v === null || v <= 1 ? 0 : clamp01(Math.log10(v) / Math.log10(full)))
const REPUTATION_SCORE = { Reputable: 1, NotFake: 0.75, Unknown: 0.4, Spam: 0 } as const

/** A launch has an active market: a main pool with liquidity in it. */
export const hasMarket = (r: LaunchRow): boolean => r.mainPool !== null && (r.liquidityUsd ?? 0) > 0

/** The score's parts (each 0-1); null without an active market. */
export function scoreParts(r: LaunchRow): ScoreWeights | null {
  if (!hasMarket(r)) return null
  const trades = (r.buys24h ?? 0) + (r.sells24h ?? 0)
  return {
    liquidity: logShare(r.liquidityUsd, 50_000),
    holders: logShare(r.holders, 1_000),
    traders: logShare(r.traders24h, 200),
    buys: trades >= 5 ? (r.buys24h ?? 0) / trades : 0.5,
    reputation: r.reputation ? REPUTATION_SCORE[r.reputation] : REPUTATION_SCORE.Unknown,
  }
}

/** The quality score, 0-100: 100 × Σ wᵢ·cᵢ ÷ Σ wᵢ. Null without an active market (or no weight at all). */
export function launchScore(r: LaunchRow, w: ScoreWeights = DEFAULT_WEIGHTS): number | null {
  const c = scoreParts(r)
  const total = w.liquidity + w.holders + w.traders + w.buys + w.reputation
  if (!c || total <= 0) return null
  return (100 * (w.liquidity * c.liquidity + w.holders * c.holders + w.traders * c.traders + w.buys * c.buys + w.reputation * c.reputation)) / total
}

export type ChangeWindow = '5m' | '1h' | '6h' | '24h'

/** The price change that matches the period's window (1h → 1h, 6h → 6h, 24h and 7d → 24h), in percent. */
export const changeFor = (r: LaunchRow, period: LaunchPeriod): number | null => (period === '1h' ? r.priceChange1h : period === '6h' ? r.priceChange6h : r.priceChange24h)
export const volumeFor = (r: LaunchRow, period: LaunchPeriod): number | null => (period === '1h' ? r.volume1h : period === '6h' ? r.volume6h : r.volume24h)
export const changeWindow = (period: LaunchPeriod): '1h' | '6h' | '24h' => (period === '1h' ? '1h' : period === '6h' ? '6h' : '24h')

const CHANGE_OF: Record<ChangeWindow, (r: LaunchRow) => number | null> = {
  '5m': (r) => r.priceChange5m,
  '1h': (r) => r.priceChange1h,
  '6h': (r) => r.priceChange6h,
  '24h': (r) => r.priceChange24h,
}
const SHORTER: Record<'1h' | '6h' | '24h', ChangeWindow[]> = { '1h': ['1h', '5m'], '6h': ['6h', '1h', '5m'], '24h': ['24h', '6h', '1h', '5m'] }

/**
 * The period's price change with the window it is measured over: the period's own window, or, when Intear
 * reports none (a launch younger than that window has no price that old), the longest shorter window it
 * reports. The page shows that window next to the figure. Null when Intear reports no change at all.
 */
export function periodChange(r: LaunchRow, period: LaunchPeriod): { value: number; window: ChangeWindow } | null {
  for (const window of SHORTER[changeWindow(period)]) {
    const value = CHANGE_OF[window](r)
    if (value !== null) return { value, window }
  }
  return null
}

export interface RadarFilter {
  tab: RadarTab
  /** A source id, 'direct', or 'all'. */
  source: string
  q: string
  spam: boolean
  watchOnly: boolean
  watch: ReadonlySet<string>
}

export interface RadarItem {
  row: LaunchRow
  score: number | null
}

/**
 * The tab's list: Last, newest first; Last Best, launches with a market by score; Top, launches with
 * TOP_MIN_LIQUIDITY and TOP_MIN_TRADES by the period's price change (periodChange). Filters first: source, search
 * (symbol, name or contract), spam (hidden unless asked), watchlist.
 */
export function radarItems(rows: readonly LaunchRow[], f: RadarFilter, period: LaunchPeriod, weights: ScoreWeights = DEFAULT_WEIGHTS): RadarItem[] {
  const q = f.q.trim().toLowerCase()
  const kept = rows.filter((r) => {
    if (!f.spam && r.reputation === 'Spam') return false
    if (f.watchOnly && !f.watch.has(r.token)) return false
    if (f.source !== 'all' && (r.source.id ?? 'direct') !== f.source) return false
    if (q && !`${r.symbol ?? ''} ${r.name ?? ''} ${r.token}`.toLowerCase().includes(q)) return false
    return true
  })
  const items = kept.map((row) => ({ row, score: launchScore(row, weights) }))
  if (f.tab === 'best') return items.filter((i) => i.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.row.createdAt ?? 0) - (a.row.createdAt ?? 0))
  if (f.tab === 'top')
    return items
      .filter((i) => (i.row.liquidityUsd ?? 0) >= TOP_MIN_LIQUIDITY && (i.row.buys24h ?? 0) + (i.row.sells24h ?? 0) >= TOP_MIN_TRADES && periodChange(i.row, period) !== null)
      .sort((a, b) => (periodChange(b.row, period)?.value ?? 0) - (periodChange(a.row, period)?.value ?? 0))
  return items.sort((a, b) => (b.row.createdAt ?? 0) - (a.row.createdAt ?? 0))
}

/** The summary cards: launches, how many have a market, their 24h volume and liquidity (null when none reported). */
export function radarSummary(rows: readonly LaunchRow[]): { launches: number; withMarket: number; volume24h: number | null; liquidity: number | null } {
  const sum = (pick: (r: LaunchRow) => number | null) => {
    const vals = rows.map(pick).filter((v): v is number => v !== null)
    return vals.length ? vals.reduce((s, v) => s + v, 0) : null
  }
  return { launches: rows.length, withMarket: rows.filter(hasMarket).length, volume24h: sum((r) => r.volume24h), liquidity: sum((r) => (hasMarket(r) ? r.liquidityUsd : null)) }
}

export interface RiskFlag {
  key: 'spam' | 'no-market' | 'low-liquidity' | 'concentrated' | 'dev-heavy'
  label: string
  /** What the flag rests on, with its source. */
  evidence: string
}

const pctOf = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`

/** Risk flags with their evidence. No flag is not "safe": absent data is never a pass. */
export function riskFlags(r: LaunchRow): RiskFlag[] {
  const out: RiskFlag[] = []
  if (r.reputation === 'Spam') out.push({ key: 'spam', label: 'Marked spam', evidence: 'Intear’s token reputation is Spam.' })
  if (!hasMarket(r)) out.push({ key: 'no-market', label: 'No active market', evidence: 'No pool with liquidity was reported for it.' })
  else if ((r.liquidityUsd ?? 0) < LOW_LIQUIDITY)
    out.push({ key: 'low-liquidity', label: 'Low liquidity', evidence: `Liquidity is under $${LOW_LIQUIDITY.toLocaleString('en-US')}.` })
  if (r.top10Share !== null && r.top10Share > CONCENTRATED)
    out.push({ key: 'concentrated', label: 'Concentrated', evidence: `The 10 largest holders own ${pctOf(r.top10Share)} of supply (pools and the launchpad left out).` })
  if (r.devShare !== null && r.devShare > DEV_HEAVY)
    out.push({ key: 'dev-heavy', label: 'Dev holds a lot', evidence: `The deploying account holds ${pctOf(r.devShare)} of supply.` })
  return out
}

/** How a launch's source reads: a known product, a token factory's account, a bridge, or Direct. */
export function sourceLabel(s: LaunchRow['source']): string {
  if (s.kind === 'direct' || s.id === null) return 'Direct'
  return s.name ?? s.id
}

export const WINDOW_LABEL: Readonly<Record<WalletWindowKey, string>> = { all: 'Top 100', '7d': 'Last 7D', '30d': 'Last 30D', '90d': 'Last 90D' }
export const CATEGORY_LABEL: Readonly<Record<WalletCategory, string>> = { all: 'All', smart: 'Smart Money', traders: 'Traders', early: 'Early Buyers', fresh: 'Fresh Wallets' }
export const METRIC_LABEL: Readonly<Record<WalletMetric, string>> = { pnl: 'Realized PnL', return: 'Return', winrate: 'Win rate', activity: 'Activity (volume)' }

export const CATEGORY_RULE: Readonly<Record<WalletCategory, string>> = {
  all: 'Every wallet that qualifies for the ranking.',
  smart: 'Over 30 days: at least 20 closed trades, a win rate of 55% or more, $250 or more realized, profit in 3 or more tokens, not automated.',
  traders: 'Qualified, not automated, at least 10 closed trades in the window.',
  early: 'Bought 3 or more different tokens within an hour of their creation in the window.',
  fresh: 'First indexed swap within the last 14 days (needs 28 indexed days).',
}

const DAY_MS = 86_400_000
const WINDOW_DAYS: Readonly<Record<WalletWindowKey, number | null>> = { all: null, '7d': 7, '30d': 30, '90d': 90 }

export interface WindowCoverage {
  /** The window's length in days; null for all indexed history. */
  days: number | null
  /** Whole days of the window the trade index holds. */
  covered: number
  /** full: every day of the window is indexed; catching-up: the index is still reading history, so the
   *  recent days aren't in it yet; young: the index started after the window did. */
  state: 'full' | 'catching-up' | 'young'
}

/**
 * How much of a ranking window the trade index holds: the window's days between where the index starts
 * and how far it has read (tradesTo), never up to "now" while it is still catching up on history.
 */
export function windowCoverage(window: WalletWindowKey, index: Pick<IndexStatus, 'indexStart' | 'tradesTo' | 'backfilling'>, asOf: number): WindowCoverage {
  const days = WINDOW_DAYS[window]
  const to = Math.min(index.tradesTo ?? index.indexStart, asOf)
  const from = days === null ? index.indexStart : Math.max(index.indexStart, asOf - days * DAY_MS)
  const indexed = Math.max(0, Math.floor((to - from) / DAY_MS))
  const state = index.backfilling || index.tradesTo === null ? 'catching-up' : days !== null && index.indexStart > asOf - days * DAY_MS ? 'young' : 'full'
  return { days, covered: state === 'full' && days !== null ? days : days === null ? indexed : Math.min(days, indexed), state }
}

export const REASON_TEXT: Readonly<Record<QualifyReason, string>> = {
  'closed-trades': 'too few closed trades',
  'one-token': 'sold in only one token',
  coverage: 'under 80% of its sales have an indexed purchase',
  history: 'under 2 days between its first and last indexed swap',
}

const csvCell = (v: string | number | null) => {
  if (v === null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A trade history as CSV (UTC times; amounts in whole tokens; empty where unknown). */
export function tradesCsv(trades: readonly TradeView[]): string {
  const head = ['time_utc', 'side', 'token', 'symbol', 'amount', 'counter_token', 'counter_symbol', 'counter_amount', 'usd_value', 'transaction']
  const rows = trades.map((t) =>
    [new Date(t.ts).toISOString(), t.side, t.token, t.symbol, t.amount, t.counterToken, t.counterSymbol, t.counterAmount, t.usd, t.tx].map(csvCell).join(','),
  )
  return [head.join(','), ...rows].join('\n') + '\n'
}
