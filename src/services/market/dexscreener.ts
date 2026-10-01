import { getMarketJson, isRecord, numberOrNull as num } from './http'

/**
 * DEX Screener's indexed pairs (https://docs.dexscreener.com/api/reference): on NEAR (chain id
 * `near`) that is Rhea's pools, classic (`refv1-<id>`) and DCL (`refv2-<x>:<y>:<fee>`). A pair
 * carries the market figures the token screen shows: price in USD and in the quote token, 24h
 * change, liquidity, 24h volume, FDV, its own "marketCap" (FDV again when no circulating supply
 * is known: the caller decides what that means), trades, and when it was created. Each figure
 * is read as reported, or left null; nothing is estimated.
 */

export interface DexPair {
  /** The pair's id at its DEX (`pairAddress`). */
  id: string
  dex: string
  url: string | null
  base: { address: string; symbol: string }
  quote: { address: string; symbol: string }
  priceUsd: number | null
  /** The base token's price in the quote token. */
  priceNative: number | null
  change24hPct: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  txns24h: { buys: number; sells: number } | null
  createdAt: number | null
}

function tokenOf(v: unknown): { address: string; symbol: string } | null {
  if (!isRecord(v) || typeof v.address !== 'string' || !v.address) return null
  return { address: v.address, symbol: typeof v.symbol === 'string' && v.symbol ? v.symbol : v.address }
}

/** The pairs in an answer (a bare list, or `{ pairs }` from the search endpoint); rows that aren't pairs are dropped. */
export function parseDexPairs(json: unknown): DexPair[] {
  const rows: unknown[] = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.pairs) ? json.pairs : []
  return rows.flatMap((r): DexPair[] => {
    if (!isRecord(r) || typeof r.pairAddress !== 'string' || !r.pairAddress) return []
    const base = tokenOf(r.baseToken)
    const quote = tokenOf(r.quoteToken)
    if (!base || !quote) return []
    const h24 = isRecord(r.txns) && isRecord(r.txns.h24) ? r.txns.h24 : null
    const buys = h24 ? num(h24.buys) : null
    const sells = h24 ? num(h24.sells) : null
    return [
      {
        id: r.pairAddress,
        dex: typeof r.dexId === 'string' && r.dexId ? r.dexId : 'unknown',
        url: typeof r.url === 'string' && r.url ? r.url : null,
        base,
        quote,
        priceUsd: num(r.priceUsd),
        priceNative: num(r.priceNative),
        change24hPct: isRecord(r.priceChange) ? num(r.priceChange.h24) : null,
        liquidityUsd: isRecord(r.liquidity) ? num(r.liquidity.usd) : null,
        volume24hUsd: isRecord(r.volume) ? num(r.volume.h24) : null,
        fdvUsd: num(r.fdv),
        marketCapUsd: num(r.marketCap),
        txns24h: buys !== null && sells !== null ? { buys, sells } : null,
        createdAt: num(r.pairCreatedAt),
      },
    ]
  })
}

/** The deepest pair the token trades on (either side), by liquidity; null when it trades on none. */
export function mainPair(pairs: readonly DexPair[], token: string): DexPair | null {
  const own = pairs.filter((p) => p.base.address === token || p.quote.address === token)
  own.sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1))
  return own[0] ?? null
}

/** Every indexed pair of a token on a chain: `GET {base}/token-pairs/v1/{chain}/{token}`. */
export async function fetchDexPairs(fetchImpl: typeof fetch, baseUrl: string, chain: string, token: string): Promise<DexPair[]> {
  return parseDexPairs(await getMarketJson(fetchImpl, `${baseUrl}/token-pairs/v1/${chain}/${encodeURIComponent(token)}`))
}
