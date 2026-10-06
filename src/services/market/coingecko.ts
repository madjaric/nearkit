import { getMarketJson, isRecord, numberOrNull as num } from './http'

/**
 * CoinGecko's `coins/markets` for NEAR itself: the one coin whose market cap, FDV, 24h volume
 * and supplies come from an exchange-wide source, not a DEX pair. Read as reported, or null.
 */

export interface CoinMarkets {
  priceUsd: number
  marketCapUsd: number | null
  fdvUsd: number | null
  volume24hUsd: number | null
  change24hPct: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  updatedAt: number | null
}

export function parseCoinMarkets(json: unknown): CoinMarkets | null {
  const row = Array.isArray(json) ? json[0] : null
  if (!isRecord(row)) return null
  const priceUsd = num(row.current_price)
  if (priceUsd === null || priceUsd <= 0) return null
  const updated = typeof row.last_updated === 'string' ? Date.parse(row.last_updated) : Number.NaN
  return {
    priceUsd,
    marketCapUsd: num(row.market_cap),
    fdvUsd: num(row.fully_diluted_valuation),
    volume24hUsd: num(row.total_volume),
    change24hPct: num(row.price_change_percentage_24h),
    circulatingSupply: num(row.circulating_supply),
    totalSupply: num(row.total_supply),
    updatedAt: Number.isFinite(updated) ? updated : null,
  }
}

export async function fetchCoinMarkets(fetchImpl: typeof fetch, url: string): Promise<CoinMarkets | null> {
  return parseCoinMarkets(await getMarketJson(fetchImpl, url))
}

/** `prices` of a market chart: [ms, usd] pairs, oldest first; a malformed pair is dropped, never repaired. */
export function parseMarketChart(json: unknown): { t: number; usd: number }[] {
  const prices = isRecord(json) && Array.isArray(json.prices) ? json.prices : []
  const out: { t: number; usd: number }[] = []
  for (const row of prices) {
    if (!Array.isArray(row) || typeof row[0] !== 'number' || !Number.isFinite(row[0]) || typeof row[1] !== 'number' || !(row[1] > 0)) continue
    out.push({ t: row[0], usd: row[1] })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * A NEAR token's USD prices from CoinGecko, by its contract (`coins/near-protocol/contract/{c}/market_chart`):
 * prices only, no candles (CoinGecko's granularity: 5 minutes over a day, hourly to 90 days, daily
 * beyond). Null when CoinGecko doesn't list the token (a 404).
 */
export async function fetchContractChart(fetchImpl: typeof fetch, apiBase: string, contract: string, days: number): Promise<{ t: number; usd: number }[] | null> {
  const json = await getMarketJson(fetchImpl, `${apiBase}/coins/near-protocol/contract/${encodeURIComponent(contract)}/market_chart?vs_currency=usd&days=${days}`, {
    notFound: 'null',
  })
  return json === null ? null : parseMarketChart(json)
}
