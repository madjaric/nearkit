import type { Candle, PricePoint } from '@/types/domain'
import { candleOf } from './candle'
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

/** One side of a pool: the token (without the `near_` prefix), its symbol and its USD price. */
export interface GtPoolSide {
  id: string
  symbol: string | null
  priceUsd: number | null
}

/** A pool's figures, as GeckoTerminal reports them; a figure it doesn't give is null, never zero. */
export interface GtPool {
  /** The pool's id without the `near_` prefix (Rhea DCL: `refv2-<x>:<y>:<fee>`). */
  id: string
  /** GeckoTerminal's id of the DEX (e.g. `rhea-finance`). */
  dexId: string | null
  base: GtPoolSide
  quote: GtPoolSide
  /** One base token in quote tokens, and one quote token in base tokens. */
  baseInQuote: number | null
  quoteInBase: number | null
  /** The base token's price change over 24 hours, in percent. */
  change24hPct: number | null
  /** Both sides of the pool, in USD. */
  liquidityUsd: number | null
  volume24hUsd: number | null
  txns24h: { buys: number; sells: number } | null
}

const tokenId = (rel: unknown): string | null => {
  const data = isRecord(rel) && isRecord(rel.data) ? rel.data : null
  return data && typeof data.id === 'string' ? data.id.replace(/^near_/, '') : null
}

/** `GET {base}/pools/{pool}?include=base_token,quote_token,dex`: null when it isn't one GeckoTerminal indexes. */
export function parseGtPool(json: unknown): GtPool | null {
  const data = isRecord(json) && isRecord(json.data) ? json.data : null
  const a = data && isRecord(data.attributes) ? data.attributes : null
  const rel = data && isRecord(data.relationships) ? data.relationships : null
  const baseId = tokenId(rel?.base_token)
  const quoteId = tokenId(rel?.quote_token)
  if (!data || !a || !baseId || !quoteId || typeof data.id !== 'string') return null
  const included = isRecord(json) && Array.isArray(json.included) ? json.included.filter(isRecord) : []
  const symbol = (id: string) => {
    const t = included.find((i) => i.type === 'token' && i.id === `near_${id}`)
    const s = t && isRecord(t.attributes) ? t.attributes.symbol : null
    return typeof s === 'string' && s ? s : null
  }
  const dex = rel && isRecord(rel.dex) && isRecord(rel.dex.data) && typeof rel.dex.data.id === 'string' ? rel.dex.data.id : null
  const h24 = isRecord(a.transactions) && isRecord(a.transactions.h24) ? a.transactions.h24 : null
  const buys = h24 ? num(h24.buys) : null
  const sells = h24 ? num(h24.sells) : null
  return {
    id: data.id.replace(/^near_/, ''),
    dexId: dex,
    base: { id: baseId, symbol: symbol(baseId), priceUsd: num(a.base_token_price_usd) },
    quote: { id: quoteId, symbol: symbol(quoteId), priceUsd: num(a.quote_token_price_usd) },
    baseInQuote: num(a.base_token_price_quote_token),
    quoteInBase: num(a.quote_token_price_base_token),
    change24hPct: isRecord(a.price_change_percentage) ? num(a.price_change_percentage.h24) : null,
    liquidityUsd: num(a.reserve_in_usd),
    volume24hUsd: isRecord(a.volume_usd) ? num(a.volume_usd.h24) : null,
    txns24h: buys !== null && sells !== null ? { buys, sells } : null,
  }
}

/** A pool's figures with its two tokens and its DEX; null when GeckoTerminal doesn't index it. */
export async function fetchGtPool(fetchImpl: typeof fetch, baseUrl: string, pool: string): Promise<GtPool | null> {
  const json = await getMarketJson(fetchImpl, `${baseUrl}/pools/${pool}?include=base_token,quote_token,dex`, { notFound: 'null' }).catch(unanswered)
  return json === null ? null : parseGtPool(json)
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

/** The full candles, oldest first: [timestamp, open, high, low, close, volume (USD)] per row; one that doesn't add up is dropped. */
export function parseGtCandles(json: unknown): Candle[] {
  const data = isRecord(json) && isRecord(json.data) ? json.data : null
  const a = data && isRecord(data.attributes) ? data.attributes : null
  const list = a && Array.isArray(a.ohlcv_list) ? a.ohlcv_list : []
  const out: Candle[] = []
  for (const row of list) {
    if (!Array.isArray(row)) continue
    const candle = candleOf(row[0], row[1], row[2], row[3], row[4], row[5])
    if (candle) out.push(candle)
  }
  return out.sort((x, y) => x.t - y.t)
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
  return (await fetchGtHistory(fetchImpl, baseUrl, pool, candles, currency)).points
}

/** The symbols of a candle answer's pool, from its own `meta` (null when it doesn't say). */
export function parseGtMarket(json: unknown): { base: string | null; quote: string | null } {
  const meta = isRecord(json) && isRecord(json.meta) ? json.meta : null
  const symbol = (side: unknown) => (isRecord(side) && typeof side.symbol === 'string' && side.symbol ? side.symbol : null)
  return { base: symbol(meta?.base), quote: symbol(meta?.quote) }
}

/**
 * The same request, read both ways: the closes and the full candles. `token`: price the candles as
 * this token (GeckoTerminal's `token=` parameter), whichever side of the pool it is on.
 */
export async function fetchGtHistory(
  fetchImpl: typeof fetch,
  baseUrl: string,
  pool: string,
  candles: GtCandles,
  currency: 'usd' | 'token' = 'usd',
  token?: string,
): Promise<{ points: PricePoint[]; candles: Candle[]; market: { base: string | null; quote: string | null } }> {
  const url = `${baseUrl}/pools/${pool}/ohlcv/${candles.timeframe}?aggregate=${candles.aggregate}&limit=${candles.limit}&currency=${currency}${token ? `&token=${encodeURIComponent(token)}` : ''}`
  const json = await getMarketJson(fetchImpl, url).catch(unanswered)
  return { points: parseGtOhlcv(json), candles: parseGtCandles(json), market: parseGtMarket(json) }
}
