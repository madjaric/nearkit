import type { Candle } from '@/types/domain'
import { yScale } from './geometry'
import { niceTicks } from './scale'

/** One candle's marks: x and width as fractions of the plot width, y and heights in plot pixels. */
export interface CandleBox {
  /** Its index in the candles given. */
  i: number
  /** The candle's centre (the middle of its period). */
  x: number
  w: number
  up: boolean
  bodyY: number
  bodyH: number
  wickY1: number
  wickY2: number
  volY: number
  volH: number
}

/** Of a candle's period, the share its body is drawn over (the rest is the space between candles). */
const BODY_SHARE = 0.7

/**
 * Where each candle of the window [start, end] is drawn: by its own time, so a period without
 * trades stays an empty gap (nothing is filled in). The price scale fits the candles' highs and lows
 * (and `extra`, the live price, so it stays in view); volume bars share a band below, scaled to the
 * largest volume shown. A candle with no known volume draws no bar.
 */
export function layoutCandles(
  candles: readonly Candle[],
  opts: { start: number; end: number; candleMs: number; priceH: number; volTop: number; volH: number; extra?: number | null },
): { boxes: CandleBox[]; ticks: number[]; y: (v: number) => number } {
  const span = opts.end - opts.start
  const shown = candles.map((c, i) => ({ c, i })).filter(({ c }) => c.t + opts.candleMs > opts.start && c.t <= opts.end)
  const lows = shown.map(({ c }) => c.l)
  const highs = shown.map(({ c }) => c.h)
  const extra = opts.extra !== null && opts.extra !== undefined && Number.isFinite(opts.extra) && opts.extra > 0 ? [opts.extra] : []
  const lo = Math.min(...lows, ...extra)
  const hi = Math.max(...highs, ...extra)
  const ticks = shown.length || extra.length ? niceTicks(lo, hi, 4) : []
  const y = yScale([ticks[0] ?? 0, ticks[ticks.length - 1] ?? 1], opts.priceH)
  const maxVolume = shown.reduce((m, { c }) => (c.v !== null && c.v > m ? c.v : m), 0)
  const w = span > 0 ? (opts.candleMs / span) * BODY_SHARE : 0
  const boxes = shown.map(({ c, i }): CandleBox => {
    const top = y(Math.max(c.o, c.c))
    const volH = c.v !== null && maxVolume > 0 ? (c.v / maxVolume) * opts.volH : 0
    return {
      i,
      x: span > 0 ? (c.t + opts.candleMs / 2 - opts.start) / span : 0,
      w,
      up: c.c >= c.o,
      bodyY: top,
      bodyH: Math.max(1, y(Math.min(c.o, c.c)) - top),
      wickY1: y(c.h),
      wickY2: y(c.l),
      volY: opts.volTop + opts.volH - volH,
      volH,
    }
  })
  return { boxes, ticks, y }
}
