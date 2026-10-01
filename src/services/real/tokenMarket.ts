import { NATIVE_TOKEN_ID } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { fetchCoinMarkets } from '@/services/market/coingecko'
import { fetchDexPairs, mainPair, type DexPair } from '@/services/market/dexscreener'
import { fetchGtOhlcv, fetchGtToken, type GtToken } from '@/services/market/geckoterminal'
import { CHART_RANGES, fetchNearUsdCloses } from '@/services/near/candles'
import type { ChartRange, MarketFigure, PriceHistory, TokenMarket, TokenMarketPair } from '@/types/domain'
import type { NearContext } from './context'
import type { Market } from './market'

/**
 * A token's market data for its screen, from sources that really have it:
 * - a token's figures from DEX Screener's deepest indexed pair (price in USD and in wNEAR, 24h
 *   change, liquidity, 24h volume, FDV, trades), refreshed every 20 s;
 * - its market cap from GeckoTerminal, only when CoinGecko knows a circulating supply (DEX
 *   Screener's "marketCap" repeats the FDV when none is known, and FDV is never relabelled);
 * - NEAR itself from CoinGecko (market cap, FDV, volume, supplies), its price from Coinbase;
 * - history from GeckoTerminal's candles of that pair (Coinbase's for NEAR).
 * A figure no source reports is unavailable, with the reason; when a source stops answering,
 * the last figures it gave stay, marked stale. Nothing is estimated or filled in.
 */

/** How long a token's current figures are kept before they're read again. */
export const MARKET_TTL_MS = 20_000
/** GeckoTerminal allows ~30 requests a minute per address: its token figures are read once a minute at most. */
const GT_TOKEN_TTL_MS = 60_000

const DEX_SCREENER = 'DEX Screener'
const GECKO = 'GeckoTerminal'
const COINGECKO = 'CoinGecko'
const COINBASE = 'Coinbase'
const RHEA_LIST = 'Rhea’s price list'

const known = (value: number | null, source: string, at: number, reason: string): MarketFigure =>
  value !== null && Number.isFinite(value) ? { state: 'known', value, source, at } : { state: 'unavailable', reason }
const unavailable = (reason: string): MarketFigure => ({ state: 'unavailable', reason })
const notApplicable = (reason: string): MarketFigure => ({ state: 'not-applicable', reason })
const stale = (f: MarketFigure, reason: string): MarketFigure =>
  f.state === 'known' || f.state === 'stale' ? { state: 'stale', value: f.value, source: f.source, at: f.at, reason } : f

const dexName = (dex: string) => (dex === 'rhea-finance' ? 'Rhea' : dex)

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createTokenMarket(ctx: NearContext, market: Market) {
  const config = ctx.network.market
  const snapshots = new Map<string, { at: number; value: Promise<TokenMarket> }>()
  const lastGood = new Map<string, TokenMarket>()
  const gtTokens = new Map<string, { at: number; value: Promise<GtToken | null> }>()

  const gtToken = (token: string): Promise<GtToken | null> => {
    if (!config) return Promise.resolve(null)
    const hit = gtTokens.get(token)
    if (hit && ctx.now() - hit.at < GT_TOKEN_TTL_MS) return hit.value
    const value = fetchGtToken(ctx.fetch, config.geckoterminal, token)
    gtTokens.set(token, { at: ctx.now(), value })
    value.catch(() => gtTokens.delete(token))
    return value
  }

  /** Total supply in whole tokens, from chain; null when it can't be read. */
  const supplyOnChain = async (token: string): Promise<number | null> => {
    try {
      const [supply, meta] = await Promise.all([ctx.reader.totalSupply(token), ctx.reader.metadata(token)])
      const units = Number(formatUnits(supply, meta.decimals))
      return Number.isFinite(units) ? units : null
    } catch {
      return null
    }
  }

  async function nearMarket(): Promise<TokenMarket> {
    const now = ctx.now()
    const quote = await market.nearQuote()
    let cg: Awaited<ReturnType<typeof fetchCoinMarkets>> = null
    let cgError: string | null = null
    try {
      cg = config ? await fetchCoinMarkets(ctx.fetch, config.coingeckoMarkets) : null
    } catch (e) {
      cgError = describe(e)
    }
    const cgAt = cg?.updatedAt ?? now
    const noCg = cgError ? `${COINGECKO} isn’t answering (${cgError})` : `${COINGECKO} reports nothing for NEAR right now`
    const price: MarketFigure = quote ? { state: 'known', value: quote.priceUsd, source: COINBASE, at: quote.updatedAt } : known(cg?.priceUsd ?? null, COINGECKO, cgAt, noCg)
    return {
      tokenId: NATIVE_TOKEN_ID,
      priceUsd: price,
      priceNear: { state: 'known', value: 1, source: 'NEAR is the base currency', at: now },
      change24hPct:
        quote?.change24hPct !== null && quote?.change24hPct !== undefined
          ? { state: 'known', value: quote.change24hPct, source: COINBASE, at: quote.updatedAt }
          : known(cg?.change24hPct ?? null, COINGECKO, cgAt, noCg),
      marketCapUsd: known(cg?.marketCapUsd ?? null, COINGECKO, cgAt, noCg),
      fdvUsd: known(cg?.fdvUsd ?? null, COINGECKO, cgAt, noCg),
      liquidityUsd: notApplicable('NEAR is the base currency: liquidity is a figure of a token’s pair against it.'),
      volume24hUsd: known(cg?.volume24hUsd ?? null, COINGECKO, cgAt, noCg),
      supply: { circulating: cg?.circulatingSupply ?? null, total: cg?.totalSupply ?? null, source: cg ? COINGECKO : null },
      pair: null,
      updatedAt: now,
    }
  }

  async function tokenMarket(tokenId: string): Promise<TokenMarket> {
    if (!config) throw new Error('no market sources on this network')
    const now = ctx.now()
    const pairs = await fetchDexPairs(ctx.fetch, config.dexscreener, 'near', tokenId)
    const pair = mainPair(pairs, tokenId)
    const [rhea, near] = await Promise.all([market.quoteFor(tokenId), market.nearQuote()])
    const noPair = `${DEX_SCREENER} has no pair for this token`
    if (!pair) {
      return {
        tokenId,
        priceUsd: rhea ? { state: 'known', value: rhea.priceUsd, source: RHEA_LIST, at: rhea.updatedAt } : unavailable(`${noPair}, and no price source NearKit uses reports it`),
        priceNear: rhea && rhea.priceNear > 0 ? { state: 'known', value: rhea.priceNear, source: RHEA_LIST, at: rhea.updatedAt } : unavailable(noPair),
        change24hPct: unavailable(noPair),
        marketCapUsd: unavailable(noPair),
        fdvUsd: unavailable(noPair),
        liquidityUsd: unavailable(noPair),
        volume24hUsd: unavailable(noPair),
        supply: { circulating: null, total: null, source: null },
        pair: null,
        updatedAt: now,
      }
    }
    // The pair's price and valuation figures describe its base token; when ours is the quote, only the pair-level ones apply.
    const oriented = pair.base.address === tokenId
    const base = (p: DexPair) => (oriented ? p : null)
    const priceUsd = base(pair)?.priceUsd ?? null
    const priceNear = oriented && pair.quote.address === ctx.network.wrapContract ? pair.priceNative : priceUsd !== null && near ? priceUsd / near.priceUsd : null
    const circulatingKnownToDex = pair.marketCapUsd !== null && pair.fdvUsd !== null && pair.marketCapUsd !== pair.fdvUsd
    // GeckoTerminal is asked for a market cap only when DEX Screener doesn't know a circulating supply (it then repeats the FDV).
    let gt: GtToken | null = null
    let gtError: string | null = null
    if (oriented && !circulatingKnownToDex) {
      try {
        gt = await gtToken(tokenId)
      } catch (e) {
        gtError = describe(e)
      }
    }
    let fdv: MarketFigure = known(base(pair)?.fdvUsd ?? null, DEX_SCREENER, now, 'no FDV reported')
    if (fdv.state !== 'known' && gt?.fdvUsd) fdv = { state: 'known', value: gt.fdvUsd, source: GECKO, at: now }
    let total = gt?.totalSupply ?? null
    if (fdv.state !== 'known' && priceUsd !== null) {
      total ??= await supplyOnChain(tokenId)
      if (total !== null) fdv = { state: 'known', value: total * priceUsd, source: 'total supply on chain × price', at: now }
    }
    const marketCap: MarketFigure =
      gt?.marketCapUsd !== null && gt?.marketCapUsd !== undefined
        ? { state: 'known', value: gt.marketCapUsd, source: `${GECKO} (CoinGecko’s circulating supply)`, at: now }
        : circulatingKnownToDex
          ? { state: 'known', value: pair.marketCapUsd as number, source: DEX_SCREENER, at: now }
          : unavailable(
              gtError
                ? `No source knows the circulating supply: ${DEX_SCREENER} repeats the FDV, and ${GECKO} isn’t answering (${gtError}). FDV is shown instead.`
                : `No source knows the circulating supply (${DEX_SCREENER} repeats the FDV, ${GECKO} has none). FDV is shown instead.`,
            )
    const marketPair: TokenMarketPair = {
      id: pair.id,
      dex: dexName(pair.dex),
      baseSymbol: pair.base.symbol,
      quoteSymbol: pair.quote.symbol,
      createdAt: pair.createdAt,
      url: pair.url,
      txns24h: pair.txns24h,
    }
    return {
      tokenId,
      priceUsd: known(priceUsd, DEX_SCREENER, now, `${DEX_SCREENER} prices this pair the other way round`),
      priceNear: known(
        priceNear,
        oriented && pair.quote.address === ctx.network.wrapContract ? DEX_SCREENER : `${DEX_SCREENER} ÷ ${COINBASE}`,
        now,
        'no NEAR price to convert with',
      ),
      change24hPct: known(base(pair)?.change24hPct ?? null, DEX_SCREENER, now, `${DEX_SCREENER} reports no 24h change for this pair yet`),
      marketCapUsd: marketCap,
      fdvUsd: fdv,
      liquidityUsd: known(pair.liquidityUsd, DEX_SCREENER, now, `${DEX_SCREENER} reports no liquidity for this pair`),
      volume24hUsd: known(pair.volume24hUsd, DEX_SCREENER, now, `${DEX_SCREENER} reports no 24h volume for this pair`),
      supply: { circulating: null, total, source: total === null ? null : gt?.totalSupply ? GECKO : 'chain' },
      pair: marketPair,
      updatedAt: now,
    }
  }

  const notApplicableAll = (tokenId: string): TokenMarket => {
    const why = `${ctx.network.label} has no market prices.`
    const f = notApplicable(why)
    return {
      tokenId,
      priceUsd: f,
      priceNear: f,
      change24hPct: f,
      marketCapUsd: f,
      fdvUsd: f,
      liquidityUsd: f,
      volume24hUsd: f,
      supply: { circulating: null, total: null, source: null },
      pair: null,
      updatedAt: ctx.now(),
    }
  }

  /** The last figures a source gave, marked stale with why they weren't refreshed; null when it never answered. */
  const staleOf = (tokenId: string, reason: string): TokenMarket | null => {
    const last = lastGood.get(tokenId)
    if (!last) return null
    return {
      ...last,
      priceUsd: stale(last.priceUsd, reason),
      priceNear: stale(last.priceNear, reason),
      change24hPct: stale(last.change24hPct, reason),
      marketCapUsd: stale(last.marketCapUsd, reason),
      fdvUsd: stale(last.fdvUsd, reason),
      liquidityUsd: stale(last.liquidityUsd, reason),
      volume24hUsd: stale(last.volume24hUsd, reason),
    }
  }

  /** A read that failed: the last figures, stale; or, never answered, the price NearKit's own list has and the rest missing, with why. */
  async function afterFailure(tokenId: string, e: unknown): Promise<TokenMarket> {
    const why = describe(e)
    const kept = staleOf(tokenId, `not refreshed: ${why}`)
    if (kept) return kept
    const native = tokenId === NATIVE_TOKEN_ID
    const rhea = native ? await market.nearQuote() : await market.quoteFor(tokenId)
    const f = unavailable(why)
    const listed = (value: number | null, source: string): MarketFigure => (rhea && value !== null ? { state: 'known', value, source, at: rhea.updatedAt } : f)
    return {
      tokenId,
      priceUsd: listed(rhea?.priceUsd ?? null, native ? COINBASE : RHEA_LIST),
      priceNear: listed(rhea?.priceNear ?? null, native ? 'NEAR is the base currency' : RHEA_LIST),
      change24hPct: listed(rhea?.change24hPct ?? null, COINBASE),
      marketCapUsd: f,
      fdvUsd: f,
      liquidityUsd: f,
      volume24hUsd: f,
      supply: { circulating: null, total: null, source: null },
      pair: null,
      updatedAt: ctx.now(),
    }
  }

  const api = {
    /** A token's current figures, each with its source or why it's missing; read again after MARKET_TTL_MS. */
    get(tokenId: string): Promise<TokenMarket> {
      if (!config) return Promise.resolve(notApplicableAll(tokenId))
      const hit = snapshots.get(tokenId)
      if (hit && ctx.now() - hit.at < MARKET_TTL_MS) return hit.value
      const value = (tokenId === NATIVE_TOKEN_ID ? nearMarket() : tokenMarket(tokenId)).then(
        (m) => {
          lastGood.set(tokenId, m)
          return m
        },
        (e: unknown) => afterFailure(tokenId, e),
      )
      snapshots.set(tokenId, { at: ctx.now(), value })
      return value
    },

    /**
     * Real prices over the window: Coinbase's NEAR/USD closes for NEAR, GeckoTerminal's candles of
     * the token's main pair otherwise. Null when no source has this token's history; a read that
     * fails throws, so the screen can say so instead of drawing an empty line.
     */
    async history(tokenId: string, range: ChartRange): Promise<PriceHistory | null> {
      if (!config) return null
      const r = CHART_RANGES[range]
      if (tokenId === NATIVE_TOKEN_ID) {
        if (!ctx.network.nearUsd) return null
        const points = await fetchNearUsdCloses(ctx.fetch, ctx.network.nearUsd.coinbase, { windowMs: r.windowMs, granularity: r.coinbase }, ctx.now())
        return { points, source: { name: COINBASE, market: 'NEAR/USD' }, candleSec: r.coinbase, since: null }
      }
      const m = await api.get(tokenId)
      if (!m.pair) return null
      const unit = r.gecko.timeframe === 'minute' ? 60 : r.gecko.timeframe === 'hour' ? 3600 : 86400
      const now = ctx.now()
      const all = await fetchGtOhlcv(ctx.fetch, config.geckoterminal, m.pair.id, r.gecko)
      const points = all.filter((p) => p.t >= now - r.windowMs - unit * r.gecko.aggregate * 1000 && p.t <= now)
      return {
        points,
        source: { name: GECKO, market: `${m.pair.baseSymbol}/${m.pair.quoteSymbol} on ${m.pair.dex}` },
        candleSec: unit * r.gecko.aggregate,
        since: m.pair.createdAt,
      }
    },
  }
  return api
}

export type TokenMarketService = ReturnType<typeof createTokenMarket>
