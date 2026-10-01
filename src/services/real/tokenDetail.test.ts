import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS, type NetworkId } from '@/config/networks'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
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
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0)
/** mort1705.tg bought SINGULARTY for 1 NEAR on mainnet (2026-09-29): the real transaction. */
const BUY = directBuy as unknown as { transaction: { hash: string }; block_height: number; block_timestamp: string }

function setup(opts: { network?: NetworkId; singPrice?: () => number; candles?: (url: URL) => unknown; index?: { txs: unknown[]; fail?: boolean } } = {}) {
  let now = T0
  const chain = createFakeChain({
    accounts: { [SING]: { amount: 10n ** 24n, global: 'G' }, [UNPRICED]: { amount: 10n ** 24n, global: 'G' } },
    tokens: {
      [SING]: { symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18, boundsMin: 1n, totalSupply: 10n ** 27n, balances: {} },
      [UNPRICED]: { symbol: 'NOPRICE', name: 'No Price', decimals: 6, boundsMin: 1n, balances: {} },
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
  // FastNEAR's transaction index: the latest transactions that touched an account, then each one in full.
  const reads = { account: [] as string[], transactions: 0 }
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
  it('NEAR: Coinbase’s closes over the chosen window, oldest first', async () => {
    const start = T0 / 1000 - 3600
    const { services, calls } = setup({
      // Coinbase answers newest first: [time, low, high, open, close, volume].
      candles: () => [
        [start + 120, 4.9, 5.1, 5.0, 5.05, 1],
        [start + 60, 4.8, 5.0, 4.9, 4.95, 1],
        [start, 4.7, 4.9, 4.8, 4.85, 1],
      ],
    })
    const h = await services.tokens.getPriceHistory('near', '1H')
    expect(h).toEqual([
      { t: start * 1000, usd: 4.85 },
      { t: (start + 60) * 1000, usd: 4.95 },
      { t: (start + 120) * 1000, usd: 5.05 },
    ])
    // One-minute candles for the last hour.
    expect(calls[0]).toContain('granularity=60')
    expect(calls[0]).toContain(`start=${new Date(T0 - 3_600_000).toISOString()}`)
  })

  it('the longer windows use coarser candles: 4H by five minutes, 1D by fifteen', async () => {
    const { services, calls } = setup({ candles: () => [] })
    await services.tokens.getPriceHistory('near', '4H')
    await services.tokens.getPriceHistory('near', '1D')
    expect(calls[0]).toContain('granularity=300')
    expect(calls[1]).toContain('granularity=900')
  })

  it('drops malformed candles instead of repairing them', async () => {
    const { services } = setup({
      candles: () => [
        [T0 / 1000, 1, 2, 1, 0, 1],
        ['x', 1, 2, 1, 5, 1],
        [T0 / 1000 - 60, 1, 2, 1, 4.9, 1],
      ],
    })
    expect(await services.tokens.getPriceHistory('near', '5m')).toEqual([{ t: T0 - 60_000, usd: 4.9 }])
  })

  it('a token has no history source: null, and nothing is filled in', async () => {
    const { services, calls } = setup()
    expect(await services.tokens.getPriceHistory(SING, '1D')).toBeNull()
    expect(calls).toEqual([])
  })

  it('a failed history read is empty, not invented', async () => {
    const { services } = setup({
      candles: () => {
        throw new Error('down')
      },
    })
    expect(await services.tokens.getPriceHistory('near', '15m')).toEqual([])
  })

  it('testnet has no price history', async () => {
    const { services } = setup({ network: 'testnet' })
    expect(await services.tokens.getPriceHistory('near', '1H')).toBeNull()
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
