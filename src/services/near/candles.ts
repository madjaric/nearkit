import { candleOf } from '@/services/market/candle'
import type { Candle, ChartRange } from '@/types/domain'

/**
 * NEAR/USD at a past moment: hourly closes from Coinbase Exchange's public candles
 * (the same source NearKit uses for the live NEAR price; open to browsers). Used
 * only to value past trades in USD; a missing hour is null, never interpolated.
 */

export const HOUR_MS = 3_600_000
const MAX_CANDLES = 300

/**
 * A token screen's windows, each with the candle its history source draws it with: Coinbase's
 * granularity in seconds (it offers 60, 300, 900, 3600, 21600 and 86400) for NEAR, and
 * GeckoTerminal's timeframe and aggregate (minute 1/5/15, hour 1/4/12, day 1) for a DEX pair.
 * Every window fits one request (Coinbase: 300 candles; GeckoTerminal: 1000).
 */
export const CHART_RANGES = {
  '1H': { windowMs: HOUR_MS, coinbase: 60, gecko: { timeframe: 'minute', aggregate: 1, limit: 60 } },
  '4H': { windowMs: 4 * HOUR_MS, coinbase: 300, gecko: { timeframe: 'minute', aggregate: 5, limit: 48 } },
  '1D': { windowMs: 24 * HOUR_MS, coinbase: 900, gecko: { timeframe: 'minute', aggregate: 15, limit: 96 } },
  '1W': { windowMs: 7 * 24 * HOUR_MS, coinbase: 3600, gecko: { timeframe: 'hour', aggregate: 1, limit: 168 } },
  '1M': { windowMs: 30 * 24 * HOUR_MS, coinbase: 21600, gecko: { timeframe: 'hour', aggregate: 4, limit: 180 } },
} as const satisfies Record<
  ChartRange,
  { windowMs: number; coinbase: 60 | 300 | 900 | 3600 | 21600; gecko: { timeframe: 'minute' | 'hour' | 'day'; aggregate: number; limit: number } }
>

/**
 * NEAR/USD closes over the last `windowMs` (oldest first), from Coinbase Exchange's public
 * candles. A malformed candle is dropped; a failed read throws (the screen says so), never
 * an empty line that looks like one.
 */
export async function fetchNearUsdCloses(
  fetchImpl: typeof fetch,
  productUrl: string,
  range: { windowMs: number; granularity: number },
  now: number,
): Promise<{ t: number; usd: number }[]> {
  return (await fetchNearUsdHistory(fetchImpl, productUrl, range, now)).points
}

/**
 * The same request read both ways: the closes, and the full candles (Coinbase's rows are [time, low,
 * high, open, close, volume], volume in NEAR); a candle that doesn't add up is left out, never repaired.
 */
export async function fetchNearUsdHistory(
  fetchImpl: typeof fetch,
  productUrl: string,
  range: { windowMs: number; granularity: number },
  now: number,
): Promise<{ points: { t: number; usd: number }[]; candles: Candle[] }> {
  const start = now - range.windowMs
  const url = `${productUrl}/candles?granularity=${range.granularity}&start=${new Date(start).toISOString()}&end=${new Date(now).toISOString()}`
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`Coinbase answered HTTP ${res.status}`)
  const rows = (await res.json()) as unknown
  if (!Array.isArray(rows)) throw new Error('Coinbase returned something that isn’t a candle list')
  const out: { t: number; usd: number }[] = []
  const candles: Candle[] = []
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'number' || typeof row[4] !== 'number' || !(row[4] > 0)) continue
    const t = row[0] * 1000
    // A candle opening before the window (Coinbase rounds the start down) or after now is not in it.
    if (t < start - range.granularity * 1000 || t > now) continue
    out.push({ t, usd: row[4] })
    const candle = candleOf(row[0], row[3], row[2], row[1], row[4], row[5])
    if (candle) candles.push(candle)
  }
  return { points: out.sort((a, b) => a.t - b.t), candles: candles.sort((a, b) => a.t - b.t) }
}

export const hourOf = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS

/** Hour start (ms) → close, for every hour touching `times`. Failed windows stay missing. */
export async function fetchNearUsdHours(fetchImpl: typeof fetch, productUrl: string, times: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const hours = [...new Set(times.filter((t) => t > 0).map(hourOf))].sort((a, b) => a - b)
  let i = 0
  while (i < hours.length) {
    const start = hours[i] as number
    let end = start
    while (i < hours.length && (hours[i] as number) - start < (MAX_CANDLES - 1) * HOUR_MS) end = hours[i++] as number
    const url = `${productUrl}/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end + HOUR_MS).toISOString()}`
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
      if (!res.ok) continue
      const rows = (await res.json()) as unknown
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== 'number' || typeof row[4] !== 'number' || !(row[4] > 0)) continue
        out.set(row[0] * 1000, row[4])
      }
    } catch {
      // unknown for this window
    }
  }
  return out
}

/** Close of the hour `ms` falls in, else of the hour before (candles appear when the hour ends). */
export function usdAt(hours: ReadonlyMap<number, number>, ms: number): number | null {
  return hours.get(hourOf(ms)) ?? hours.get(hourOf(ms) - HOUR_MS) ?? null
}
