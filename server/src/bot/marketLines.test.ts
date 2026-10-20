import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import cgNear from '@/services/market/fixtures/coingecko-markets-near.json'
import gtKitsPool from '@/services/market/fixtures/geckoterminal-pool-kits.json'
import gtKits from '@/services/market/fixtures/geckoterminal-token-kits.json'
import { createNearServices } from '@/services/real'
import { memoryStorage } from '@/services/real/stores'
import { createFakeChain } from '@/services/real/testing/fakeChain'
import { marketLines } from './trade'

/**
 * The market lines /token and /kits show, from the same market service the web app reads, with
 * mainnet's sources faked by their real answers about $KITS (2026-10-20): DEX Screener lists no pair,
 * GeckoTerminal has its Rhea pool. A figure no source gives is left out or said to be unavailable,
 * never shown as $0; a market cap is never shown without a circulating supply.
 */

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0)
const notFound = () => new Response('{"errors":[{"status":"404"}]}', { status: 404 })
const poolWith = (attributes: Record<string, unknown>) => ({ ...gtKitsPool, data: { ...gtKitsPool.data, attributes: { ...gtKitsPool.data.attributes, ...attributes } } })

function bot(o: { pool?: () => unknown; gtToken?: () => unknown } = {}) {
  let now = T0
  const chain = createFakeChain()
  chain.route('https://api.rhea.finance/list-token-price', () => ({}))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/ticker', () => ({ price: '4.96' }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/stats', () => ({ open: '4.90', last: '4.96' }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/candles', () => [])
  chain.route('https://api.dexscreener.com/token-pairs/v1/near/', () => [])
  chain.route('https://api.geckoterminal.com/api/v2/networks/near/tokens/', (url) => (url.pathname.endsWith(KITS_CONTRACT) ? (o.gtToken ? o.gtToken() : gtKits) : notFound()))
  chain.route('https://api.geckoterminal.com/api/v2/networks/near/pools/', (url) =>
    url.pathname.includes('/ohlcv/') ? { data: { attributes: { ohlcv_list: [] } } } : o.pool ? o.pool() : gtKitsPool,
  )
  chain.route('https://api.coingecko.com/api/v3/coins/markets', () => cgNear)
  chain.route('https://api.coingecko.com/api/v3/coins/near-protocol/contract/', notFound)
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: 'fees.example.near' })
  const services = createNearServices({ env, network: NETWORKS.mainnet, fetch: chain.fetch, kv: memoryStorage(), now: () => now })
  return { lines: async () => marketLines(await services.tokens.getMarketData(KITS_CONTRACT)), advance: (ms: number) => void (now += ms) }
}

describe('the bot’s market lines for $KITS', () => {
  it('FDV, liquidity, price and 24h change from GeckoTerminal’s pool; FDV named FDV, never Market Cap', async () => {
    const lines = await bot().lines()
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^📊 FDV <b>\$10\.88K<\/b>$/)
    expect(lines[1]).toMatch(/^💧 Liquidity <b>\$9\.7K<\/b>$/)
    // $0.0000108778 shown to three significant figures; GeckoTerminal's 24h change is a real 0.
    expect(lines[2]).toBe('💵 Price <b>$0.0000109</b> · 24h <b>0.00%</b>')
    expect(lines.join('\n')).not.toContain('Market Cap')
  })

  it('a pool without liquidity or 24h change: no liquidity line, no change, never $0', async () => {
    const lines = await bot({ pool: () => poolWith({ reserve_in_usd: null, price_change_percentage: null }) }).lines()
    expect(lines.some((l) => l.startsWith('💧'))).toBe(false)
    expect(lines.at(-1)).toBe('💵 Price <b>$0.0000109</b>')
    expect(lines.join('\n')).not.toMatch(/\$0(\.0+)?<\/b>/)
  })

  it('GeckoTerminal’s pool rate-limited (429): the FDV from its token answer stands; price unavailable, no liquidity line', async () => {
    const lines = await bot({ pool: () => new Response('{}', { status: 429 }) }).lines()
    expect(lines).toEqual([expect.stringMatching(/^📊 FDV <b>\$10\.88K<\/b>$/), '💵 Price unavailable'])
  })

  it('after a good read, a GeckoTerminal failure keeps the last figures (stale), not unavailable', async () => {
    let pool: () => unknown = () => gtKitsPool
    const b = bot({ pool: () => pool() })
    const fresh = await b.lines()
    pool = () => new Response('{}', { status: 429 })
    b.advance(65_000)
    expect(await b.lines()).toEqual(fresh)
  })

  it('GeckoTerminal down altogether: Market Cap and price unavailable, nothing made up', async () => {
    const lines = await bot({ gtToken: () => new Response('{}', { status: 503 }), pool: () => new Response('{}', { status: 503 }) }).lines()
    expect(lines).toEqual(['📊 Market Cap unavailable', '💵 Price unavailable'])
  })
})
