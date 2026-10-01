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
