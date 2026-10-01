/**
 * NEAR/USD at a past moment: hourly closes from Coinbase Exchange's public candles
 * (the same source NearKit uses for the live NEAR price; open to browsers). Used
 * only to value past trades in USD; a missing hour is null, never interpolated.
 */

export const HOUR_MS = 3_600_000
const MAX_CANDLES = 300

/**
 * A token screen's windows, and the Coinbase candle size each is drawn with (Coinbase offers
 * 60 s, 5 min, 15 min, 1 h, 6 h and 1 day; each window stays within one request of 300 candles).
 */
export const CHART_RANGES = {
  '1m': { windowMs: 60_000, granularity: 60 },
  '5m': { windowMs: 5 * 60_000, granularity: 60 },
  '15m': { windowMs: 15 * 60_000, granularity: 60 },
  '1H': { windowMs: HOUR_MS, granularity: 60 },
  '4H': { windowMs: 4 * HOUR_MS, granularity: 300 },
  '1D': { windowMs: 24 * HOUR_MS, granularity: 900 },
} as const satisfies Record<string, { windowMs: number; granularity: 60 | 300 | 900 }>

/**
 * NEAR/USD closes over the last `windowMs` (oldest first), from Coinbase Exchange's public
 * candles. A malformed candle is dropped, a failed read is empty: nothing is filled in.
 */
export async function fetchNearUsdCloses(
  fetchImpl: typeof fetch,
  productUrl: string,
  range: { windowMs: number; granularity: number },
  now: number,
): Promise<{ t: number; usd: number }[]> {
  const start = now - range.windowMs
  const url = `${productUrl}/candles?granularity=${range.granularity}&start=${new Date(start).toISOString()}&end=${new Date(now).toISOString()}`
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (!res.ok) return []
    const rows = (await res.json()) as unknown
    if (!Array.isArray(rows)) return []
    const out: { t: number; usd: number }[] = []
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'number' || typeof row[4] !== 'number' || !(row[4] > 0)) continue
      const t = row[0] * 1000
      // A candle opening before the window (Coinbase rounds the start down) or after now is not in it.
      if (t < start - range.granularity * 1000 || t > now) continue
      out.push({ t, usd: row[4] })
    }
    return out.sort((a, b) => a.t - b.t)
  } catch {
    return []
  }
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
