import { describe, expect, it } from 'vitest'
import { fetchCoinMarkets, parseCoinMarkets } from './coingecko'
import near from './fixtures/coingecko-markets-near.json'

/** CoinGecko's market figures for NEAR itself (its `coins/markets` answer of 2026-10-01). */

describe('CoinGecko markets', () => {
  it('NEAR’s market cap, FDV, volume, 24h change and supplies, as reported', () => {
    expect(parseCoinMarkets(near)).toEqual({
      priceUsd: 5.24,
      marketCapUsd: 6848020379,
      fdvUsd: 6848021002,
      volume24hUsd: 1502559527,
      change24hPct: 3.67107,
      circulatingSupply: 1307767944,
      totalSupply: 1307767815,
      updatedAt: Date.parse('2026-10-01T08:29:30.000Z'),
    })
  })

  it('no coin, or something that isn’t the markets list, is null', () => {
    expect(parseCoinMarkets([])).toBeNull()
    expect(parseCoinMarkets({ error: 'rate limited' })).toBeNull()
    expect(parseCoinMarkets([{ id: 'near', current_price: 'x' }])).toBeNull()
  })

  it('a figure the source leaves out stays null', () => {
    const [row] = near as Record<string, unknown>[]
    expect(parseCoinMarkets([{ ...row, market_cap: null, fully_diluted_valuation: undefined, last_updated: 'soon' }])).toMatchObject({
      marketCapUsd: null,
      fdvUsd: null,
      updatedAt: null,
      priceUsd: 5.24,
    })
  })

  it('fetches the configured URL; an HTTP error is an error', async () => {
    const urls: string[] = []
    const ok = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify(near), { status: 200 })
    }) as typeof fetch
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=near'
    expect((await fetchCoinMarkets(ok, url))?.marketCapUsd).toBe(6848020379)
    expect(urls).toEqual([url])
    const limited = (async () => new Response('{}', { status: 429 })) as typeof fetch
    await expect(fetchCoinMarkets(limited, url)).rejects.toMatchObject({ status: 429 })
  })
})
