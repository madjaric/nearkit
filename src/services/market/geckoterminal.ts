import type { PricePoint } from '@/types/domain'
import { getMarketJson, isRecord, MarketSourceError, numberOrNull as num } from './http'

/**
 * GeckoTerminal, CoinGecko's DEX data (https://www.geckoterminal.com/dex-api), on NEAR: a
 * token's figures, and a pool's OHLCV candles, the only free, browser-readable history of a
 * NEAR DEX market. A candle exists only for a period with trades, and its close is the last
 * trade's price. The free API allows about 30 requests a minute per IP: a 429 is reported as
 * such, never shown as a missing market.
 */

export { MarketSourceError }

export interface GtToken {
  priceUsd: number | null
  fdvUsd: number | null
  /** Only when CoinGecko knows the circulating supply; null otherwise (never the FDV). */
  marketCapUsd: number | null
  /** Whole tokens. */
  totalSupply: number | null
  volume24hUsd: number | null
  coingeckoId: string | null
  /** Pool ids, deepest first, without the `near_` prefix. */
  topPools: string[]
}

export interface GtCandles {
  timeframe: 'minute' | 'hour' | 'day'
  aggregate: number
  limit: number
}

export function parseGtToken(json: unknown): GtToken | null {
  const data = isRecord(json) && isRecord(json.data) ? json.data : null
  const a = data && isRecord(data.attributes) ? data.attributes : null
  if (!a) return null
  const rel = data && isRecord(data.relationships) && isRecord(data.relationships.top_pools) ? data.relationships.top_pools.data : null
  const topPools = Array.isArray(rel) ? rel.flatMap((p) => (isRecord(p) && typeof p.id === 'string' ? [p.id.replace(/^near_/, '')] : [])) : []
  return {
    priceUsd: num(a.price_usd),
    fdvUsd: num(a.fdv_usd),
    marketCapUsd: num(a.market_cap_usd),
    totalSupply: num(a.normalized_total_supply),
    volume24hUsd: isRecord(a.volume_usd) ? num(a.volume_usd.h24) : null,
    coingeckoId: typeof a.coingecko_coin_id === 'string' && a.coingecko_coin_id ? a.coingecko_coin_id : null,
    topPools,
  }
}

/** Each candle's close at the candle's start, oldest first; a malformed candle is dropped, not repaired. */
export function parseGtOhlcv(json: unknown): PricePoint[] {
  const data = isRecord(json) && isRecord(json.data) ? json.data : null
  const a = data && isRecord(data.attributes) ? data.attributes : null
  const list = a && Array.isArray(a.ohlcv_list) ? a.ohlcv_list : []
  const out: PricePoint[] = []
  for (const row of list) {
    if (!Array.isArray(row) || typeof row[0] !== 'number' || !Number.isFinite(row[0]) || typeof row[4] !== 'number' || !(row[4] > 0)) continue
    out.push({ t: row[0] * 1000, usd: row[4] })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * A request GeckoTerminal never answered. In a browser its rate-limit answers (429) carry no
 * CORS headers, so they arrive as a failed fetch with no status: the likeliest cause is named.
 */
function unanswered(e: unknown): never {
  if (e instanceof MarketSourceError && e.status === null)
    throw new MarketSourceError('GeckoTerminal didn’t answer: its rate limit (about 30 requests a minute from one address) or a network problem')
  throw e
}

/** A token's figures: `GET {base}/tokens/{token}`; null when GeckoTerminal doesn't index it. */
export async function fetchGtToken(fetchImpl: typeof fetch, baseUrl: string, token: string): Promise<GtToken | null> {
  const json = await getMarketJson(fetchImpl, `${baseUrl}/tokens/${encodeURIComponent(token)}`, { notFound: 'null' }).catch(unanswered)
  return json === null ? null : parseGtToken(json)
}

/** A pool's candles: `GET {base}/pools/{pool}/ohlcv/{timeframe}?aggregate=&limit=&currency=usd`. */
export async function fetchGtOhlcv(fetchImpl: typeof fetch, baseUrl: string, pool: string, candles: GtCandles, currency: 'usd' | 'token' = 'usd'): Promise<PricePoint[]> {
  const url = `${baseUrl}/pools/${pool}/ohlcv/${candles.timeframe}?aggregate=${candles.aggregate}&limit=${candles.limit}&currency=${currency}`
  return parseGtOhlcv(await getMarketJson(fetchImpl, url).catch(unanswered))
}
