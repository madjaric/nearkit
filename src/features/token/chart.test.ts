import { beforeEach, describe, expect, it } from 'vitest'
import { linePoints } from './chartView'
import { livePrices, recordPrice, resetLivePrices } from './livePrices'

/**
 * What a token's price line draws when its source has prices but no candles (CoinGecko), or when no
 * source has its history at all: only observed prices. The source's prices, then the live prices this
 * page saw after them; with no source, only the live prices. Nothing is interpolated, carried back or
 * made up. (A source with candles is drawn as candles: src/lib/chart/ohlc.ts.)
 */

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const MIN = 60_000
const p = (minutesAgo: number, usd: number) => ({ t: NOW - minutesAgo * MIN, usd })

describe('price line points', () => {
  it('draws the source’s prices, then the live prices seen after the last of them', () => {
    const source = [p(90, 4.7), p(60, 4.75), p(30, 4.9), p(1, 5.0)]
    const live = [p(2, 4.99), p(0.5, 5.02)]
    // The live price from before the source's last one adds nothing; all of the source's history stays.
    expect(linePoints(source, live, NOW)).toEqual([p(90, 4.7), p(60, 4.75), p(30, 4.9), p(1, 5.0), p(0.5, 5.02)])
  })

  it('the live price moves the end of the line as it changes', () => {
    const source = [p(30, 4.9), p(1, 5.0)]
    expect(linePoints(source, [p(0.5, 5.02)], NOW).at(-1)).toEqual(p(0.5, 5.02))
    expect(linePoints(source, [p(0.5, 5.02), p(0.1, 5.1)], NOW).at(-1)).toEqual(p(0.1, 5.1))
  })

  it('with no source it draws only the prices this page saw', () => {
    const live = [p(3, 0.0056), p(2, 0.0057), p(1, 0.0057)]
    expect(linePoints([], live, NOW)).toEqual(live)
  })

  it('sparse prices are drawn where they are: a gap stays a gap', () => {
    expect(linePoints([p(6000, 1), p(3000, 2), p(60, 3)], [], NOW)).toEqual([p(6000, 1), p(3000, 2), p(60, 3)])
  })

  it('nothing seen and no source draws nothing: no made-up line', () => {
    expect(linePoints([], [], NOW)).toEqual([])
    expect(linePoints([], [p(1, 2)], NOW)).toEqual([p(1, 2)])
  })

  it('never adds a point: every point drawn was observed, in order, once a second (the chart’s time unit), the later one kept', () => {
    const source = [p(10, 1), p(10, 1), p(5, 2)]
    const live = [p(3, 3), p(4, 2.5), { t: NOW - 3 * MIN + 400, usd: 3.1 }]
    const out = linePoints(source, live, NOW)
    expect(out).toEqual([p(10, 1), p(5, 2), p(4, 2.5), { t: NOW - 3 * MIN + 400, usd: 3.1 }])
    for (const point of out) expect([...source, ...live]).toContainEqual(point)
  })

  it('a price from the future (clock skew), or one that isn’t a price, is not drawn', () => {
    expect(linePoints([], [{ t: NOW + 5_000, usd: 1 }], NOW)).toEqual([])
    expect(
      linePoints(
        [
          { t: NOW - MIN, usd: 0 },
          { t: NOW - 2 * MIN, usd: Number.NaN },
        ],
        [],
        NOW,
      ),
    ).toEqual([])
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
