import { CANDLE_INTERVAL_SEC, CANDLE_INTERVALS, type CandleInterval } from '@/lib/discovery/api'

/**
 * The candle intervals every NEARKITS token chart offers (Launch Radar and the Token page alike), and
 * which of them each history source really has. An interval a source doesn't have is shown, disabled,
 * with the reason: never drawn from another interval's candles.
 */

export { CANDLE_INTERVAL_SEC, CANDLE_INTERVALS, type CandleInterval }

// Read in capitals as the control prints them: 1MIN is a minute, never a month.
export const INTERVAL_LABEL: Readonly<Record<CandleInterval, string>> = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1d' }
export const INTERVAL_TEXT: Readonly<Record<CandleInterval, string>> = { '1m': '1-minute', '5m': '5-minute', '15m': '15-minute', '1h': 'hourly', '4h': '4-hour', '1d': 'daily' }

/** How often a chart asks for its candles again: about as often as its newest candle can change. */
export const INTERVAL_REFRESH_MS: Readonly<Record<CandleInterval, number>> = { '1m': 30_000, '5m': 60_000, '15m': 120_000, '1h': 300_000, '4h': 600_000, '1d': 1_800_000 }

/** A market's first interval: fine while it is young, hourly once it has days of history (and when its age is unknown). */
export function defaultInterval(ageMs: number | null): CandleInterval {
  if (ageMs === null) return '1h'
  if (ageMs < 6 * 3_600_000) return '5m'
  if (ageMs < 3 * 86_400_000) return '15m'
  return '1h'
}

/** An interval named in the address (`?interval=`); anything else is no choice. */
export function parseInterval(v: string | null): CandleInterval | null {
  return (CANDLE_INTERVALS as readonly string[]).includes(v ?? '') ? (v as CandleInterval) : null
}

/**
 * The intervals each history source has: Intear (NEARKITS' server) and GeckoTerminal all six; Coinbase's
 * NEAR/USD candles come at 1, 5 and 15 minutes, 1 hour, 6 hours and 1 day (no 4-hour); CoinGecko has
 * prices, not candles, at 5 minutes (one day), hourly (up to 90 days) and daily.
 */
export const SOURCE_INTERVALS = {
  Intear: CANDLE_INTERVALS,
  GeckoTerminal: CANDLE_INTERVALS,
  Coinbase: ['1m', '5m', '15m', '1h', '1d'],
  CoinGecko: ['5m', '1h', '1d'],
} as const satisfies Record<string, readonly CandleInterval[]>
