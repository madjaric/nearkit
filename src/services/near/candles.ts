/**
 * NEAR/USD at a past moment: hourly closes from Coinbase Exchange's public candles
 * (the same source NearKit uses for the live NEAR price; open to browsers). Used
 * only to value past trades in USD; a missing hour is null, never interpolated.
 */

export const HOUR_MS = 3_600_000
const MAX_CANDLES = 300

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
