import { NATIVE_TOKEN_ID } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { fetchCoinMarkets, fetchContractChart } from '@/services/market/coingecko'
import { fetchDexPairs, mainPair, type DexPair } from '@/services/market/dexscreener'
import { fetchGtHistory, fetchGtPool, fetchGtToken, type GtPool, type GtToken } from '@/services/market/geckoterminal'
import { CANDLE_INTERVALS, INTERVAL_REFRESH_MS, SOURCE_INTERVALS, type CandleInterval } from '@/lib/chart/intervals'
import { CHART_RANGES, fetchNearUsdHistory } from '@/services/near/candles'
import type { Candle, ChartRange, MarketFigure, PriceHistory, PricePoint, TokenCandles, TokenMarket, TokenMarketPair } from '@/types/domain'
import type { NearContext } from './context'
import type { Market } from './market'

/**
 * A token's market data for its screen, from sources that really have it:
 * - a token's figures from DEX Screener's deepest indexed pair (price in USD and in wNEAR, 24h
 *   change, liquidity, 24h volume, FDV, trades), refreshed every 20 s;
 * - when DEX Screener lists no pair (on 2026-10-20 it listed none for $KITS), the same figures from
 *   GeckoTerminal's deepest pool of the token and its token figures (FDV, supply), each named
 *   GeckoTerminal; the pool's start date is not used (for Rhea's DCL pools it can predate the token);
 * - its market cap from GeckoTerminal, only when CoinGecko knows a circulating supply (DEX
 *   Screener's "marketCap" repeats the FDV when none is known, and FDV is never relabelled);
 * - NEAR itself from CoinGecko (market cap, FDV, volume, supplies), its price from Coinbase;
 * - history from GeckoTerminal's candles of that pair (Coinbase's for NEAR).
 * A figure no source reports is unavailable, with the reason; when a source stops answering,
 * the last figures it gave stay, marked stale. Nothing is estimated or filled in.
 */

/** How long a token's current figures are kept before they're read again. */
export const MARKET_TTL_MS = 20_000
/** How long a window's history is kept: a candle source's newest candle changes at most this often for it. */
const HISTORY_TTL_MS: Record<ChartRange, number> = { '1H': 60_000, '4H': 120_000, '1D': 300_000, '1W': 600_000, '1M': 600_000, ALL: 600_000 }
/** Which pool a token's history is read from, and that CoinGecko doesn't list it: kept this long. */
const SOURCE_TTL_MS = 30 * 60_000
const DAY_MS = 86_400_000

/** CoinGecko's `days` for a window: its own granularity is then 5 minutes (1 day), hourly (up to 90) or daily. */
const CG_DAYS: Record<ChartRange, number> = { '1H': 1, '4H': 1, '1D': 1, '1W': 7, '1M': 30, ALL: 365 }

type Gecko = { timeframe: 'minute' | 'hour' | 'day'; aggregate: number; limit: number }
const secondsOf = (g: Gecko) => (g.timeframe === 'minute' ? 60 : g.timeframe === 'hour' ? 3600 : 86_400) * g.aggregate

/**
 * ALL for a market of known age: the finest candles that cover it in one read of 1000 (GeckoTerminal
 * keeps 180 days); unknown age: days first, hours when days are too few to draw.
 */
function allCandles(ageMs: number | null): Gecko {
  if (ageMs === null) return { timeframe: 'day', aggregate: 1, limit: 1000 }
  if (ageMs <= 10 * DAY_MS) return { timeframe: 'minute', aggregate: 15, limit: 1000 }
  if (ageMs <= 41 * DAY_MS) return { timeframe: 'hour', aggregate: 1, limit: 1000 }
  if (ageMs <= 166 * DAY_MS) return { timeframe: 'hour', aggregate: 4, limit: 1000 }
  return { timeframe: 'day', aggregate: 1, limit: 1000 }
}
/**
 * One read per candle interval, from each source. Coinbase: its own granularity, 300 candles a read (it
 * has no 4-hour candles). GeckoTerminal: its own timeframe, as deep as Launch Radar's (6 hours of
 * minutes, 2 days of 5 minutes, a week of 15, a month of hours, 90 days of 4 hours, a year of days).
 * CoinGecko: the days whose resolution is the interval (5 minutes for one day, hourly, daily).
 */
const COINBASE_SEC: Partial<Record<CandleInterval, 60 | 300 | 900 | 3600 | 86400>> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86_400 }
const COINBASE_MAX = 300
const GECKO_READ: Record<CandleInterval, Gecko> = {
  '1m': { timeframe: 'minute', aggregate: 1, limit: 360 },
  '5m': { timeframe: 'minute', aggregate: 5, limit: 576 },
  '15m': { timeframe: 'minute', aggregate: 15, limit: 672 },
  '1h': { timeframe: 'hour', aggregate: 1, limit: 720 },
  '4h': { timeframe: 'hour', aggregate: 4, limit: 540 },
  '1d': { timeframe: 'day', aggregate: 1, limit: 365 },
}
const CG_DAYS_OF: Partial<Record<CandleInterval, number>> = { '5m': 1, '1h': 30, '1d': 365 }
/** A read of an interval is kept a little less than the chart's refresh, so each refresh reads anew. */
const CANDLES_TTL_MS = Object.fromEntries(CANDLE_INTERVALS.map((i) => [i, INTERVAL_REFRESH_MS[i] * 0.9])) as Record<CandleInterval, number>

/** Day candles fewer than this don't draw a market: ALL asks again by the hour. */
const FEW_DAYS = 14
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
  const histories = new Map<string, { at: number; value: Promise<PriceHistory | null> }>()
  const candleReads = new Map<string, { at: number; value: Promise<TokenCandles | null> }>()
  const cgUnlisted = new Map<string, number>()
  const cgApi = config ? `${new URL(config.coingeckoMarkets).origin}/api/v3` : null

  const gtToken = (token: string): Promise<GtToken | null> => {
    if (!config) return Promise.resolve(null)
    const hit = gtTokens.get(token)
    if (hit && ctx.now() - hit.at < GT_TOKEN_TTL_MS) return hit.value
    const value = fetchGtToken(ctx.fetch, config.geckoterminal, token)
    gtTokens.set(token, { at: ctx.now(), value })
    value.catch(() => gtTokens.delete(token))
    return value
  }

  const gtPools = new Map<string, { at: number; value: Promise<GtPool | null> }>()
  /** A pool's figures from GeckoTerminal, read once a minute at most (its rate limit). */
  const gtPool = (id: string): Promise<GtPool | null> => {
    if (!config) return Promise.resolve(null)
    const hit = gtPools.get(id)
    if (hit && ctx.now() - hit.at < GT_TOKEN_TTL_MS) return hit.value
    const value = fetchGtPool(ctx.fetch, config.geckoterminal, id)
    gtPools.set(id, { at: ctx.now(), value })
    value.catch(() => gtPools.delete(id))
    return value
  }

  /**
   * A token's figures from its GeckoTerminal pool, when DEX Screener lists no pair: the price (and in NEAR)
   * from the pool, its 24h change when the token is the pool's base (the pool's change is the base's),
   * the pool's liquidity, volume and trades, and the FDV, market cap and supply GeckoTerminal has for the
   * token. GeckoTerminal's pool start date is not used: for Rhea's DCL pools it can predate the token.
   */
  async function fromGtPool(tokenId: string, pool: GtPool, mine: 'base' | 'quote', gt: GtToken | null, near: { priceUsd: number } | null, now: number): Promise<TokenMarket> {
    const self = mine === 'base' ? pool.base : pool.quote
    const other = mine === 'base' ? pool.quote : pool.base
    const priceUsd = self.priceUsd
    const inWrap = other.id === ctx.network.wrapContract ? (mine === 'base' ? pool.baseInQuote : pool.quoteInBase) : null
    const priceNear = inWrap ?? (priceUsd !== null && near ? priceUsd / near.priceUsd : null)
    let fdv: MarketFigure = known(gt?.fdvUsd ?? null, GECKO, now, `${GECKO} reports no FDV for this token`)
    let total = gt?.totalSupply ?? null
    if (fdv.state !== 'known' && priceUsd !== null) {
      total ??= await supplyOnChain(tokenId)
      if (total !== null) fdv = { state: 'known', value: total * priceUsd, source: 'total supply on chain × price', at: now }
    }
    return {
      tokenId,
      priceUsd: known(priceUsd, GECKO, now, `${GECKO} reports no price for this token in its pool`),
      priceNear: known(priceNear, inWrap !== null ? GECKO : `${GECKO} ÷ ${COINBASE}`, now, 'no NEAR price to convert with'),
      change24hPct:
        mine === 'base'
          ? known(pool.change24hPct, GECKO, now, `${GECKO} reports no 24h change for this pool`)
          : unavailable(`${GECKO} reports the 24h change of the pool’s other token`),
      marketCapUsd:
        gt?.marketCapUsd !== null && gt?.marketCapUsd !== undefined
          ? { state: 'known', value: gt.marketCapUsd, source: `${GECKO} (CoinGecko’s circulating supply)`, at: now }
          : unavailable(`No source knows the circulating supply (${DEX_SCREENER} has no pair, ${GECKO} has none). FDV is shown instead.`),
      fdvUsd: fdv,
      liquidityUsd: known(pool.liquidityUsd, GECKO, now, `${GECKO} reports no liquidity for this pool`),
      volume24hUsd: known(pool.volume24hUsd, GECKO, now, `${GECKO} reports no 24h volume for this pool`),
      supply: { circulating: null, total, source: total === null ? null : gt?.totalSupply ? GECKO : 'chain' },
      pair: {
        id: pool.id,
        dex: dexName(pool.dexId ?? 'pool'),
        baseSymbol: self.symbol ?? tokenId,
        quoteSymbol: other.symbol ?? other.id,
        createdAt: null,
        url: `https://www.geckoterminal.com/near/pools/${pool.id}`,
        source: GECKO,
        txns24h: pool.txns24h,
      },
      updatedAt: now,
    }
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

  /** The pool a token's candles are read from: DEX Screener's pair, else GeckoTerminal's deepest DEX pool (never an intents pseudo-pool). */
  async function poolOf(tokenId: string): Promise<{ id: string; market: string | null; since: number | null } | null> {
    const m = await api.get(tokenId)
    if (m.pair) return { id: m.pair.id, market: `${m.pair.baseSymbol}/${m.pair.quoteSymbol} on ${m.pair.dex}`, since: m.pair.createdAt }
    const gt = await gtToken(tokenId).catch(() => null)
    const pool = gt?.topPools.find((p) => !p.startsWith('nep141:'))
    return pool ? { id: pool, market: null, since: null } : null
  }

  async function readHistory(tokenId: string, range: ChartRange): Promise<PriceHistory | null> {
    if (!config) return null
    const r = CHART_RANGES[range]
    const now = ctx.now()
    if (tokenId === NATIVE_TOKEN_ID) {
      if (!ctx.network.nearUsd) return null
      const { points, candles } = await fetchNearUsdHistory(ctx.fetch, ctx.network.nearUsd.coinbase, { windowMs: r.windowMs, granularity: r.coinbase }, now)
      return { points, candles, volumeUnit: 'NEAR', source: { name: COINBASE, market: 'NEAR/USD' }, candleSec: r.coinbase, since: null }
    }
    const pool = await poolOf(tokenId)
    if (pool) {
      let gecko: Gecko = range === 'ALL' ? allCandles(pool.since !== null ? now - pool.since : null) : r.gecko
      let all = await fetchGtHistory(ctx.fetch, config.geckoterminal, pool.id, gecko, 'usd', tokenId)
      if (range === 'ALL' && gecko.timeframe === 'day' && pool.since === null && all.candles.length < FEW_DAYS) {
        gecko = { timeframe: 'hour', aggregate: 1, limit: 1000 }
        all = await fetchGtHistory(ctx.fetch, config.geckoterminal, pool.id, gecko, 'usd', tokenId)
      }
      const candleMs = secondsOf(gecko) * 1000
      const inWindow = (t: number) => t >= now - r.windowMs - candleMs && t <= now
      const market = pool.market ?? (all.market.base && all.market.quote ? `${all.market.base}/${all.market.quote} on Rhea` : `pool ${pool.id}`)
      return {
        points: all.points.filter((p) => inWindow(p.t)),
        candles: all.candles.filter((c) => inWindow(c.t)),
        volumeUnit: 'USD',
        source: { name: GECKO, market },
        candleSec: secondsOf(gecko),
        since: pool.since,
      }
    }
    // No DEX pool indexed: CoinGecko's prices, when it lists the token.
    if (!cgApi || (cgUnlisted.get(tokenId) ?? 0) > now) return null
    const points = await fetchContractChart(ctx.fetch, cgApi, tokenId, CG_DAYS[range])
    if (points === null) {
      cgUnlisted.set(tokenId, now + SOURCE_TTL_MS)
      return null
    }
    const symbol = (await market.listTokens([tokenId]).catch(() => [])).find((t) => t.id === tokenId)?.symbol ?? tokenId
    const inWindow = (t: number) => t >= now - r.windowMs && t <= now
    return {
      points: points.filter((p) => inWindow(p.t)),
      candles: [],
      volumeUnit: null,
      source: { name: COINGECKO, market: `${symbol} on CoinGecko` },
      candleSec: CG_DAYS[range] <= 1 ? 300 : CG_DAYS[range] <= 90 ? 3600 : 86_400,
      since: null,
    }
  }

  /** Whether CoinGecko lists a token, once a read has said so. */
  const cgListed = new Set<string>()

  async function readCandles(tokenId: string, interval: CandleInterval): Promise<TokenCandles | null> {
    if (!config) return null
    const now = ctx.now()
    const none = { interval, candles: [] as Candle[], points: [] as PricePoint[] }
    if (tokenId === NATIVE_TOKEN_ID) {
      if (!ctx.network.nearUsd) return null
      const out: TokenCandles = { ...none, kind: 'candles', volumeUnit: 'NEAR', source: { name: COINBASE, market: 'NEAR/USD' }, supported: SOURCE_INTERVALS.Coinbase, since: null }
      const g = COINBASE_SEC[interval]
      if (!g) return out
      const { candles } = await fetchNearUsdHistory(ctx.fetch, ctx.network.nearUsd.coinbase, { windowMs: COINBASE_MAX * g * 1000, granularity: g }, now)
      return { ...out, candles }
    }
    const pool = await poolOf(tokenId)
    if (pool) {
      const all = await fetchGtHistory(ctx.fetch, config.geckoterminal, pool.id, GECKO_READ[interval], 'usd', tokenId)
      const market = pool.market ?? (all.market.base && all.market.quote ? `${all.market.base}/${all.market.quote} on Rhea` : `pool ${pool.id}`)
      return { ...none, kind: 'candles', candles: all.candles, volumeUnit: 'USD', source: { name: GECKO, market }, supported: SOURCE_INTERVALS.GeckoTerminal, since: pool.since }
    }
    // No DEX pool indexed: CoinGecko's prices (a line), when it lists the token.
    if (!cgApi || (cgUnlisted.get(tokenId) ?? 0) > now) return null
    const days = CG_DAYS_OF[interval]
    // An interval CoinGecko doesn't have reads nothing, once it is known to list the token; until then one day says whether it does.
    if (days === undefined && cgListed.has(tokenId)) return lineOf(tokenId, interval, [])
    const points = await fetchContractChart(ctx.fetch, cgApi, tokenId, days ?? 1)
    if (points === null) {
      cgUnlisted.set(tokenId, now + SOURCE_TTL_MS)
      return null
    }
    cgListed.add(tokenId)
    return lineOf(tokenId, interval, days === undefined ? [] : points)
  }

  async function lineOf(tokenId: string, interval: CandleInterval, points: PricePoint[]): Promise<TokenCandles> {
    const symbol = (await market.listTokens([tokenId]).catch(() => [])).find((t) => t.id === tokenId)?.symbol ?? tokenId
    return {
      interval,
      kind: 'line',
      candles: [],
      points,
      volumeUnit: null,
      source: { name: COINGECKO, market: `${symbol} on CoinGecko` },
      supported: SOURCE_INTERVALS.CoinGecko,
      since: null,
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
      // DEX Screener lists no pair: GeckoTerminal's deepest pool of the token, as its candles are read (never an intents pseudo-pool).
      let gt: GtToken | null = null
      let pool: GtPool | null = null
      let gtError: string | null = null
      try {
        gt = await gtToken(tokenId)
        const poolId = gt?.topPools.find((p) => !p.startsWith('nep141:')) ?? null
        if (poolId) pool = await gtPool(poolId)
      } catch (e) {
        gtError = describe(e)
      }
      const mine = pool ? (pool.base.id === tokenId ? 'base' : pool.quote.id === tokenId ? 'quote' : null) : null
      if (pool && mine) return fromGtPool(tokenId, pool, mine, gt, near, now)
      const why = gtError ? `${noPair}, and ${GECKO} isn’t answering (${gtError})` : `${noPair}, and ${GECKO} has no pool for it`
      // A source that answered before and fails now: its last figures stay, marked stale (afterFailure), rather than vanishing.
      if (gtError && lastGood.has(tokenId)) throw new Error(why)
      return {
        tokenId,
        priceUsd: rhea ? { state: 'known', value: rhea.priceUsd, source: RHEA_LIST, at: rhea.updatedAt } : unavailable(why),
        priceNear: rhea && rhea.priceNear > 0 ? { state: 'known', value: rhea.priceNear, source: RHEA_LIST, at: rhea.updatedAt } : unavailable(why),
        change24hPct: unavailable(why),
        marketCapUsd: known(gt?.marketCapUsd ?? null, `${GECKO} (CoinGecko’s circulating supply)`, now, why),
        fdvUsd: known(gt?.fdvUsd ?? null, GECKO, now, why),
        liquidityUsd: unavailable(why),
        volume24hUsd: unavailable(why),
        supply: { circulating: null, total: gt?.totalSupply ?? null, source: gt?.totalSupply ? GECKO : null },
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
      source: DEX_SCREENER,
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
     * Real prices over the window, from the earliest a source keeps, never from when this page
     * opened: Coinbase's NEAR/USD candles for NEAR; otherwise GeckoTerminal's candles of the token's
     * market (DEX Screener's deepest pair, or GeckoTerminal's own deepest pool when DEX Screener has
     * none), priced as this token whichever side of the pool it is on; else CoinGecko's prices (a
     * line, no candles) for a token it lists. Null when no source has history: the screen says so.
     * Kept for a while (HISTORY_TTL_MS: the sources' rate limits); a read that fails throws.
     */
    history(tokenId: string, range: ChartRange): Promise<PriceHistory | null> {
      if (!config) return Promise.resolve(null)
      const key = `${tokenId}|${range}`
      const hit = histories.get(key)
      if (hit && ctx.now() - hit.at < HISTORY_TTL_MS[range]) return hit.value
      const value = readHistory(tokenId, range)
      histories.set(key, { at: ctx.now(), value })
      value.catch(() => histories.delete(key))
      return value
    },

    /**
     * A token's candles at `interval`, as much history as one read of its source holds (the same depth
     * as Launch Radar's): Coinbase's NEAR/USD candles for NEAR (no 4-hour: Coinbase has none), the
     * GeckoTerminal candles of its market, else CoinGecko's prices as a line. Null when no source has
     * its history. Kept until its interval's newest candle can have changed; a read that fails throws.
     */
    candles(tokenId: string, interval: CandleInterval): Promise<TokenCandles | null> {
      if (!config) return Promise.resolve(null)
      const key = `${tokenId}|${interval}`
      const hit = candleReads.get(key)
      if (hit && ctx.now() - hit.at < CANDLES_TTL_MS[interval]) return hit.value
      const value = readCandles(tokenId, interval)
      candleReads.set(key, { at: ctx.now(), value })
      value.catch(() => candleReads.delete(key))
      return value
    },
  }
  return api
}

export type TokenMarketService = ReturnType<typeof createTokenMarket>
