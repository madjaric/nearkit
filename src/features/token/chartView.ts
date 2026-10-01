import { CHART_RANGES } from '@/services/near/candles'
import type { ChartRange, PricePoint } from '@/types/domain'

export interface ChartView {
  points: PricePoint[]
  /** `history`: a history source's points with the live prices after them; `live`: only what this page saw. */
  source: 'history' | 'live'
  /** The first point is well after the window starts: the rest of the window has no data (and none is drawn). */
  partial: boolean
}

/**
 * The points a token chart draws for `range`: the history source's, then the live prices this
 * page saw after its last one; with no history source (null), only the live prices. Only
 * observed prices: nothing is interpolated or carried back, and a window with less data shows less.
 */
export function chartView(range: ChartRange, now: number, history: readonly PricePoint[] | null, live: readonly PricePoint[]): ChartView {
  const { windowMs, granularity } = CHART_RANGES[range]
  const start = now - windowMs
  const inWindow = (p: PricePoint) => p.t >= start && p.t <= now && Number.isFinite(p.usd) && p.usd > 0
  const base = (history ?? []).filter(inWindow)
  const lastT = base.reduce((m, p) => Math.max(m, p.t), Number.NEGATIVE_INFINITY)
  const tail = live.filter((p) => inWindow(p) && p.t > lastT)
  const points = [...base, ...tail].sort((a, b) => a.t - b.t).filter((p, i, all) => i === 0 || p.t !== (all[i - 1] as PricePoint).t)
  const first = points[0]
  return { points, source: history ? 'history' : 'live', partial: first !== undefined && first.t > start + granularity * 1000 }
}
