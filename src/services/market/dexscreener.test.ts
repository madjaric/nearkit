import { describe, expect, it } from 'vitest'
import { fetchDexPairs, mainPair, parseDexPairs } from './dexscreener'
import singularty from './fixtures/dexscreener-token-pairs-singularty.json'
import nearlyNstai from './fixtures/dexscreener-tokens-nearly-nstai.json'

/**
 * DEX Screener's indexed pairs on NEAR (chain `near`, Rhea's pools), as its API answered on
 * 2026-10-01: SINGULARTY's three pairs (one deep DCL pool and two near-empty classic pools),
 * and NEARLY's and NSTAI's main pairs. Every figure is read as reported, or left null.
 */

const SING = 'singularty.nearlytrade.near'

describe('DEX Screener pairs', () => {
  it('reads each pair’s figures as reported: price in USD and in the quote token, 24h change, liquidity, volume, FDV, trades', () => {
    const pairs = parseDexPairs(singularty)
    expect(pairs).toHaveLength(3)
    expect(pairs[0]).toEqual({
      id: 'refv2-singularty.nearlytrade.near:wrap.near:10000',
      dex: 'rhea-finance',
      url: 'https://dexscreener.com/near/refv2-singularty.nearlytrade.near:wrap.near:10000',
      base: { address: SING, symbol: 'SINGULARTY' },
      quote: { address: 'wrap.near', symbol: 'wNEAR' },
      priceUsd: 0.0002169,
      priceNative: 0.00004139,
      change24hPct: 54.97,
      liquidityUsd: 62848.15,
      volume24hUsd: 56459.97,
      fdvUsd: 216982,
      marketCapUsd: 216982,
      txns24h: { buys: 195, sells: 221 },
      createdAt: 1790616798000,
    })
  })

  it('the main pair is the deepest one the token trades on, whichever side it is on', () => {
    const pairs = parseDexPairs(singularty)
    expect(mainPair(pairs, SING)?.id).toBe('refv2-singularty.nearlytrade.near:wrap.near:10000')
    // The quote side counts too; another token's pairs never do.
    expect(mainPair(pairs, 'wrap.near')?.id).toBe('refv2-singularty.nearlytrade.near:wrap.near:10000')
    expect(mainPair(pairs, 'other.near')).toBeNull()
    expect(mainPair([], SING)).toBeNull()
  })

  it('a figure the source leaves out is null, never zero; a row that isn’t a pair is dropped', () => {
    const [first] = singularty as unknown as Record<string, unknown>[]
    const thin = { ...first, priceChange: { h1: 1 }, liquidity: undefined, volume: { h6: 1 }, txns: undefined, fdv: 'not a number', pairCreatedAt: undefined, url: undefined }
    const [pair] = parseDexPairs([thin, { chainId: 'near' }, null, 'x'])
    expect(parseDexPairs([thin, { chainId: 'near' }, null, 'x'])).toHaveLength(1)
    expect(pair).toMatchObject({ change24hPct: null, liquidityUsd: null, volume24hUsd: null, txns24h: null, fdvUsd: null, createdAt: null, url: null, priceUsd: 0.0002169 })
    expect(parseDexPairs({ pairs: [] })).toEqual([])
    expect(parseDexPairs(null)).toEqual([])
  })

  it('NEARLY and NSTAI: one main pair each, with its figures', () => {
    const pairs = parseDexPairs(nearlyNstai)
    expect(mainPair(pairs, 'nearly-993927.nearlytrade.near')).toMatchObject({
      priceUsd: 0.005807,
      liquidityUsd: 361454.46,
      fdvUsd: 5807114,
      marketCapUsd: 5807114,
      change24hPct: 38.89,
    })
    expect(mainPair(pairs, 'nstai.nearlytrade.near')).toMatchObject({ priceUsd: 0.000008695, liquidityUsd: 8300.15, createdAt: 1790839516000, txns24h: { buys: 53, sells: 26 } })
  })

  it('asks for a token’s pairs on NEAR, and an HTTP error is an error, not an empty market', async () => {
    const urls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify(singularty), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const pairs = await fetchDexPairs(fetchImpl, 'https://api.dexscreener.com', 'near', SING)
    expect(urls).toEqual([`https://api.dexscreener.com/token-pairs/v1/near/${SING}`])
    expect(pairs).toHaveLength(3)
    const down = (async () => new Response('busy', { status: 503 })) as typeof fetch
    await expect(fetchDexPairs(down, 'https://api.dexscreener.com', 'near', SING)).rejects.toThrow(/503/)
  })
})

describe('a pair’s link', () => {
  it('is kept only when it is a DEX Screener page', () => {
    const pair = (url: unknown) =>
      parseDexPairs({
        pairs: [
          {
            chainId: 'near',
            dexId: 'ref',
            pairAddress: '1',
            url,
            baseToken: { address: 'a.near', symbol: 'A', name: 'A' },
            quoteToken: { address: 'wrap.near', symbol: 'WNEAR', name: 'Wrapped NEAR' },
            priceUsd: '1',
          },
        ],
      })[0]?.url ?? null
    expect(pair('https://dexscreener.com/near/1')).toBe('https://dexscreener.com/near/1')
    expect(pair('javascript:alert(1)')).toBeNull()
    expect(pair('https://evil.example/near/1')).toBeNull()
    expect(pair('https://dexscreener.com.evil.example/x')).toBeNull()
  })
})
