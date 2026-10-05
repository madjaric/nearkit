import { describe, expect, it } from 'vitest'
import ohlcv from './fixtures/geckoterminal-ohlcv-singularty-hour.json'
import nearly from './fixtures/geckoterminal-token-nearly.json'
import singularty from './fixtures/geckoterminal-token-singularty.json'
import { fetchGtOhlcv, fetchGtToken, MarketSourceError, parseGtCandles, parseGtOhlcv, parseGtToken } from './geckoterminal'

/**
 * GeckoTerminal (CoinGecko's DEX data) on NEAR, as its API answered on 2026-10-01: a token's
 * figures (a market cap only when CoinGecko knows the circulating supply: NEARLY yes,
 * SINGULARTY no), and a pool's candles, which exist only for periods with trades.
 */

const POOL = 'refv2-singularty.nearlytrade.near:wrap.near:10000'

describe('GeckoTerminal token', () => {
  it('a token CoinGecko lists has a market cap of its own, apart from its FDV', () => {
    expect(parseGtToken(nearly)).toEqual({
      priceUsd: 0.005814882152,
      fdvUsd: 5814882.15150511,
      marketCapUsd: 5630148.53824155,
      totalSupply: 1_000_000_000,
      volume24hUsd: 913437.517187033,
      coingeckoId: 'nearly',
      topPools: [
        'refv2-nearly-993927.nearlytrade.near:wrap.near:10000',
        'refv2-eclipse.nearlytrade.near:nearly-993927.nearlytrade.near:10000',
        'refv2-nearly-993927.nearlytrade.near:rich.nearlytrade.near:10000',
      ],
    })
  })

  it('a token with no known circulating supply has no market cap: null, not its FDV', () => {
    expect(parseGtToken(singularty)).toMatchObject({ marketCapUsd: null, fdvUsd: 234325.688808999, coingeckoId: null, topPools: [POOL, 'refv1-8742', 'refv1-8741'] })
  })

  it('anything that isn’t a token answer is null', () => {
    expect(parseGtToken({ status: { error_code: 404 } })).toBeNull()
    expect(parseGtToken(null)).toBeNull()
  })
})

describe('GeckoTerminal candles', () => {
  it('each candle’s close at the candle’s start, oldest first', () => {
    const points = parseGtOhlcv(ohlcv)
    expect(points).toHaveLength(6)
    expect(points[0]).toEqual({ t: 1790823600000, usd: 0.000150144690049075 })
    expect(points[5]).toEqual({ t: 1790841600000, usd: 0.000216899365383411 })
    expect(points.map((p) => p.t)).toEqual([...points.map((p) => p.t)].sort((a, b) => a - b))
  })

  it('the full candles: open, high, low, close and volume (USD), oldest first; a candle that doesn’t add up is dropped, never repaired', () => {
    const candles = parseGtCandles(ohlcv)
    expect(candles).toHaveLength(6)
    expect(candles[5]).toEqual({ t: 1790841600000, o: 0.000194589081779094, h: 0.000216899365383411, l: 0.000191840629796267, c: 0.000216899365383411, v: 3292.388374021218 })
    const broken = {
      data: {
        attributes: {
          ohlcv_list: [
            [1790841600, 1, 2, 0.5, 1.5, 10],
            // High below the open: doesn't add up.
            [1790838000, 1, 0.9, 0.5, 0.8, 1],
            [1790834400, 1, 2, 0.5, 0, 1],
            // A volume that isn't one: unknown, the prices stand.
            [1790830800, 1, 2, 0.5, 1.5, -1],
            ['x', 1, 2, 0.5, 1.5, 1],
            'nope',
          ],
        },
      },
    }
    expect(parseGtCandles(broken)).toEqual([
      { t: 1790830800000, o: 1, h: 2, l: 0.5, c: 1.5, v: null },
      { t: 1790841600000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    ])
  })

  it('drops a malformed candle instead of repairing it', () => {
    const broken = { data: { attributes: { ohlcv_list: [['x', 1, 2, 1, 5, 1], [1790841600, 1, 2, 1, 0, 1], [1790838000, 1, 2, 1, 4.5, 1], 'nope'] } } }
    expect(parseGtOhlcv(broken)).toEqual([{ t: 1790838000000, usd: 4.5 }])
    expect(parseGtOhlcv({ data: {} })).toEqual([])
  })

  it('asks for a pool’s candles by timeframe and aggregate, and a rate limit is an error that says so', async () => {
    const urls: string[] = []
    const ok = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify(ohlcv), { status: 200 })
    }) as typeof fetch
    const base = 'https://api.geckoterminal.com/api/v2/networks/near'
    expect(await fetchGtOhlcv(ok, base, POOL, { timeframe: 'minute', aggregate: 15, limit: 96 })).toHaveLength(6)
    expect(urls).toEqual([`${base}/pools/${POOL}/ohlcv/minute?aggregate=15&limit=96&currency=usd`])
    const limited = (async () => new Response('{"status":{"error_code":429}}', { status: 429 })) as typeof fetch
    await expect(fetchGtOhlcv(limited, base, POOL, { timeframe: 'hour', aggregate: 1, limit: 168 })).rejects.toMatchObject({ status: 429 })
    await expect(fetchGtOhlcv(limited, base, POOL, { timeframe: 'hour', aggregate: 1, limit: 168 })).rejects.toBeInstanceOf(MarketSourceError)
  })

  it('a request that got no answer at all names the likely cause: the rate limit (its 429s carry no CORS headers in a browser)', async () => {
    const base = 'https://api.geckoterminal.com/api/v2/networks/near'
    const blocked = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(fetchGtOhlcv(blocked, base, POOL, { timeframe: 'minute', aggregate: 1, limit: 60 })).rejects.toThrow(/rate limit \(about 30 requests a minute/)
    await expect(fetchGtToken(blocked, base, 'nstai.nearlytrade.near')).rejects.toThrow(/rate limit/)
  })

  it('a token GeckoTerminal doesn’t index is null; any other failure is an error', async () => {
    const base = 'https://api.geckoterminal.com/api/v2/networks/near'
    const missing = (async () => new Response('{"errors":[{"status":"404"}]}', { status: 404 })) as typeof fetch
    expect(await fetchGtToken(missing, base, 'unknown.near')).toBeNull()
    const found = (async () => new Response(JSON.stringify(nearly), { status: 200 })) as typeof fetch
    expect((await fetchGtToken(found, base, 'nearly-993927.nearlytrade.near'))?.coingeckoId).toBe('nearly')
    const down = (async () => new Response('', { status: 500 })) as typeof fetch
    await expect(fetchGtToken(down, base, 'nearly-993927.nearlytrade.near')).rejects.toMatchObject({ status: 500 })
  })
})
