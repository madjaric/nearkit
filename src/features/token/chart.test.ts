import { beforeEach, describe, expect, it } from 'vitest'
import { chartView } from './chartView'
import { livePrices, recordPrice, resetLivePrices } from './livePrices'

/**
 * What a token chart draws: only observed prices. A history source's points (Coinbase for
 * NEAR), then the live prices this page saw after them; with no history source, only the live
 * prices. Nothing is interpolated, carried back or made up: a window with less data shows less.
 */

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const MIN = 60_000
const p = (minutesAgo: number, usd: number) => ({ t: NOW - minutesAgo * MIN, usd })

describe('chart points', () => {
  it('draws the history in the window, then the live prices seen after it', () => {
    const history = [p(90, 4.7), p(50, 4.8), p(30, 4.9), p(1, 5.0)]
    const live = [p(2, 4.99), p(0.5, 5.02)]
    const v = chartView('1H', NOW, history, live)
    expect(v.source).toBe('history')
    // 90 minutes ago is outside the hour; the live price from before the last candle adds nothing.
    expect(v.points).toEqual([p(50, 4.8), p(30, 4.9), p(1, 5.0), p(0.5, 5.02)])
  })

  it('the live price moves the end of the line as it changes', () => {
    const history = [p(30, 4.9), p(1, 5.0)]
    expect(chartView('1H', NOW, history, [p(0.5, 5.02)]).points.at(-1)).toEqual(p(0.5, 5.02))
    expect(chartView('1H', NOW, history, [p(0.5, 5.02), p(0.1, 5.1)]).points.at(-1)).toEqual(p(0.1, 5.1))
  })

  it('with no history source it draws only the prices this page saw, and says the window is only partly covered', () => {
    const live = [p(3, 0.0056), p(2, 0.0057), p(1, 0.0057)]
    const v = chartView('1D', NOW, null, live)
    expect(v.source).toBe('live')
    expect(v.points).toEqual(live)
    expect(v.partial).toBe(true)
  })

  it('an empty history or nothing seen yet draws nothing: no made-up line', () => {
    expect(chartView('1H', NOW, [], []).points).toEqual([])
    expect(chartView('5m', NOW, null, []).points).toEqual([])
    // One observation is one point, not a line through the window.
    expect(chartView('5m', NOW, null, [p(1, 2)]).points).toEqual([p(1, 2)])
  })

  it('never adds a point: every point drawn was observed, in order, once', () => {
    const history = [p(10, 1), p(10, 1), p(5, 2)]
    const live = [p(3, 3), p(4, 2.5)]
    const v = chartView('15m', NOW, history, live)
    expect(v.points).toEqual([p(10, 1), p(5, 2), p(4, 2.5), p(3, 3)])
    for (const point of v.points) expect([...history, ...live]).toContainEqual(point)
  })

  it('a price from the future (clock skew) is not drawn', () => {
    expect(chartView('1m', NOW, null, [{ t: NOW + 5_000, usd: 1 }]).points).toEqual([])
  })
})

describe('prices seen live', () => {
  beforeEach(() => resetLivePrices())

  it('keeps each observation once, in time order, per token', () => {
    expect(recordPrice('a.near', 1, NOW)).toBe(true)
    // The same fetch read again (the source's cache): not a new observation.
    expect(recordPrice('a.near', 1, NOW)).toBe(false)
    expect(recordPrice('a.near', 1.1, NOW + MIN)).toBe(true)
    // Older than the last one: out of order, dropped.
    expect(recordPrice('a.near', 0.9, NOW - MIN)).toBe(false)
    expect(livePrices('a.near')).toEqual([
      { t: NOW, usd: 1 },
      { t: NOW + MIN, usd: 1.1 },
    ])
    expect(livePrices('b.near')).toEqual([])
  })

  it('never records a missing, zero or broken price', () => {
    expect(recordPrice('a.near', 0, NOW)).toBe(false)
    expect(recordPrice('a.near', Number.NaN, NOW)).toBe(false)
    expect(recordPrice('a.near', -1, NOW)).toBe(false)
    expect(livePrices('a.near')).toEqual([])
  })

  it('keeps one day at most', () => {
    recordPrice('a.near', 1, NOW)
    recordPrice('a.near', 2, NOW + 25 * 60 * MIN)
    expect(livePrices('a.near')).toEqual([{ t: NOW + 25 * 60 * MIN, usd: 2 }])
  })

  it('gives the same list back until something new is seen (a stable snapshot for the screen)', () => {
    recordPrice('a.near', 1, NOW)
    const first = livePrices('a.near')
    expect(livePrices('a.near')).toBe(first)
    recordPrice('a.near', 2, NOW + MIN)
    expect(livePrices('a.near')).not.toBe(first)
  })
})
