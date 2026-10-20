import { describe, expect, it } from 'vitest'
import { CANDLE_INTERVALS, defaultInterval, INTERVAL_LABEL, INTERVAL_REFRESH_MS, parseInterval, SOURCE_INTERVALS } from './intervals'

/** The candle intervals every token chart offers, and what each history source really has (src/lib/chart/intervals.ts). */

const H = 3_600_000

describe('candle intervals', () => {
  it('are labelled so a minute never reads as a month', () => {
    expect(CANDLE_INTERVALS.map((i) => INTERVAL_LABEL[i])).toEqual(['1min', '5min', '15min', '1h', '4h', '1d'])
  })

  it('a market’s first interval: fine while it is young, hourly once it has days of history (or no known age)', () => {
    expect(defaultInterval(2 * H)).toBe('5m')
    expect(defaultInterval(30 * H)).toBe('15m')
    expect(defaultInterval(10 * 24 * H)).toBe('1h')
    expect(defaultInterval(null)).toBe('1h')
  })

  it('reads an interval from the address; anything else is no choice', () => {
    expect(parseInterval('5m')).toBe('5m')
    expect(parseInterval('3m')).toBeNull()
    expect(parseInterval('1M')).toBeNull()
    expect(parseInterval(null)).toBeNull()
  })

  it('refreshes a finer interval more often, never faster than every 30 s', () => {
    expect(INTERVAL_REFRESH_MS['1m']).toBe(30_000)
    for (let i = 1; i < CANDLE_INTERVALS.length; i++)
      expect(INTERVAL_REFRESH_MS[CANDLE_INTERVALS[i] as (typeof CANDLE_INTERVALS)[number]]).toBeGreaterThan(
        INTERVAL_REFRESH_MS[CANDLE_INTERVALS[i - 1] as (typeof CANDLE_INTERVALS)[number]],
      )
  })

  it('each source offers only the intervals it really has: GeckoTerminal and Intear all six, Coinbase no 4-hour candles, CoinGecko prices at 5 minutes, hourly and daily', () => {
    expect(SOURCE_INTERVALS.Intear).toEqual(CANDLE_INTERVALS)
    expect(SOURCE_INTERVALS.GeckoTerminal).toEqual(CANDLE_INTERVALS)
    expect(SOURCE_INTERVALS.Coinbase).toEqual(['1m', '5m', '15m', '1h', '1d'])
    expect(SOURCE_INTERVALS.CoinGecko).toEqual(['5m', '1h', '1d'])
  })
})
