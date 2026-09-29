import { NEAR_DECIMALS } from '@/config/networks'
import type { Leg } from '@/services/near/flows'
import type { ServerNear } from '../near'

/**
 * Prices, supply and holders for buy alerts: NEAR/USD from Coinbase (CoinGecko
 * fallback), token prices from Rhea's price list (NearKit's own market module), supply
 * from the token contract, the holder count from NearBlocks. Anything unknown is null
 * and simply not shown. Slow or failing sources never hold an alert back for long.
 */

const SUPPLY_TTL_MS = 10 * 60_000
const HOLDERS_TTL_MS = 10 * 60_000
const HOLDERS_TIMEOUT_MS = 5_000

export function createBuyMarket(near: ServerNear, now: () => number = Date.now) {
  const supply = new Map<string, { at: number; value: Promise<bigint | null> }>()
  const holderCounts = new Map<string, { at: number; value: Promise<number | null> }>()

  async function fetchHolders(token: string): Promise<number | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HOLDERS_TIMEOUT_MS)
    try {
      const res = await near.ctx.fetch(`${near.ctx.network.discovery.nearblocksUrl}/v1/fts/${encodeURIComponent(token)}/holders/count`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { holders?: { count?: unknown }[] }
      const count = body.holders?.[0]?.count
      return typeof count === 'string' && /^\d{1,12}$/.test(count) ? Number(count) : typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function nearUsd(): Promise<number | null> {
    return (await near.market.nearQuote().catch(() => null))?.priceUsd ?? null
  }

  async function assetUsd(asset: string): Promise<number | null> {
    if (asset === 'near' || asset === near.ctx.network.wrapContract) return nearUsd()
    return (await near.market.quoteFor(asset).catch(() => null))?.priceUsd ?? null
  }

  async function meta(asset: string): Promise<{ symbol: string; decimals: number } | null> {
    if (asset === 'near') return { symbol: 'NEAR', decimals: NEAR_DECIMALS }
    try {
      const m = await near.ctx.reader.metadata(asset)
      return { symbol: m.symbol, decimals: m.decimals }
    } catch {
      return null
    }
  }

  const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals

  return {
    nearUsd,
    assetUsd,
    meta,
    /** How many accounts hold the token, per NearBlocks; null when it doesn't answer. */
    async holders(token: string): Promise<number | null> {
      const hit = holderCounts.get(token)
      if (hit && now() - hit.at < HOLDERS_TTL_MS) return hit.value
      const value = fetchHolders(token)
      holderCounts.set(token, { at: now(), value })
      // A failure is not cached for long: ask again in a minute.
      void value.then((v) => {
        if (v === null) holderCounts.set(token, { at: now() - HOLDERS_TTL_MS + 60_000, value })
      })
      return value
    },
    async totalSupply(token: string): Promise<bigint | null> {
      const hit = supply.get(token)
      if (hit && now() - hit.at < SUPPLY_TTL_MS) return hit.value
      const value = near.ctx.reader.totalSupply(token).catch(() => null)
      supply.set(token, { at: now(), value })
      return value
    },
    /** USD value of what was paid; null unless every leg has a price. */
    async usdOf(legs: readonly Leg[]): Promise<number | null> {
      let total = 0
      for (const leg of legs) {
        const [price, m] = await Promise.all([assetUsd(leg.asset), meta(leg.asset)])
        if (price === null || !m) return null
        total += units(leg.amount, m.decimals) * price
      }
      return total
    },
    /**
     * NEAR value of what was paid, in yoctoNEAR: exact for NEAR, converted at
     * current prices for anything else (so only used for thresholds and the emoji
     * scale, never shown as an exact amount). Null when a leg has no price.
     */
    async valueInNear(legs: readonly Leg[]): Promise<bigint | null> {
      let total = 0n
      for (const leg of legs) {
        if (leg.asset === 'near') {
          total += leg.amount
          continue
        }
        const [price, nearPrice, m] = await Promise.all([assetUsd(leg.asset), nearUsd(), meta(leg.asset)])
        if (price === null || nearPrice === null || !m) return null
        const near = (units(leg.amount, m.decimals) * price) / nearPrice
        total += BigInt(Math.floor(near * 1e6)) * 10n ** 18n
      }
      return total
    },
  }
}

export type BuyMarket = ReturnType<typeof createBuyMarket>
