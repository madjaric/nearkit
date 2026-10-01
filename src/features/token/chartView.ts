import { CHART_RANGES } from '@/services/near/candles'
import type { ChartRange, PricePoint } from '@/types/domain'

/** A history source's candles for the window, with how coarse they are and when the market began. */
export interface ChartHistory {
  points: readonly PricePoint[]
  candleSec: number
  since: number | null
}

export interface ChartView {
  points: PricePoint[]
  /** `history`: a history source's points with the live prices after them; `live`: only what this page saw. */
  source: 'history' | 'live'
  /** The first point is well into the window (a tenth of it, at least a candle): what's before it has no data, and none is drawn. */
  partial: boolean
  /** When the market started, if the source knows: a window reaching further back has nothing before it. */
  since: number | null
}

/** A page that only watches sees a price a minute at most (its poll), so a gap longer than that is one. */
const LIVE_STEP_SEC = 60

/**
 * The points a token chart draws for `range`: the history source's candle closes, then the live
 * prices this page saw after its last one; with no history source (null), only the live prices.
 * Only observed prices: nothing is interpolated or carried back, a gap stays a gap, and a window
 * with less data shows less.
 */
export function chartView(range: ChartRange, now: number, history: ChartHistory | null, live: readonly PricePoint[]): ChartView {
  const { windowMs } = CHART_RANGES[range]
  const start = now - windowMs
  const inWindow = (p: PricePoint) => p.t >= start && p.t <= now && Number.isFinite(p.usd) && p.usd > 0
  const base = (history?.points ?? []).filter(inWindow)
  const lastT = base.reduce((m, p) => Math.max(m, p.t), Number.NEGATIVE_INFINITY)
  const tail = live.filter((p) => inWindow(p) && p.t > lastT)
  const points = [...base, ...tail].sort((a, b) => a.t - b.t).filter((p, i, all) => i === 0 || p.t !== (all[i - 1] as PricePoint).t)
  const first = points[0]
  const stepSec = history?.candleSec ?? LIVE_STEP_SEC
  return {
    points,
    source: history ? 'history' : 'live',
    partial: first !== undefined && first.t > start + Math.max(stepSec * 1000, windowMs / 10),
    since: history?.since ?? null,
  }
}
