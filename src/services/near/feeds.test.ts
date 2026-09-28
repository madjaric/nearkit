import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { discoverFtHoldings } from './discovery'
import { explorerAccountUrl, explorerTokenUrl, explorerTxUrl } from './explorer'
import { fetchNearUsd, fetchTokenPrices } from './prices'

type Route = (url: string) => { status?: number; json?: unknown; throws?: boolean }

const fakeFetch = (route: Route) => {
  const urls: string[] = []
  const fn = async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const r = route(url)
    if (r.throws) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.json ?? null), { status: r.status ?? 200 })
  }
  return { fetch: fn as typeof fetch, urls }
}

describe('discoverFtHoldings', () => {
  it('lists contracts with a non-zero balance from FastNEAR and drops the rest', async () => {
    const { fetch, urls } = fakeFetch(() => ({
      json: {
        account_id: 'alice.near',
        tokens: [
          { contract_id: 'usdt.tether-token.near', balance: '5000000', last_update_block_height: 1 },
          { contract_id: 'old.token.near', balance: '0', last_update_block_height: 1 },
          { contract_id: 'broken.token.near', balance: '', last_update_block_height: 1 },
          { contract_id: 'pending.token.near', balance: null, last_update_block_height: null },
          { contract_id: 'Not Valid', balance: '7', last_update_block_height: 1 },
        ],
      },
    }))
    const found = await discoverFtHoldings(fetch, NETWORKS.mainnet, 'alice.near')
    expect(found).toEqual([{ contract: 'usdt.tether-token.near', raw: 5_000_000n }])
    expect(urls[0]).toBe('https://api.fastnear.com/v1/account/alice.near/ft')
  })

  it('falls back to NearBlocks v3 on mainnet when FastNEAR fails', async () => {
    const { fetch, urls } = fakeFetch((url) => (url.includes('fastnear') ? { status: 503 } : { json: { data: [{ contract: 'wrap.near', amount: '42' }], meta: {} } }))
    expect(await discoverFtHoldings(fetch, NETWORKS.mainnet, 'alice.near')).toEqual([{ contract: 'wrap.near', raw: 42n }])
    expect(urls[1]).toBe('https://api.nearblocks.io/v3/accounts/alice.near/assets/fts?limit=100')
  })

  it('uses the NearBlocks v1 inventory as the testnet fallback', async () => {
    const { fetch, urls } = fakeFetch((url) =>
      url.includes('fastnear') ? { throws: true } : { json: { inventory: { fts: [{ contract: 'wrap.testnet', amount: '9' }], nfts: [] } } },
    )
    expect(await discoverFtHoldings(fetch, NETWORKS.testnet, 'alice.testnet')).toEqual([{ contract: 'wrap.testnet', raw: 9n }])
    expect(urls[1]).toBe('https://api-testnet.nearblocks.io/v1/account/alice.testnet/inventory')
  })

  it('reports failure when every source fails', async () => {
    const { fetch } = fakeFetch(() => ({ status: 500 }))
    await expect(discoverFtHoldings(fetch, NETWORKS.testnet, 'alice.testnet')).rejects.toMatchObject({ code: 'RPC_ERROR' })
  })
})

describe('prices', () => {
  it('reads Rhea token prices and ignores malformed rows', async () => {
    const { fetch } = fakeFetch(() => ({
      json: {
        'wrap.near': { price: '5.09', symbol: 'wNEAR', decimal: 24 },
        'usdt.tether-token.near': { price: '0.999694', symbol: 'USDt', decimal: 6 },
        'junk.near': { price: 'NaN', symbol: 'J', decimal: 18 },
        'zero.near': { price: '0', symbol: 'Z', decimal: 18 },
      },
    }))
    const prices = await fetchTokenPrices(fetch, 'https://api.rhea.finance')
    expect(prices.get('wrap.near')).toBe(5.09)
    expect(prices.get('usdt.tether-token.near')).toBe(0.999694)
    expect(prices.has('junk.near')).toBe(false)
    expect(prices.has('zero.near')).toBe(false)
  })

  it('reads NEAR/USD and its 24h change from Coinbase, CoinGecko as fallback', async () => {
    const coinbase = fakeFetch((url) => (url.endsWith('/ticker') ? { json: { price: '5.10' } } : { json: { open: '5.00', last: '5.10' } }))
    const cb = await fetchNearUsd(coinbase.fetch, NETWORKS.mainnet.nearUsd)
    expect(cb?.priceUsd).toBe(5.1)
    expect(cb?.change24hPct).toBeCloseTo(2, 9)
    const gecko = fakeFetch((url) => (url.includes('coinbase') ? { status: 500 } : { json: { near: { usd: 5.2, usd_24h_change: -1.5 } } }))
    expect(await fetchNearUsd(gecko.fetch, NETWORKS.mainnet.nearUsd)).toMatchObject({ priceUsd: 5.2, change24hPct: -1.5 })
    expect(await fetchNearUsd(gecko.fetch, null)).toBeNull()
  })
})

describe('explorer links', () => {
  it('points at the network’s own explorer', () => {
    expect(explorerTxUrl(NETWORKS.testnet, 'ABC')).toBe('https://testnet.nearblocks.io/txns/ABC')
    expect(explorerAccountUrl(NETWORKS.mainnet, 'alice.near')).toBe('https://nearblocks.io/address/alice.near')
    expect(explorerTokenUrl(NETWORKS.mainnet, 'wrap.near')).toBe('https://nearblocks.io/tokens/wrap.near')
  })
})
