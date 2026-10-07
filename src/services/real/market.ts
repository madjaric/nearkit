import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { mapLimit } from '@/lib/async'
import { fetchNearUsd, fetchTokenPrices, type NearUsd } from '@/services/near/prices'
import type { MarketQuote, TokenListing } from '@/types/domain'
import type { NearContext } from './context'

/**
 * Token list and prices for real mode. Metadata always comes from the chain
 * (`ft_metadata`); a contract that fails validation is left out, never guessed.
 * Prices are for display only and never feed a transaction.
 */

const PRICE_TTL_MS = 60_000
const NEAR_TTL_MS = 30_000

export const NATIVE_LISTING: Omit<TokenListing, 'market'> = {
  id: NATIVE_TOKEN_ID,
  symbol: 'NEAR',
  name: 'NEAR',
  decimals: NEAR_DECIMALS,
  contract: null,
  isNative: true,
  status: 'listed',
  source: 'native',
}

export function createMarket(ctx: NearContext) {
  let prices: { at: number; value: Promise<Map<string, number>> } | null = null
  let nearUsd: { at: number; value: Promise<NearUsd | null> } | null = null

  const tokenPrices = () => {
    const indexer = ctx.network.rhea.indexerUrl
    if (!indexer) return Promise.resolve(new Map<string, number>())
    if (!prices || ctx.now() - prices.at > PRICE_TTL_MS) {
      const value = fetchTokenPrices(ctx.fetch, indexer).catch(() => new Map<string, number>())
      prices = { at: ctx.now(), value }
    }
    return prices.value
  }

  const nearPrice = () => {
    if (!nearUsd || ctx.now() - nearUsd.at > NEAR_TTL_MS) nearUsd = { at: ctx.now(), value: fetchNearUsd(ctx.fetch, ctx.network.nearUsd).catch(() => null) }
    return nearUsd.value
  }

  async function nearQuote(): Promise<MarketQuote | null> {
    const near = await nearPrice()
    const fallback = near ? null : (await tokenPrices()).get(ctx.network.wrapContract)
    const priceUsd = near?.priceUsd ?? fallback
    if (!priceUsd) return null
    return { tokenId: NATIVE_TOKEN_ID, priceUsd, priceNear: 1, change24hPct: near?.change24hPct ?? null, liquidityUsd: null, volume24hUsd: null, updatedAt: near?.at ?? ctx.now() }
  }

  async function quoteFor(tokenId: string): Promise<MarketQuote | null> {
    if (tokenId === NATIVE_TOKEN_ID) return nearQuote()
    const [map, near] = await Promise.all([tokenPrices(), nearQuote()])
    const priceUsd = map.get(tokenId)
    if (!priceUsd) return null
    // When the price list was fetched: reading it again from the cache is not a newer price.
    return { tokenId, priceUsd, priceNear: near ? priceUsd / near.priceUsd : 0, change24hPct: null, liquidityUsd: null, volume24hUsd: null, updatedAt: prices?.at ?? ctx.now() }
  }

  /** Native NEAR, tracked tokens, $KITS and whatever the connected accounts hold. */
  async function listTokens(extra: string[] = []): Promise<TokenListing[]> {
    const ids = [...new Set([...ctx.trackedTokens(), ...extra])]
    const [native, listed] = await Promise.all([
      quoteFor(NATIVE_TOKEN_ID),
      mapLimit(ids, 4, async (contract): Promise<TokenListing | null> => {
        try {
          const meta = await ctx.reader.metadata(contract)
          const known = ctx.network.knownTokens.includes(contract)
          const source = known ? 'known' : ctx.stores.tokens.list().includes(contract) ? 'imported' : contract === ctx.env.kitContract ? 'known' : 'discovered'
          return {
            id: contract,
            symbol: meta.symbol,
            name: meta.name,
            decimals: meta.decimals,
            contract,
            status: 'listed',
            icon: meta.icon,
            source,
            market: await quoteFor(contract),
          }
        } catch {
          return null
        }
      }),
    ])
    return [{ ...NATIVE_LISTING, market: native }, ...listed.filter((t): t is TokenListing => t !== null)]
  }

  return { listTokens, quoteFor, nearQuote, tokenPrices }
}

export type Market = ReturnType<typeof createMarket>
