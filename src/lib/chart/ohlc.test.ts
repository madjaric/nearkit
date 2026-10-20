import { describe, expect, it } from 'vitest'
import type { Candle } from '@/types/domain'
import { candlesFromColumns, normalizeCandles, planUpdate, priceMinMove, timestampMs, toChartTimes, viewAfterReplace } from './ohlc'

/** OHLC data as the chart receives it: every candle real, valid, once, in order (src/lib/chart/ohlc.ts). */

const H = 3_600_000
const T0 = Date.UTC(2026, 9, 19, 12) // 2026-10-19 12:00 UTC, in ms
const row = (t: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown = 1) => ({ t, o, h, l, c, v })
const candle = (i: number, o: Partial<Candle> = {}): Candle => ({ t: T0 + i * H, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, ...o })

describe('timestamps', () => {
  it('reads seconds and milliseconds as what they are, never one for the other', () => {
    expect(timestampMs(T0 / 1000)).toBe(T0)
    expect(timestampMs(T0)).toBe(T0)
    expect(timestampMs(1_792_429_200_000)).toBe(1_792_429_200_000)
    expect(timestampMs(1_792_429_200)).toBe(1_792_429_200_000)
  })

  it('rejects what is neither (µs, ns, years outside 2001–2286, negatives, fractions of a non-number)', () => {
    for (const bad of [T0 * 1000, T0 * 1_000_000, 5e10, 5e11, 0, -T0, Number.NaN, Number.POSITIVE_INFINITY, '1792429200', null, undefined])
      expect(timestampMs(bad), String(bad)).toBeNull()
  })
})

describe('normalizeCandles', () => {
  it('sorts chronologically', () => {
    const r = normalizeCandles([row(T0 + 2 * H, 1, 2, 1, 2), row(T0, 1, 2, 1, 2), row(T0 + H, 1, 2, 1, 2)])
    expect(r.candles.map((c) => c.t)).toEqual([T0, T0 + H, T0 + 2 * H])
    expect(r.dropped).toEqual({})
  })

  it('converts second timestamps to ms, candle by candle', () => {
    const r = normalizeCandles([row(T0 / 1000, 1, 2, 1, 2), row(T0 + H, 1, 2, 1, 2)])
    expect(r.candles.map((c) => c.t)).toEqual([T0, T0 + H])
  })

  it('rejects a candle whose high or low does not contain its open and close, never repairing it', () => {
    const r = normalizeCandles([
      row(T0, 1, 0.9, 0.5, 0.8), // high below open
      row(T0 + H, 1, 2, 1.2, 1.5), // low above open
      row(T0 + 2 * H, 1, 2, 0.5, 2.5), // close above high
      row(T0 + 3 * H, 1, 2, 0.5, 0.4), // close below low
      row(T0 + 4 * H, 1, 2, 0.5, 1.5), // fine
    ])
    expect(r.candles).toEqual([{ t: T0 + 4 * H, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }])
    expect(r.dropped).toEqual({ invalid: 4 })
  })

  it('rejects missing, non-numeric, non-finite, zero or negative prices, and bad times', () => {
    const r = normalizeCandles([
      row(T0, null, 2, 1, 1.5),
      row(T0 + H, '1', 2, 1, 1.5),
      row(T0 + 2 * H, 1, Number.NaN, 1, 1.5),
      row(T0 + 3 * H, 0, 2, 0, 1),
      row(T0 + 4 * H, -1, 2, -2, 1),
      row('later', 1, 2, 1, 1.5),
      row(T0 * 1000, 1, 2, 1, 1.5),
      row(T0 + 5 * H, 1, 2, 1, 1.5),
    ])
    expect(r.candles.map((c) => c.t)).toEqual([T0 + 5 * H])
    expect(r.dropped).toEqual({ invalid: 5, time: 2 })
  })

  it('keeps one candle per period, deterministically the last one given', () => {
    const r = normalizeCandles([row(T0, 1, 2, 1, 1.2, 5), row(T0 + H, 1, 2, 1, 1.5), row(T0, 1, 3, 1, 2.5, 9)])
    expect(r.candles).toEqual([
      { t: T0, o: 1, h: 3, l: 1, c: 2.5, v: 9 },
      { t: T0 + H, o: 1, h: 2, l: 1, c: 1.5, v: 1 },
    ])
    expect(r.dropped).toEqual({ duplicate: 1 })
    // The same input in another order of the other rows gives the same answer.
    expect(normalizeCandles([row(T0 + H, 1, 2, 1, 1.5), row(T0, 1, 2, 1, 1.2, 5), row(T0, 1, 3, 1, 2.5, 9)]).candles).toEqual(r.candles)
  })

  it('volume: kept as reported (zero included); unknown when it is not a number ≥ 0, never made up', () => {
    const r = normalizeCandles([
      row(T0, 1, 2, 1, 1.5, 0),
      row(T0 + H, 1, 2, 1, 1.5, null),
      row(T0 + 2 * H, 1, 2, 1, 1.5, -3),
      row(T0 + 3 * H, 1, 2, 1, 1.5, Number.NaN),
      { t: T0 + 4 * H, o: 1, h: 2, l: 1, c: 1.5 },
    ])
    expect(r.candles.map((c) => c.v)).toEqual([0, null, null, null, null])
  })

  it('keeps the exact price of a very low-priced token', () => {
    const o = 0.000017107713075206467
    const h = 0.0000172270640305922
    const l = 0.00001710448677888341
    const c = 0.00001712830659290912
    expect(normalizeCandles([row(T0, o, h, l, c)]).candles[0]).toEqual({ t: T0, o, h, l, c, v: 1 })
  })

  it('makes nothing up: no data, no candles', () => {
    expect(normalizeCandles([])).toEqual({ candles: [], dropped: {} })
  })
})

describe('candlesFromColumns (NEARKITS’ server: one array per field)', () => {
  it('reads index by index; an index missing from any price column is no candle', () => {
    const r = candlesFromColumns({ time: [T0, T0 + H, T0 + 2 * H], open: [1, 1, null], high: [2, 2, 2], low: [1, 1, 1], close: [1.5, 1.6], volume: [3] })
    expect(r.candles).toEqual([
      { t: T0, o: 1, h: 2, l: 1, c: 1.5, v: 3 },
      { t: T0 + H, o: 1, h: 2, l: 1, c: 1.6, v: null },
    ])
    expect(r.dropped).toEqual({ invalid: 1 })
  })

  it('null columns: nothing to draw', () => {
    expect(candlesFromColumns(null)).toEqual({ candles: [], dropped: {} })
  })
})

describe('priceMinMove', () => {
  it('gives a very low price enough decimals to show it (about four significant digits)', () => {
    expect(priceMinMove([candle(0, { o: 0.0000171, h: 0.0000173, l: 0.0000163, c: 0.0000172 })])).toBe(1e-8)
    expect(priceMinMove([candle(0, { o: 0.000000005, h: 0.000000006, l: 0.000000004, c: 0.000000005 })])).toBe(1e-12)
  })

  it('a dollar-priced token: cents and a little more; nothing: cents', () => {
    expect(priceMinMove([candle(0, { o: 5, h: 5.2, l: 4.9, c: 5.1 })])).toBe(0.001)
    expect(priceMinMove([candle(0, { o: 4100, h: 4200, l: 4000, c: 4150 })])).toBe(0.01)
    expect(priceMinMove([])).toBe(0.01)
  })
})

describe('toChartTimes', () => {
  it('turns ms into whole seconds shifted by one constant offset, so the order stays strictly ascending', () => {
    const cs = [candle(0), candle(1), candle(2)]
    expect(toChartTimes(cs, 7_200)).toEqual([T0 / 1000 + 7_200, T0 / 1000 + 3_600 + 7_200, T0 / 1000 + 7_200 + 7_200])
  })
})

describe('viewAfterReplace: where the view goes when a refresh replaces the series', () => {
  /** Candle times (ms) of candles `from` up to, not including, `to`. */
  const times = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => T0 + (from + i) * H)

  it('following the newest candle (it is in view): the same zoom and right gap, on the new newest candle', () => {
    // 30 candles in view, the newest (index 99) 3 bars from the right edge; the refresh has 101 candles.
    expect(viewAfterReplace({ prevTimes: times(0, 100), logical: { from: 72, to: 102 }, nextTimes: times(0, 101) })).toEqual({ kind: 'logical', from: 73, to: 103 })
    // History slid (the oldest dropped, one added): same length, still anchored on the newest.
    expect(viewAfterReplace({ prevTimes: times(0, 100), logical: { from: 72, to: 102 }, nextTimes: times(1, 101) })).toEqual({ kind: 'logical', from: 72, to: 102 })
  })

  it('looking at older candles: the very same candles, at the same place and zoom, wherever they now sit in the series', () => {
    // A drag leaves the view between bars (20.25 … 50.25): kept exactly, never snapped to whole bars.
    const view = { from: 20.25, to: 50.25 }
    // History slid by one (the oldest dropped, one added): the same candles are one index lower.
    expect(viewAfterReplace({ prevTimes: times(0, 100), logical: view, nextTimes: times(1, 101) })).toEqual({ kind: 'logical', from: 19.25, to: 49.25 })
    // One candle added at the end: nothing in view moved.
    expect(viewAfterReplace({ prevTimes: times(0, 100), logical: view, nextTimes: times(0, 101) })).toEqual({ kind: 'logical', from: 20.25, to: 50.25 })
    // A view that starts before the first candle keeps its blank space too.
    expect(viewAfterReplace({ prevTimes: times(0, 100), logical: { from: -4.5, to: 25.5 }, nextTimes: times(0, 101) })).toEqual({ kind: 'logical', from: -4.5, to: 25.5 })
  })

  it('looking at older candles the refresh no longer holds: the same stretch of time', () => {
    expect(viewAfterReplace({ prevTimes: times(0, 100), logical: { from: 2, to: 10 }, nextTimes: times(20, 120) })).toEqual({ kind: 'time' })
  })

  it('no view yet: fit', () => {
    expect(viewAfterReplace({ prevTimes: [], logical: null, nextTimes: times(0, 10) })).toEqual({ kind: 'fit' })
    expect(viewAfterReplace({ prevTimes: times(0, 10), logical: null, nextTimes: times(0, 10) })).toEqual({ kind: 'fit' })
  })
})

describe('planUpdate: what a refresh changes, so the chart keeps the user’s view', () => {
  const base = [candle(0), candle(1), candle(2)]

  it('nothing changed: nothing to do', () => {
    expect(
      planUpdate(
        base,
        base.map((c) => ({ ...c })),
      ),
    ).toEqual({ kind: 'none' })
  })

  it('the last candle moved, or new candles followed it: update from the last one', () => {
    expect(planUpdate(base, [candle(0), candle(1), candle(2, { c: 1.9, h: 2.1 })])).toEqual({ kind: 'tail', from: 2 })
    expect(planUpdate(base, [...base, candle(3), candle(4)])).toEqual({ kind: 'tail', from: 2 })
  })

  it('anything else (an older candle changed, history moved, fewer candles, a first load): replace', () => {
    expect(planUpdate(base, [candle(0, { c: 1.1 }), candle(1), candle(2)])).toEqual({ kind: 'replace' })
    expect(planUpdate(base, [candle(1), candle(2), candle(3)])).toEqual({ kind: 'replace' })
    expect(planUpdate(base, [candle(0), candle(1)])).toEqual({ kind: 'replace' })
    expect(planUpdate([], base)).toEqual({ kind: 'replace' })
  })
})
