import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS, type NetworkId } from '@/config/networks'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import legacyBuy from '@/services/near/fixtures/flows/legacy-log-buy-blackdragon.fastnear.json'
import legacySell from '@/services/near/fixtures/flows/legacy-log-sell-blackdragon.fastnear.json'
import cgNear from '@/services/market/fixtures/coingecko-markets-near.json'
import dexSingularty from '@/services/market/fixtures/dexscreener-token-pairs-singularty.json'
import dexNearlyNstai from '@/services/market/fixtures/dexscreener-tokens-nearly-nstai.json'
import gtOhlcv from '@/services/market/fixtures/geckoterminal-ohlcv-singularty-hour.json'
import { parseGtCandles } from '@/services/market/geckoterminal'
import gtKitsPool from '@/services/market/fixtures/geckoterminal-pool-kits.json'
import gtKits from '@/services/market/fixtures/geckoterminal-token-kits.json'
import gtNearly from '@/services/market/fixtures/geckoterminal-token-nearly.json'
import gtSingularty from '@/services/market/fixtures/geckoterminal-token-singularty.json'
import { createNearServices } from './index'
import { memoryStorage } from './stores'
import { createFakeChain } from './testing/fakeChain'

/**
 * The token screen's data on the real services, with mainnet's sources faked: the live price
 * (Rhea's price list, NEAR from Coinbase: the sources the app already uses), the total supply
 * (on chain), and the price history that really exists (Coinbase candles for NEAR, none for
 * other tokens). What a source doesn't give is null: never zero, never estimated.
 */

const SING = 'singularty.nearlytrade.near'
const UNPRICED = 'unpriced.nearlytrade.near'
const NSTAI = 'nstai.nearlytrade.near'
const NEARLY = 'nearly-993927.nearlytrade.near'
const SING_POOL = 'refv2-singularty.nearlytrade.near:wrap.near:10000'
/** 2026-10-01 08:30 UTC: after the saved SINGULARTY candles (03:00 to 08:00 that morning). */
const T1 = 1_790_841_600_000 + 30 * 60_000
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0)
/** mort1705.tg bought SINGULARTY for 1 NEAR on mainnet (2026-09-29): the real transaction. */
const BUY = directBuy as unknown as { transaction: { hash: string }; block_height: number; block_timestamp: string }
/**
 * BLACKDRAGON's contract predates NEP-141 events: it logs each transfer as a text line. The real
 * transactions: blackdragonmeme.near sold on Rhea for NEAR, then bought for wNEAR (2026-10-01).
 */
const BLACKDRAGON = 'blackdragon.tkn.near'
const BD_SELL = legacySell as unknown as typeof BUY
const BD_BUY = legacyBuy as unknown as typeof BUY
const atOf = (t: typeof BUY) => Number(BigInt(t.block_timestamp) / 1_000_000n)

interface SetupOptions {
  network?: NetworkId
  now?: number
  singPrice?: () => number
  candles?: (url: URL) => unknown
  index?: { txs: unknown[]; fail?: boolean }
  /** DEX Screener's pairs for a token (default: none indexed). */
  dex?: (token: string) => unknown
  /** GeckoTerminal's token answer (default: not indexed, a 404). */
  gt?: (token: string) => unknown
  /** GeckoTerminal's candles (default: none). */
  ohlcv?: (url: URL) => unknown
  /** GeckoTerminal's answer about one pool (default: not indexed, a 404). */
  pool?: (url: URL) => unknown
  coingecko?: () => unknown
  /** CoinGecko's market chart of a token by its contract (default: not listed, a 404). */
  cgChart?: (token: string, url: URL) => unknown
}

function setup(opts: SetupOptions = {}) {
  let now = opts.now ?? T0
  const chain = createFakeChain({
    accounts: { [SING]: { amount: 10n ** 24n, global: 'G' }, [UNPRICED]: { amount: 10n ** 24n, global: 'G' }, [NSTAI]: { amount: 10n ** 24n, global: 'G' } },
    tokens: {
      [SING]: { symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18, boundsMin: 1n, totalSupply: 10n ** 27n, balances: {} },
      [UNPRICED]: { symbol: 'NOPRICE', name: 'No Price', decimals: 6, boundsMin: 1n, balances: {} },
      [NSTAI]: { symbol: 'NSTAI', name: 'Nearly Stocks AI', decimals: 18, boundsMin: 1n, totalSupply: 10n ** 27n, balances: {} },
    },
  })
  const calls: string[] = []
  chain.route('https://api.rhea.finance/list-token-price', () => ({ [SING]: { price: String(opts.singPrice?.() ?? 0.00567) } }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/ticker', () => ({ price: '5.00' }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/stats', () => ({ open: '4.80', last: '5.00' }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/candles', (url) => {
    calls.push(url.search)
    return opts.candles ? opts.candles(url) : []
  })
  const lastSegment = (url: URL) => decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
  const reads = {
    account: [] as string[],
    transactions: 0,
    dex: [] as string[],
    gt: [] as string[],
    ohlcv: [] as string[],
    pool: [] as string[],
    coingecko: 0,
    cgChart: [] as string[],
  }
  chain.route('https://api.coingecko.com/api/v3/coins/near-protocol/contract/', (url) => {
    const token = decodeURIComponent(url.pathname.split('/')[6] ?? '')
    reads.cgChart.push(url.pathname.slice(url.pathname.indexOf('/contract/')) + url.search)
    return opts.cgChart ? opts.cgChart(token, url) : new Response('{"error":"coin not found"}', { status: 404 })
  })
  chain.route('https://api.dexscreener.com/token-pairs/v1/near/', (url) => {
    reads.dex.push(lastSegment(url))
    return opts.dex ? opts.dex(lastSegment(url)) : []
  })
  chain.route('https://api.geckoterminal.com/api/v2/networks/near/tokens/', (url) => {
    reads.gt.push(lastSegment(url))
    return opts.gt ? opts.gt(lastSegment(url)) : new Response('{"errors":[{"status":"404"}]}', { status: 404 })
  })
  chain.route('https://api.geckoterminal.com/api/v2/networks/near/pools/', (url) => {
    if (!url.pathname.includes('/ohlcv/')) {
      reads.pool.push(url.pathname.replace('/api/v2/networks/near', '') + url.search)
      return opts.pool ? opts.pool(url) : new Response('{"errors":[{"status":"404"}]}', { status: 404 })
    }
    reads.ohlcv.push(url.pathname.replace('/api/v2/networks/near', '') + url.search)
    return opts.ohlcv ? opts.ohlcv(url) : { data: { attributes: { ohlcv_list: [] } } }
  })
  chain.route('https://api.coingecko.com/api/v3/coins/markets', () => {
    reads.coingecko += 1
    return opts.coingecko ? opts.coingecko() : cgNear
  })
  const index = opts.index ?? { txs: [] }
  chain.route('https://tx.main.fastnear.com/v0/account', (_url, body) => {
    if (index.fail) throw new Error('index down')
    reads.account.push(String((body as { account_id?: string }).account_id))
    return {
      account_txs: index.txs.map((t) => {
        const x = t as typeof BUY
        return { transaction_hash: x.transaction.hash, tx_block_height: x.block_height, tx_block_timestamp: x.block_timestamp }
      }),
    }
  })
  chain.route('https://tx.main.fastnear.com/v0/transactions', () => {
    reads.transactions++
    return { transactions: index.txs }
  })
  const network = opts.network ?? 'mainnet'
  const { env } = parseEnv({ VITE_NEAR_NETWORK: network, ...(network === 'mainnet' ? { VITE_NEARKIT_FEE_RECIPIENT: 'fees.example.near' } : {}) })
  const services = createNearServices({ env, network: NETWORKS[network], fetch: chain.fetch, kv: memoryStorage(), now: () => now })
  return { services, calls, reads, advance: (ms: number) => void (now += ms) }
}

describe('the live price', () => {
  it('loads a token’s price from the price list the app already uses', async () => {
    const { services } = setup()
    const q = await services.tokens.getPrice(SING)
    expect(q).toMatchObject({ tokenId: SING, priceUsd: 0.00567, change24hPct: null })
    // Rhea's list reports no 24h change or volume: none is shown.
    expect(q?.volume24hUsd).toBeNull()
  })

  it('updates when the source moves (after its short cache), without a reload', async () => {
    let price = 0.00567
    const { services, advance } = setup({ singPrice: () => price })
    expect((await services.tokens.getPrice(SING))?.priceUsd).toBe(0.00567)
    price = 0.0061
    advance(61_000)
    expect((await services.tokens.getPrice(SING))?.priceUsd).toBe(0.0061)
  })

  it('carries the time its source reported it: reading it again from the cache is not a new price', async () => {
    const { services, advance } = setup()
    const first = await services.tokens.getPrice(SING)
    expect(first?.updatedAt).toBe(T0)
    advance(20_000)
    expect((await services.tokens.getPrice(SING))?.updatedAt).toBe(T0)
    advance(45_000)
    expect((await services.tokens.getPrice(SING))?.updatedAt).toBe(T0 + 65_000)
  })

  it('NEAR’s price and 24h change come from Coinbase', async () => {
    const { services } = setup()
    const q = await services.tokens.getPrice('near')
    expect(q?.priceUsd).toBe(5)
    expect(q?.change24hPct).toBeCloseTo(4.1667, 3)
  })

  it('a token with no price has none: null, never zero or a guess', async () => {
    const { services } = setup()
    expect(await services.tokens.getPrice(UNPRICED)).toBeNull()
  })

  it('testnet has no market prices at all', async () => {
    const { services } = setup({ network: 'testnet' })
    expect(await services.tokens.getPrice('near')).toBeNull()
  })
})

describe('price history for the chart', () => {
  it('NEAR: Coinbase’s closes over the chosen window, oldest first, named as NEAR/USD history', async () => {
    const start = T0 / 1000 - 3600
    const { services, calls } = setup({
      // Coinbase answers newest first: [time, low, high, open, close, volume].
      candles: () => [
        [start + 120, 4.9, 5.1, 5.0, 5.05, 1],
        [start + 60, 4.8, 5.0, 4.9, 4.95, 1],
        [start, 4.7, 4.9, 4.8, 4.85, 1],
      ],
    })
    expect(await services.tokens.getPriceHistory('near', '1H')).toEqual({
      points: [
        { t: start * 1000, usd: 4.85 },
        { t: (start + 60) * 1000, usd: 4.95 },
        { t: (start + 120) * 1000, usd: 5.05 },
      ],
      // The same rows as candles: Coinbase sends [time, low, high, open, close, volume], volume in NEAR.
      candles: [
        { t: start * 1000, o: 4.8, h: 4.9, l: 4.7, c: 4.85, v: 1 },
        { t: (start + 60) * 1000, o: 4.9, h: 5.0, l: 4.8, c: 4.95, v: 1 },
        { t: (start + 120) * 1000, o: 5.0, h: 5.1, l: 4.9, c: 5.05, v: 1 },
      ],
      volumeUnit: 'NEAR',
      source: { name: 'Coinbase', market: 'NEAR/USD' },
      candleSec: 60,
      since: null,
    })
    // One-minute candles for the last hour.
    expect(calls[0]).toContain('granularity=60')
    expect(calls[0]).toContain(`start=${new Date(T0 - 3_600_000).toISOString()}`)
  })

  it('the longer windows use coarser candles: 4H by five minutes, 1D by fifteen, 1W by the hour, 1M by six hours', async () => {
    const { services, calls } = setup({ candles: () => [] })
    for (const range of ['4H', '1D', '1W', '1M'] as const) await services.tokens.getPriceHistory('near', range)
    expect(calls.map((c) => new URLSearchParams(c).get('granularity'))).toEqual(['300', '900', '3600', '21600'])
  })

  it('drops malformed candles instead of repairing them', async () => {
    const { services } = setup({
      candles: () => [
        [T0 / 1000, 1, 2, 1, 0, 1],
        ['x', 1, 2, 1, 5, 1],
        [T0 / 1000 - 60, 1, 2, 1, 4.9, 1],
      ],
    })
    const h = await services.tokens.getPriceHistory('near', '1H')
    expect(h?.points).toEqual([{ t: T0 - 60_000, usd: 4.9 }])
    // As a candle that one doesn't add up either (its close is above its high): no candle at all.
    expect(h?.candles).toEqual([])
  })

  it('a DEX token: the candle closes of its main pair from GeckoTerminal, oldest first, named by its market, since the pair began', async () => {
    const { services, reads } = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty, ohlcv: () => gtOhlcv })
    const h = await services.tokens.getPriceHistory(SING, '1D')
    expect(h).toEqual({
      points: [
        { t: 1790823600000, usd: 0.000150144690049075 },
        { t: 1790827200000, usd: 0.000179525112062429 },
        { t: 1790830800000, usd: 0.000192835647460391 },
        { t: 1790834400000, usd: 0.000184210825646799 },
        { t: 1790838000000, usd: 0.000194589081779094 },
        { t: 1790841600000, usd: 0.000216899365383411 },
      ],
      candles: parseGtCandles(gtOhlcv),
      volumeUnit: 'USD',
      source: { name: 'GeckoTerminal', market: 'SINGULARTY/wNEAR on Rhea' },
      candleSec: 900,
      since: 1790616798000,
    })
    expect(h?.candles).toHaveLength(6)
    // The day in fifteen-minute candles, of the deepest pair DEX Screener lists, priced as this token (whichever side of the pair it is).
    expect(reads.ohlcv).toEqual([`/pools/${SING_POOL}/ohlcv/minute?aggregate=15&limit=96&currency=usd&token=${SING}`])
  })

  it('each window asks GeckoTerminal for its candle: 1H by the minute, 4H by five, 1W by the hour, 1M by four hours', async () => {
    const { services, reads } = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty })
    for (const range of ['1H', '4H', '1W', '1M'] as const) await services.tokens.getPriceHistory(SING, range)
    expect(reads.ohlcv.map((u) => u.slice(u.indexOf('/ohlcv/')))).toEqual([
      `/ohlcv/minute?aggregate=1&limit=60&currency=usd&token=${SING}`,
      `/ohlcv/minute?aggregate=5&limit=48&currency=usd&token=${SING}`,
      `/ohlcv/hour?aggregate=1&limit=168&currency=usd&token=${SING}`,
      `/ohlcv/hour?aggregate=4&limit=180&currency=usd&token=${SING}`,
    ])
  })

  it('a token no source indexes has no history: null, and nothing is filled in (never "since this page opened")', async () => {
    const { services, reads } = setup()
    expect(await services.tokens.getPriceHistory(SING, '1D')).toBeNull()
    expect(reads.ohlcv).toEqual([])
  })

  it('one provider: a token DEX Screener doesn’t index but GeckoTerminal does gets its deepest pool’s candles, named from GeckoTerminal’s own answer', async () => {
    const { services, reads } = setup({ now: T1, gt: () => gtSingularty, ohlcv: () => gtOhlcv })
    const h = await services.tokens.getPriceHistory(SING, '1D')
    expect(h).toMatchObject({ source: { name: 'GeckoTerminal', market: 'SINGULARTY/wNEAR on Rhea' }, candleSec: 900, since: null, volumeUnit: 'USD' })
    expect(h?.candles).toHaveLength(6)
    expect(reads.ohlcv).toEqual([`/pools/${SING_POOL}/ohlcv/minute?aggregate=15&limit=96&currency=usd&token=${SING}`])
  })

  it('several providers: DEX Screener’s pair is the market, its candles from GeckoTerminal; CoinGecko is not asked', async () => {
    const { services, reads } = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty, ohlcv: () => gtOhlcv, cgChart: () => ({ prices: [[T1, 1]] }) })
    expect((await services.tokens.getPriceHistory(SING, '1D'))?.source.name).toBe('GeckoTerminal')
    expect(reads.cgChart).toEqual([])
  })

  it('no pool indexed, but CoinGecko lists the token: its prices as a line (no candles made up), named CoinGecko', async () => {
    const { services, reads } = setup({
      now: T1,
      cgChart: () => ({
        prices: [
          [T1 - 3 * 3_600_000, 0.0002],
          [T1 - 2 * 3_600_000, 0.00021],
          [T1 - 3_600_000, 0.00022],
        ],
      }),
    })
    const h = await services.tokens.getPriceHistory(SING, '1D')
    expect(h).toMatchObject({ source: { name: 'CoinGecko', market: 'SINGULARTY on CoinGecko' }, candles: [], volumeUnit: null })
    expect(h?.points).toEqual([
      { t: T1 - 3 * 3_600_000, usd: 0.0002 },
      { t: T1 - 2 * 3_600_000, usd: 0.00021 },
      { t: T1 - 3_600_000, usd: 0.00022 },
    ])
    expect(reads.cgChart).toEqual([`/contract/${SING}/market_chart?vs_currency=usd&days=1`])
  })

  it('All: the earliest history the source keeps, in candles as fine as the market’s age allows', async () => {
    // SINGULARTY's pair began 2.6 days before T1: fifteen-minute candles cover all of it in one read.
    const { services, reads } = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty, ohlcv: () => gtOhlcv })
    const h = await services.tokens.getPriceHistory(SING, 'ALL')
    expect(h?.candleSec).toBe(900)
    expect(h?.since).toBe(1790616798000)
    expect(reads.ohlcv).toEqual([`/pools/${SING_POOL}/ohlcv/minute?aggregate=15&limit=1000&currency=usd&token=${SING}`])
  })

  it('All, for a market of unknown age: day candles first, finer ones when days are too few to draw', async () => {
    const { services, reads } = setup({ now: T1, gt: () => gtSingularty, ohlcv: () => gtOhlcv })
    await services.tokens.getPriceHistory(SING, 'ALL')
    expect(reads.ohlcv.map((u) => u.slice(u.indexOf('/ohlcv/'), u.indexOf('&currency')))).toEqual(['/ohlcv/day?aggregate=1&limit=1000', '/ohlcv/hour?aggregate=1&limit=1000'])
  })

  it('a history read is kept for a while: the same window again is not asked again (GeckoTerminal’s rate limit)', async () => {
    const { services, reads, advance } = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty, ohlcv: () => gtOhlcv })
    await services.tokens.getPriceHistory(SING, '1W')
    advance(30_000)
    await services.tokens.getPriceHistory(SING, '1W')
    expect(reads.ohlcv).toHaveLength(1)
    advance(10 * 60_000)
    await services.tokens.getPriceHistory(SING, '1W')
    expect(reads.ohlcv).toHaveLength(2)
  })

  it('a failed history read is an error the screen shows, not an empty line', async () => {
    const down = setup({
      candles: () => {
        throw new Error('down')
      },
    })
    await expect(down.services.tokens.getPriceHistory('near', '1H')).rejects.toThrow()
    const limited = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty, ohlcv: () => new Response('{}', { status: 429 }) })
    await expect(limited.services.tokens.getPriceHistory(SING, '1H')).rejects.toThrow(/rate-limiting/)
  })

  it('testnet has no price history', async () => {
    const { services } = setup({ network: 'testnet' })
    expect(await services.tokens.getPriceHistory('near', '1H')).toBeNull()
  })
})

describe('candles for the chart, by interval (as on Launch Radar): as much history as one read holds', () => {
  const ALL = ['1m', '5m', '15m', '1h', '4h', '1d']

  it('NEAR: Coinbase’s candles at the interval, the most one read gives (300), oldest first, as NEAR/USD with volume in NEAR', async () => {
    const t = T0 / 1000 - 7200
    const { services, calls } = setup({
      // Coinbase answers newest first: [time, low, high, open, close, volume].
      candles: () => [
        [t + 3600, 4.9, 5.1, 5.0, 5.05, 7],
        [t, 4.7, 4.9, 4.8, 4.85, 3],
      ],
    })
    expect(await services.tokens.getCandles('near', '1h')).toEqual({
      interval: '1h',
      kind: 'candles',
      candles: [
        { t: t * 1000, o: 4.8, h: 4.9, l: 4.7, c: 4.85, v: 3 },
        { t: (t + 3600) * 1000, o: 5.0, h: 5.1, l: 4.9, c: 5.05, v: 7 },
      ],
      points: [],
      volumeUnit: 'NEAR',
      source: { name: 'Coinbase', market: 'NEAR/USD' },
      supported: ['1m', '5m', '15m', '1h', '1d'],
      since: null,
    })
    expect(calls[0]).toContain('granularity=3600')
    expect(calls[0]).toContain(`start=${new Date(T0 - 300 * 3_600_000).toISOString()}`)
  })

  it('NEAR: each interval is Coinbase’s own granularity; 4-hour candles Coinbase doesn’t have: nothing is read, and none is made from others', async () => {
    const { services, calls } = setup({ candles: () => [] })
    for (const i of ['1m', '5m', '15m', '1d'] as const) await services.tokens.getCandles('near', i)
    expect(calls.map((c) => new URLSearchParams(c).get('granularity'))).toEqual(['60', '300', '900', '86400'])
    const four = await services.tokens.getCandles('near', '4h')
    expect(four).toMatchObject({ interval: '4h', kind: 'candles', candles: [], points: [], source: { name: 'Coinbase' }, supported: ['1m', '5m', '15m', '1h', '1d'] })
    expect(calls).toHaveLength(4)
  })

  it('a DEX token: its pair’s GeckoTerminal candles at the interval, the whole answer (not one window of it), named by its market, since the pair began', async () => {
    const { services, reads } = setup({ now: T1 + 30 * 86_400_000, dex: () => dexSingularty, gt: () => gtSingularty, ohlcv: () => gtOhlcv })
    const c = await services.tokens.getCandles(SING, '1h')
    expect(c).toEqual({
      interval: '1h',
      kind: 'candles',
      // A month later the same six candles are still drawn: history is what the source holds, not a window back from now.
      candles: parseGtCandles(gtOhlcv),
      points: [],
      volumeUnit: 'USD',
      source: { name: 'GeckoTerminal', market: 'SINGULARTY/wNEAR on Rhea' },
      supported: ALL,
      since: 1790616798000,
    })
    expect(reads.ohlcv).toEqual([`/pools/${SING_POOL}/ohlcv/hour?aggregate=1&limit=720&currency=usd&token=${SING}`])
  })

  it('a DEX token: every interval is GeckoTerminal’s own timeframe, as deep as Launch Radar’s (6 h of minutes … a year of days)', async () => {
    const { services, reads } = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty })
    for (const i of ['1m', '5m', '15m', '4h', '1d'] as const) await services.tokens.getCandles(SING, i)
    expect(reads.ohlcv.map((u) => u.slice(u.indexOf('/ohlcv/'), u.indexOf('&currency')))).toEqual([
      '/ohlcv/minute?aggregate=1&limit=360',
      '/ohlcv/minute?aggregate=5&limit=576',
      '/ohlcv/minute?aggregate=15&limit=672',
      '/ohlcv/hour?aggregate=4&limit=540',
      '/ohlcv/day?aggregate=1&limit=365',
    ])
  })

  it('no pool indexed, but CoinGecko lists the token: its prices as a line (never candles), at the resolutions CoinGecko has', async () => {
    const prices = [
      [T1 - 2 * 3_600_000, 0.0002],
      [T1 - 3_600_000, 0.00021],
    ]
    const { services, reads } = setup({ now: T1, cgChart: () => ({ prices }) })
    const c = await services.tokens.getCandles(SING, '1h')
    expect(c).toEqual({
      interval: '1h',
      kind: 'line',
      candles: [],
      points: [
        { t: T1 - 2 * 3_600_000, usd: 0.0002 },
        { t: T1 - 3_600_000, usd: 0.00021 },
      ],
      volumeUnit: null,
      source: { name: 'CoinGecko', market: 'SINGULARTY on CoinGecko' },
      supported: ['5m', '1h', '1d'],
      since: null,
    })
    await services.tokens.getCandles(SING, '5m')
    await services.tokens.getCandles(SING, '1d')
    expect(reads.cgChart).toEqual([
      `/contract/${SING}/market_chart?vs_currency=usd&days=30`,
      `/contract/${SING}/market_chart?vs_currency=usd&days=1`,
      `/contract/${SING}/market_chart?vs_currency=usd&days=365`,
    ])
    // 15 minutes is not a resolution CoinGecko has: nothing is read.
    expect(await services.tokens.getCandles(SING, '15m')).toMatchObject({ kind: 'line', points: [], supported: ['5m', '1h', '1d'] })
    expect(reads.cgChart).toHaveLength(3)
  })

  it('a token no source indexes has no candles: null', async () => {
    const { services, reads } = setup()
    expect(await services.tokens.getCandles(SING, '1h')).toBeNull()
    expect(reads.ohlcv).toEqual([])
  })

  it('a read is kept until its interval’s next candle can matter: the same interval again soon is not asked again', async () => {
    const { services, reads, advance } = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty, ohlcv: () => gtOhlcv })
    await services.tokens.getCandles(SING, '1h')
    advance(60_000)
    await services.tokens.getCandles(SING, '1h')
    expect(reads.ohlcv).toHaveLength(1)
    advance(5 * 60_000)
    await services.tokens.getCandles(SING, '1h')
    expect(reads.ohlcv).toHaveLength(2)
  })

  it('a failed read is an error the screen shows, not an empty chart', async () => {
    const limited = setup({ now: T1, dex: () => dexSingularty, gt: () => gtSingularty, ohlcv: () => new Response('{}', { status: 429 }) })
    await expect(limited.services.tokens.getCandles(SING, '1h')).rejects.toThrow(/rate-limiting/)
  })

  it('testnet has no candles', async () => {
    const { services } = setup({ network: 'testnet' })
    expect(await services.tokens.getCandles('near', '1h')).toBeNull()
  })
})

describe('supply for FDV', () => {
  it('reads a token’s total supply on chain; NEAR and unreadable tokens have none', async () => {
    const { services } = setup()
    expect(await services.tokens.getTotalSupply(SING)).toBe((10n ** 27n).toString())
    expect(await services.tokens.getTotalSupply('near')).toBeNull()
    expect(await services.tokens.getTotalSupply('nothing-here.near')).toBeNull()
  })
})

describe('live activity: recent buys and sells, read from the chain’s own record', () => {
  it('a real buy of the token: who bought, how many tokens, for how much NEAR, when, and its transaction', async () => {
    const { services, reads } = setup({ index: { txs: [BUY] } })
    const trades = await services.tokens.getActivity(SING)
    expect(trades).toEqual([
      {
        hash: BUY.transaction.hash,
        side: 'buy',
        account: 'mort1705.tg',
        amount: '69099416000669574619652',
        near: (10n ** 24n).toString(),
        at: Number(BigInt(BUY.block_timestamp) / 1_000_000n),
      },
    ])
    // The latest transactions that touched the token's own contract.
    expect(reads.account).toEqual([SING])
  })

  it('a token whose contract logs its transfers as text lines, with no events (BLACKDRAGON): its buys and sells are shown too', async () => {
    const { services } = setup({ index: { txs: [BD_SELL, BD_BUY] } })
    expect(await services.tokens.getActivity(BLACKDRAGON)).toEqual([
      {
        hash: BD_BUY.transaction.hash,
        side: 'buy',
        account: 'blackdragonmeme.near',
        amount: '32826022038988341595633215922069281',
        near: '134000000000000000000000000',
        at: atOf(BD_BUY),
      },
      {
        hash: BD_SELL.transaction.hash,
        side: 'sell',
        account: 'blackdragonmeme.near',
        amount: '33300000000000000000000000000000000',
        // Rhea unwrapped the proceeds and paid them out as NEAR.
        near: '133930913650008363905892289',
        at: atOf(BD_SELL),
      },
    ])
  })

  it('a transaction that isn’t a trade of this token against NEAR is not shown as one', async () => {
    const { services } = setup({ index: { txs: [BUY] } })
    // The same transaction, asked about another token: not a buy or a sell of it.
    expect(await services.tokens.getActivity('usdt.tether-token.near')).toEqual([])
  })

  it('reads each transaction once: a refresh only fetches what’s new', async () => {
    const { services, reads } = setup({ index: { txs: [BUY] } })
    await services.tokens.getActivity(SING)
    await services.tokens.getActivity(SING)
    expect(reads.transactions).toBe(1)
  })

  it('NEAR itself has no activity source (null); a token whose latest transactions hold no trade has none, never an invented one', async () => {
    const { services } = setup()
    expect(await services.tokens.getActivity('near')).toBeNull()
    expect(await services.tokens.getActivity(SING)).toEqual([])
  })

  it('a failed read is an error the page shows, not an empty list', async () => {
    const { services } = setup({ index: { txs: [BUY], fail: true } })
    await expect(services.tokens.getActivity(SING)).rejects.toThrow()
  })
})

describe('market data: each figure from a source that has it, or why it’s missing', () => {
  it('SINGULARTY: price, 24h change, liquidity, volume and FDV from its deepest DEX Screener pair; no market cap, since no source knows a circulating supply', async () => {
    const { services, reads } = setup({ dex: () => dexSingularty, gt: () => gtSingularty })
    const m = await services.tokens.getMarketData(SING)
    expect(m.priceUsd).toEqual({ state: 'known', value: 0.0002169, source: 'DEX Screener', at: T0 })
    expect(m.priceNear).toEqual({ state: 'known', value: 0.00004139, source: 'DEX Screener', at: T0 })
    expect(m.change24hPct).toEqual({ state: 'known', value: 54.97, source: 'DEX Screener', at: T0 })
    expect(m.liquidityUsd).toEqual({ state: 'known', value: 62848.15, source: 'DEX Screener', at: T0 })
    expect(m.volume24hUsd).toEqual({ state: 'known', value: 56459.97, source: 'DEX Screener', at: T0 })
    expect(m.fdvUsd).toEqual({ state: 'known', value: 216982, source: 'DEX Screener', at: T0 })
    // DEX Screener's "marketCap" is its FDV again, and GeckoTerminal has none: unavailable, never the FDV under another name.
    expect(m.marketCapUsd).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/circulating supply/) })
    expect(m.pair).toEqual({
      id: SING_POOL,
      dex: 'Rhea',
      baseSymbol: 'SINGULARTY',
      quoteSymbol: 'wNEAR',
      createdAt: 1790616798000,
      url: `https://dexscreener.com/near/${SING_POOL}`,
      source: 'DEX Screener',
      txns24h: { buys: 195, sells: 221 },
    })
    expect(m.supply).toEqual({ circulating: null, total: 1_000_000_000, source: 'GeckoTerminal' })
    expect(reads.dex).toEqual([SING])
    expect(reads.gt).toEqual([SING])
  })

  it('NEARLY: a market cap of its own from GeckoTerminal (CoinGecko knows its circulating supply), apart from its FDV', async () => {
    const { services } = setup({ dex: () => dexNearlyNstai, gt: () => gtNearly })
    const m = await services.tokens.getMarketData(NEARLY)
    expect(m.marketCapUsd).toEqual({ state: 'known', value: 5630148.53824155, source: 'GeckoTerminal (CoinGecko’s circulating supply)', at: T0 })
    expect(m.fdvUsd).toEqual({ state: 'known', value: 5807114, source: 'DEX Screener', at: T0 })
    expect(m.priceUsd).toMatchObject({ state: 'known', value: 0.005807 })
  })

  it('NSTAI, hours old: found on chain, priced by its new pair, with no market cap and the pair’s age', async () => {
    const { services } = setup({ dex: () => dexNearlyNstai })
    expect((await services.tokens.lookupToken(NSTAI)).symbol).toBe('NSTAI')
    const m = await services.tokens.getMarketData(NSTAI)
    expect(m.priceUsd).toEqual({ state: 'known', value: 0.000008695, source: 'DEX Screener', at: T0 })
    expect(m.liquidityUsd).toMatchObject({ state: 'known', value: 8300.15 })
    expect(m.fdvUsd).toEqual({ state: 'known', value: 8695, source: 'DEX Screener', at: T0 })
    expect(m.marketCapUsd.state).toBe('unavailable')
    expect(m.pair).toMatchObject({ id: 'refv2-nstai.nearlytrade.near:wrap.near:10000', createdAt: 1790839516000, txns24h: { buys: 53, sells: 26 } })
  })

  it('NEAR: its price and 24h change from Coinbase, market cap, FDV, volume and supplies from CoinGecko; liquidity is not a figure NEAR has', async () => {
    const { services, reads } = setup()
    const m = await services.tokens.getMarketData('near')
    expect(m.priceUsd).toMatchObject({ state: 'known', value: 5, source: 'Coinbase' })
    expect(m.change24hPct).toMatchObject({ state: 'known', value: expect.closeTo((0.2 / 4.8) * 100, 6), source: 'Coinbase' })
    expect(m.marketCapUsd).toEqual({ state: 'known', value: 6848020379, source: 'CoinGecko', at: Date.parse('2026-10-01T08:29:30.000Z') })
    expect(m.fdvUsd).toMatchObject({ state: 'known', value: 6848021002, source: 'CoinGecko' })
    expect(m.volume24hUsd).toMatchObject({ state: 'known', value: 1502559527, source: 'CoinGecko' })
    expect(m.liquidityUsd.state).toBe('not-applicable')
    expect(m.supply).toEqual({ circulating: 1307767944, total: 1307767815, source: 'CoinGecko' })
    expect(m.pair).toBeNull()
    expect(reads.dex).toEqual([])
    expect(reads.coingecko).toBe(1)
  })

  it('a token neither DEX Screener nor GeckoTerminal indexes keeps the price NEARKITS’ own list has; everything else is missing, with why', async () => {
    const { services } = setup()
    const m = await services.tokens.getMarketData(SING)
    expect(m.priceUsd).toMatchObject({ state: 'known', value: 0.00567, source: 'Rhea’s price list' })
    for (const f of [m.marketCapUsd, m.fdvUsd, m.liquidityUsd, m.volume24hUsd, m.change24hPct])
      expect(f).toEqual({ state: 'unavailable', reason: 'DEX Screener has no pair for this token, and GeckoTerminal has no pool for it' })
    expect(m.pair).toBeNull()
  })

  describe('KITS: DEX Screener lists no pair (2026-10-20), GeckoTerminal has its pool', () => {
    const KITS = 'kits.nearlytrade.near'
    const KITS_POOL = 'refv2-kits.nearlytrade.near:wrap.near:10000'
    /** GeckoTerminal's real KITS pool answer (2026-10-20), with some of its attributes replaced. */
    const poolWith = (attributes: Record<string, unknown>) => ({ ...gtKitsPool, data: { ...gtKitsPool.data, attributes: { ...gtKitsPool.data.attributes, ...attributes } } })
    const kits = (over: Partial<SetupOptions> = {}) =>
      setup({ dex: () => [], gt: (t) => (t === KITS ? gtKits : new Response('{}', { status: 404 })), pool: () => gtKitsPool, ...over })

    it('price, 24h change, liquidity, 24h volume and FDV from GeckoTerminal, each named as such; a real zero volume (no trades in 24 h) is shown as zero', async () => {
      const { services, reads } = kits()
      const m = await services.tokens.getMarketData(KITS)
      const gt = (value: number) => ({ state: 'known', value, source: 'GeckoTerminal', at: T0 })
      expect(m.priceUsd).toEqual(gt(0.000010877813611346))
      // Priced against wNEAR in the pool itself.
      expect(m.priceNear).toEqual(gt(0.000002193107583))
      expect(m.change24hPct).toEqual(gt(0))
      // The pool's liquidity (both sides, in USD), as DEX Screener counts it.
      expect(m.liquidityUsd).toEqual(gt(9702.5234))
      expect(m.volume24hUsd).toEqual(gt(0))
      expect(m.fdvUsd).toEqual(gt(10877.813611346))
      // GeckoTerminal knows no circulating supply for KITS: no market cap, never the FDV under another name.
      expect(m.marketCapUsd).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/circulating supply/) })
      expect(m.supply).toEqual({ circulating: null, total: 1_000_000_000, source: 'GeckoTerminal' })
      expect(m.pair).toEqual({
        id: KITS_POOL,
        dex: 'Rhea',
        baseSymbol: 'KITS',
        quoteSymbol: 'wNEAR',
        // GeckoTerminal says this pool began in 2023, before KITS existed: no start date rather than a wrong one.
        createdAt: null,
        url: `https://www.geckoterminal.com/near/pools/${KITS_POOL}`,
        source: 'GeckoTerminal',
        txns24h: { buys: 0, sells: 0 },
      })
      expect(reads.dex).toEqual([KITS])
      expect(reads.pool).toEqual([`/pools/${KITS_POOL}?include=base_token,quote_token,dex`])
    })

    it('a market with trades: its volume and its buys and sells as GeckoTerminal counts them', async () => {
      const { services } = kits({
        pool: () =>
          poolWith({
            volume_usd: { ...gtKitsPool.data.attributes.volume_usd, h24: '252.57' },
            transactions: { ...gtKitsPool.data.attributes.transactions, h24: { buys: 3, sells: 2, buyers: 3, sellers: 2 } },
            price_change_percentage: { ...gtKitsPool.data.attributes.price_change_percentage, h24: '-4.2' },
          }),
      })
      const m = await services.tokens.getMarketData(KITS)
      expect(m.volume24hUsd).toMatchObject({ state: 'known', value: 252.57, source: 'GeckoTerminal' })
      expect(m.change24hPct).toMatchObject({ state: 'known', value: -4.2 })
      expect(m.pair?.txns24h).toEqual({ buys: 3, sells: 2 })
    })

    it('a figure GeckoTerminal doesn’t give is unavailable, with why: never zero, never estimated from the chart', async () => {
      const { services } = kits({ pool: () => poolWith({ reserve_in_usd: null, volume_usd: null, price_change_percentage: null, transactions: null }) })
      const m = await services.tokens.getMarketData(KITS)
      expect(m.liquidityUsd).toEqual({ state: 'unavailable', reason: 'GeckoTerminal reports no liquidity for this pool' })
      expect(m.volume24hUsd).toEqual({ state: 'unavailable', reason: 'GeckoTerminal reports no 24h volume for this pool' })
      expect(m.change24hPct).toEqual({ state: 'unavailable', reason: 'GeckoTerminal reports no 24h change for this pool' })
      expect(m.pair?.txns24h).toBeNull()
      // What it does give stands.
      expect(m.priceUsd).toMatchObject({ state: 'known', source: 'GeckoTerminal' })
      expect(m.fdvUsd).toMatchObject({ state: 'known', value: 10877.813611346 })
    })

    it('GeckoTerminal’s pool read fails: the price from NEARKITS’ own list, the FDV from GeckoTerminal’s token, the rest unavailable naming the failure', async () => {
      const { services } = kits({ pool: () => new Response('{}', { status: 429 }) })
      const m = await services.tokens.getMarketData(KITS)
      // NEARKITS’ own price list doesn’t carry KITS in this test: no price, with why.
      expect(m.priceUsd).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/GeckoTerminal isn’t answering \(api\.geckoterminal\.com is rate-limiting/) })
      expect(m.fdvUsd).toMatchObject({ state: 'known', value: 10877.813611346, source: 'GeckoTerminal' })
      for (const f of [m.liquidityUsd, m.volume24hUsd, m.change24hPct])
        expect(f).toEqual({
          state: 'unavailable',
          reason: 'DEX Screener has no pair for this token, and GeckoTerminal isn’t answering (api.geckoterminal.com is rate-limiting requests right now)',
        })
      expect(m.pair).toBeNull()
    })

    it('after a good read, a GeckoTerminal failure keeps the last figures, marked stale with why (not flipped to unavailable)', async () => {
      let pool: () => unknown = () => gtKitsPool
      const { services, advance } = kits({ pool: () => pool() })
      await services.tokens.getMarketData(KITS)
      pool = () => new Response('{}', { status: 429 })
      advance(65_000)
      const m = await services.tokens.getMarketData(KITS)
      expect(m.liquidityUsd).toMatchObject({
        state: 'stale',
        value: 9702.5234,
        source: 'GeckoTerminal',
        reason: expect.stringMatching(/^not refreshed: .*GeckoTerminal isn’t answering/),
      })
      expect(m.volume24hUsd).toMatchObject({ state: 'stale', value: 0 })
    })

    it('GeckoTerminal down altogether: the reason says so, not that the token has no market', async () => {
      const { services } = kits({ gt: () => new Response('{}', { status: 503 }) })
      const m = await services.tokens.getMarketData(KITS)
      for (const f of [m.fdvUsd, m.liquidityUsd, m.volume24hUsd])
        expect(f).toEqual({ state: 'unavailable', reason: 'DEX Screener has no pair for this token, and GeckoTerminal isn’t answering (api.geckoterminal.com answered HTTP 503)' })
    })

    it('a token on the quote side of its pool: its own price from the pool, no 24h change (the pool’s is the other token’s)', async () => {
      const swapped = {
        ...gtKitsPool,
        data: {
          ...gtKitsPool.data,
          attributes: {
            ...gtKitsPool.data.attributes,
            base_token_price_usd: '4.96',
            quote_token_price_usd: '0.000010877813611346',
            quote_token_price_base_token: '0.000002193107583',
          },
          relationships: { ...gtKitsPool.data.relationships, base_token: gtKitsPool.data.relationships.quote_token, quote_token: gtKitsPool.data.relationships.base_token },
        },
      }
      const { services } = kits({ pool: () => swapped })
      const m = await services.tokens.getMarketData(KITS)
      expect(m.priceUsd).toMatchObject({ state: 'known', value: 0.000010877813611346, source: 'GeckoTerminal' })
      expect(m.priceNear).toMatchObject({ state: 'known', value: 0.000002193107583 })
      expect(m.change24hPct).toMatchObject({ state: 'unavailable' })
      expect(m.liquidityUsd).toMatchObject({ state: 'known', value: 9702.5234 })
      expect(m.pair).toMatchObject({ baseSymbol: 'KITS', quoteSymbol: 'wNEAR' })
    })

    it('GeckoTerminal’s pool is read once a minute at most (its limit is about 30 requests a minute per address)', async () => {
      const { services, reads, advance } = kits()
      await services.tokens.getMarketData(KITS)
      advance(25_000)
      await services.tokens.getMarketData(KITS)
      expect(reads.pool).toHaveLength(1)
      advance(40_000)
      await services.tokens.getMarketData(KITS)
      expect(reads.pool).toHaveLength(2)
    })
  })

  it('reads a token’s figures once per 20 s, then again', async () => {
    const { services, reads, advance } = setup({ dex: () => dexSingularty, gt: () => gtSingularty })
    await services.tokens.getMarketData(SING)
    await services.tokens.getMarketData(SING)
    expect(reads.dex).toEqual([SING])
    advance(21_000)
    await services.tokens.getMarketData(SING)
    expect(reads.dex).toEqual([SING, SING])
    // GeckoTerminal, rate-limited, is asked once a minute at most.
    expect(reads.gt).toEqual([SING])
  })

  it('when the source stops answering, the last figures stay, marked stale with why; a figure it never gave is not invented', async () => {
    let down = false
    const { services, advance } = setup({
      dex: () => {
        if (down) throw new Error('offline')
        return dexSingularty
      },
      gt: () => gtSingularty,
    })
    await services.tokens.getMarketData(SING)
    down = true
    advance(21_000)
    const m = await services.tokens.getMarketData(SING)
    expect(m.priceUsd).toEqual({ state: 'stale', value: 0.0002169, source: 'DEX Screener', at: T0, reason: expect.stringMatching(/not refreshed/) })
    expect(m.liquidityUsd).toMatchObject({ state: 'stale', value: 62848.15 })
    expect(m.marketCapUsd.state).toBe('unavailable')
    expect(m.updatedAt).toBe(T0)
  })

  it('a source that never answered: the price from NEARKITS’ own list if any, the rest missing with the reason', async () => {
    const { services } = setup({
      dex: () => {
        throw new Error('offline')
      },
    })
    const m = await services.tokens.getMarketData(SING)
    expect(m.priceUsd).toMatchObject({ state: 'known', value: 0.00567, source: 'Rhea’s price list' })
    expect(m.liquidityUsd).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/offline/) })
  })

  it('testnet: no market exists, and no source is asked', async () => {
    const { services, reads } = setup({ network: 'testnet' })
    const m = await services.tokens.getMarketData('usdt.itachicara.testnet')
    expect(m.priceUsd).toEqual({ state: 'not-applicable', reason: 'Testnet has no market prices.' })
    expect(m.marketCapUsd.state).toBe('not-applicable')
    expect(reads.dex).toEqual([])
    expect(reads.coingecko).toBe(0)
  })
})
