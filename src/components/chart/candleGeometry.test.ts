import { describe, expect, it } from 'vitest'
import type { Candle } from '@/types/domain'
import { layoutCandles } from './candleGeometry'

const MIN = 60_000
const T = Date.UTC(2026, 9, 5, 12)
const candle = (t: number, o: number, h: number, l: number, c: number, v: number | null = 10): Candle => ({ t, o, h, l, c, v })
const opts = { start: T, end: T + 10 * MIN, candleMs: MIN, priceH: 200, volTop: 210, volH: 40 }

describe('candle layout', () => {
  it('each candle sits at its own time: a gap between candles stays a gap, nothing is drawn in it', () => {
    const { boxes } = layoutCandles([candle(T, 1, 2, 0.5, 1.5), candle(T + 7 * MIN, 1.5, 1.6, 1, 1.2)], opts)
    expect(boxes.map((b) => b.i)).toEqual([0, 1])
    // Centres at 0.5 and 7.5 minutes of a 10-minute window.
    expect(boxes[0]?.x).toBeCloseTo(0.05, 9)
    expect(boxes[1]?.x).toBeCloseTo(0.75, 9)
    expect(boxes[0]?.w).toBeCloseTo(0.07, 9)
  })

  it('green when it closed at or above its open, red below; the body spans open to close, the wick high to low', () => {
    const { boxes, y } = layoutCandles([candle(T, 1, 2, 0.5, 1.5), candle(T + MIN, 1.5, 1.6, 1, 1.2)], opts)
    expect(boxes.map((b) => b.up)).toEqual([true, false])
    const up = boxes[0]
    expect(up?.bodyY).toBeCloseTo(y(1.5), 9)
    expect(up?.bodyH).toBeCloseTo(y(1) - y(1.5), 9)
    expect(up?.wickY1).toBeCloseTo(y(2), 9)
    expect(up?.wickY2).toBeCloseTo(y(0.5), 9)
  })

  it('a flat candle still shows a 1px body; volume bars scale to the largest; an unknown volume draws none', () => {
    const { boxes } = layoutCandles([candle(T, 1, 1, 1, 1, 5), candle(T + MIN, 1, 2, 1, 2, 10), candle(T + 2 * MIN, 2, 2, 2, 2, null)], opts)
    expect(boxes[0]?.bodyH).toBe(1)
    expect(boxes[1]?.volH).toBeCloseTo(40, 9)
    expect(boxes[0]?.volH).toBeCloseTo(20, 9)
    expect(boxes[0]?.volY).toBeCloseTo(210 + 20, 9)
    expect(boxes[2]?.volH).toBe(0)
  })

  it('candles outside the window are left out; the live price stretches the price scale to stay in view', () => {
    const { boxes, ticks } = layoutCandles([candle(T - 5 * MIN, 1, 2, 0.5, 1), candle(T, 1, 2, 0.5, 1.5)], { ...opts, extra: 3 })
    expect(boxes.map((b) => b.i)).toEqual([1])
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(3)
  })
})
