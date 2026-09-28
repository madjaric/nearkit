import type { NetworkConfig } from '@/config/networks'

/**
 * USD prices, for display and valuation only; never an input to a transaction.
 * Token prices: Rhea's indexer (`api.rhea.finance`, the source the Rhea app uses;
 * the old `indexer.ref.finance` host is stale). NEAR/USD: Coinbase Exchange with
 * CoinGecko as fallback. Testnet has no prices.
 */

const TIMEOUT_MS = 6000

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const positive = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** contract → USD price. Rows with non-positive or malformed prices are dropped. */
export async function fetchTokenPrices(fetchImpl: typeof fetch, indexerUrl: string): Promise<Map<string, number>> {
  const body = await getJson(fetchImpl, `${indexerUrl}/list-token-price`)
  const prices = new Map<string, number>()
  if (!body || typeof body !== 'object') return prices
  for (const [contract, row] of Object.entries(body as Record<string, unknown>)) {
    const price = positive(row && typeof row === 'object' ? (row as { price?: unknown }).price : undefined)
    if (price !== null) prices.set(contract, price)
  }
  return prices
}

export interface NearUsd {
  priceUsd: number
  change24hPct: number | null
  at: number
}

export async function fetchNearUsd(fetchImpl: typeof fetch, sources: NetworkConfig['nearUsd']): Promise<NearUsd | null> {
  if (!sources) return null
  try {
    const [ticker, stats] = await Promise.all([getJson(fetchImpl, `${sources.coinbase}/ticker`), getJson(fetchImpl, `${sources.coinbase}/stats`).catch(() => null)])
    const price = positive((ticker as { price?: unknown } | null)?.price)
    if (price !== null) {
      const open = positive((stats as { open?: unknown } | null)?.open)
      const last = positive((stats as { last?: unknown } | null)?.last) ?? price
      return { priceUsd: price, change24hPct: open ? ((last - open) / open) * 100 : null, at: Date.now() }
    }
  } catch {
    // fall through to CoinGecko
  }
  try {
    const body = (await getJson(fetchImpl, sources.coingecko)) as { near?: { usd?: unknown; usd_24h_change?: unknown } }
    const price = positive(body?.near?.usd)
    if (price === null) return null
    const change = typeof body?.near?.usd_24h_change === 'number' && Number.isFinite(body.near.usd_24h_change) ? body.near.usd_24h_change : null
    return { priceUsd: price, change24hPct: change, at: Date.now() }
  } catch {
    return null
  }
}
