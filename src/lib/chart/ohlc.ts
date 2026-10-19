import type { Candle } from '@/types/domain'

/**
 * OHLC data as a price chart may draw it: every candle a source reported, valid, once per period, in
 * time order. Nothing is repaired, interpolated or made up: a candle that doesn't add up is left out
 * and counted, a missing volume stays unknown, and no data stays no data.
 */

/** Why candles were left out, with how many. */
export type Dropped = Partial<Record<'time' | 'invalid' | 'duplicate', number>>

export interface Normalized {
  candles: Candle[]
  dropped: Dropped
}

/** A candle as a source gives it: any field may be missing or malformed. */
export interface RawCandle {
  t: unknown
  o: unknown
  h: unknown
  l: unknown
  c: unknown
  v?: unknown
}

const SEC_FROM = 1e9 // 2001-09-09 in seconds
const SEC_TO = 1e10 // 2286-11-20 in seconds
const MS_FROM = 1e12 // 2001-09-09 in ms
const MS_TO = 1e13 // 2286-11-20 in ms

/**
 * A timestamp in ms, from seconds or ms told apart by size: both cover 2001–2286 and never overlap, so
 * one is never read as the other. Anything else (µs, ns, other years, not a number) is null.
 */
export function timestampMs(t: unknown): number | null {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  if (t >= SEC_FROM && t < SEC_TO) return Math.round(t * 1000)
  if (t >= MS_FROM && t < MS_TO) return t
  return null
}

const price = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/**
 * Valid candles, oldest first. A candle is kept only with a known time and four prices above zero whose
 * high is at or above the open, close and low, and low at or below them. Two candles for one period:
 * the last one given is kept (a source's later row for a period is its newer reading).
 */
export function normalizeCandles(rows: readonly RawCandle[]): Normalized {
  const dropped: Dropped = {}
  const count = (k: keyof Dropped) => (dropped[k] = (dropped[k] ?? 0) + 1)
  const byTime = new Map<number, Candle>()
  for (const r of rows) {
    const { o, h, l, c } = r
    if (!price(o) || !price(h) || !price(l) || !price(c) || h < Math.max(o, c, l) || l > Math.min(o, c, h)) {
      count('invalid')
      continue
    }
    const t = timestampMs(r.t)
    if (t === null) {
      count('time')
      continue
    }
    if (byTime.has(t)) count('duplicate')
    const v = typeof r.v === 'number' && Number.isFinite(r.v) && r.v >= 0 ? r.v : null
    byTime.set(t, { t, o, h, l, c, v })
  }
  return { candles: [...byTime.values()].sort((a, b) => a.t - b.t), dropped }
}

/** NEARKITS' server sends candles as one array per field (time in ms): read index by index. */
export function candlesFromColumns(
  cols:
    | { time: readonly unknown[]; open: readonly unknown[]; high: readonly unknown[]; low: readonly unknown[]; close: readonly unknown[]; volume: readonly unknown[] }
    | null
    | undefined,
): Normalized {
  if (!cols || !Array.isArray(cols.time)) return { candles: [], dropped: {} }
  return normalizeCandles(cols.time.map((t, i) => ({ t, o: cols.open[i], h: cols.high[i], l: cols.low[i], c: cols.close[i], v: cols.volume[i] })))
}

/**
 * The price step the chart's scale works in: about four significant digits at the lowest price shown,
 * at least cents, at most 15 decimals. A token at $0.0000171 gets 8 decimals, not "$0.00".
 */
export function priceMinMove(candles: readonly Candle[]): number {
  const low = candles.reduce((m, c) => (c.l > 0 && c.l < m ? c.l : m), Number.POSITIVE_INFINITY)
  if (!Number.isFinite(low)) return 0.01
  const decimals = Math.min(15, Math.max(2, Math.ceil(-Math.log10(low)) + 3))
  return Number(`1e-${decimals}`)
}

/**
 * Chart times: whole seconds, shifted by one constant offset (the viewer's UTC offset, so the axis reads
 * local time). One offset for the whole series keeps the order strictly ascending, as the chart needs.
 */
export function toChartTimes(candles: readonly Candle[], offsetSec: number): number[] {
  return candles.map((c) => Math.floor(c.t / 1000) + offsetSec)
}

/**
 * Where the view goes when a refresh replaces the series. Following the newest candle (it is in view):
 * the same zoom and right gap, on the new newest candle. Looking at older candles: the same stretch of
 * time (restored by time, wherever it now sits in the series). No view yet: fit the data.
 */
export function viewAfterReplace(o: {
  prevLength: number
  logical: { from: number; to: number } | null
  nextLength: number
}): { kind: 'fit' } | { kind: 'time' } | { kind: 'logical'; from: number; to: number } {
  if (!o.logical || o.prevLength === 0) return { kind: 'fit' }
  const lastPrev = o.prevLength - 1
  if (o.logical.to < lastPrev - 0.5) return { kind: 'time' }
  const gap = o.logical.to - lastPrev
  const width = o.logical.to - o.logical.from
  const lastNext = o.nextLength - 1
  return { kind: 'logical', from: lastNext + gap - width, to: lastNext + gap }
}

const same = (a: Candle, b: Candle) => a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v

/**
 * What a refresh changes: nothing; only the last candle and what follows it (drawn in place, the user's
 * view untouched); or anything else (the series is replaced, and the view restored by time).
 */
export function planUpdate(prev: readonly Candle[], next: readonly Candle[]): { kind: 'none' } | { kind: 'tail'; from: number } | { kind: 'replace' } {
  const last = prev.length - 1
  if (last < 0 || next.length < prev.length) return { kind: 'replace' }
  for (let i = 0; i < last; i++) if (!same(prev[i] as Candle, next[i] as Candle)) return { kind: 'replace' }
  if ((next[last] as Candle).t !== (prev[last] as Candle).t) return { kind: 'replace' }
  if (next.length === prev.length && same(prev[last] as Candle, next[last] as Candle)) return { kind: 'none' }
  return { kind: 'tail', from: last }
}
