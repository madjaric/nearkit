import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import { createNearServices } from './index'
import { memoryStorage } from './stores'
import { createFakeChain, fakeWallet } from './testing/fakeChain'

/**
 * Positions and PnL end to end on real mainnet data: mort1705.tg bought SINGULARTY
 * for 1 NEAR (2026-09-29). History comes from a fake of FastNEAR's transaction
 * index serving that real transaction; prices and NEAR/USD are fixed.
 */

const SING = 'singularty.nearlytrade.near'
const ACCOUNT = 'mort1705.tg'
const BOUGHT = 69099416000669574619652n
const TX = directBuy as unknown as { transaction: { hash: string }; block_height: number; block_timestamp: string }

function setup(options: { balance?: bigint; history?: unknown[]; priceUsd?: number } = {}) {
  const chain = createFakeChain({
    accounts: { [ACCOUNT]: { amount: 10n ** 24n }, [SING]: { amount: 10n ** 24n, global: 'G' } },
    tokens: {
      [SING]: { symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18, boundsMin: 1n, totalSupply: 10n ** 27n, balances: { [ACCOUNT]: options.balance ?? BOUGHT } },
    },
  })
  const history = options.history ?? [TX]
  chain.route('https://tx.main.fastnear.com/v0/account', () => ({
    account_txs: history.map((t) => {
      const x = t as typeof TX
      return { transaction_hash: x.transaction.hash, tx_block_height: x.block_height, tx_block_timestamp: x.block_timestamp }
    }),
  }))
  chain.route('https://tx.main.fastnear.com/v0/transactions', () => ({ transactions: history }))
  const hour = Math.floor(Number(BigInt(TX.block_timestamp) / 1_000_000n) / 3_600_000) * 3_600
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/candles', () => [[hour, 4.5, 4.9, 4.6, 4.8, 1]])
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/ticker', () => ({ price: '5.00' }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/stats', () => ({ open: '5', last: '5' }))
  chain.route('https://api.rhea.finance/list-token-price', () => ({ [SING]: { price: String(options.priceUsd ?? 0.0001) } }))
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: 'fees.example.near' })
  const wallet = fakeWallet({ walletId: 'fake', walletName: 'Fake', accounts: [ACCOUNT], batch: true })
  return createNearServices({ env, network: NETWORKS.mainnet, fetch: chain.fetch, kv: memoryStorage(), wallet: async () => wallet.adapter })
}

describe('positions with PnL from on-chain history', () => {
  it('values the real buy exactly in NEAR, in USD at that hour, and marks it complete', async () => {
    const services = setup()
    await services.wallets.connect('fake')
    const positions = await services.portfolio.listPositions()
    const p = positions.find((x) => x.token.id === SING)
    expect(p?.pnlStatus).toBe('ready')
    expect(p?.pnl?.complete).toBe(true)
    expect(p?.pnl?.limitations).toEqual([])
    expect(p?.pnl?.bought.amount).toBeCloseTo(69099.416, 3)
    // 1 NEAR plus the gas mort1705.tg paid.
    expect(p?.pnl?.near.costBasis).toBeGreaterThan(1)
    expect(p?.pnl?.near.costBasis).toBeLessThan(1.01)
    // USD at the hour's close, 4.80.
    expect(p?.pnl?.usd.costBasis).toBeCloseTo((p?.pnl?.near.costBasis ?? 0) * 4.8, 6)
    // Value now: 69,099.4 × $0.0001 = $6.91; unrealized = value − cost.
    expect(p?.valueUsd).toBeCloseTo(6.9099, 3)
    expect(p?.pnlUsd).toBeCloseTo(6.9099416 - (p?.costUsd ?? 0), 4)
    expect(p?.avgEntryUsd).toBeCloseTo((p?.costUsd ?? 0) / 69099.416, 9)
    expect(p?.pnl?.history.map((h) => [h.kind, h.tx])).toEqual([['buy', TX.transaction.hash]])
  })

  it('says history is incomplete when the chain balance is bigger than the history explains', async () => {
    const services = setup({ balance: BOUGHT * 2n })
    await services.wallets.connect('fake')
    const p = (await services.portfolio.listPositions()).find((x) => x.token.id === SING)
    expect(p?.balance).toBeCloseTo(138198.83, 1)
    expect(p?.pnl?.complete).toBe(false)
    expect(p?.pnl?.limitations).toContain('history-incomplete')
  })

  it('reports PnL in USD on mainnet from the same engine', async () => {
    const services = setup({ priceUsd: 0.0002 })
    await services.wallets.connect('fake')
    const report = await services.portfolio.getPnl('all')
    expect(report?.source).toBe('chain')
    expect(report?.currency).toBe('USD')
    expect(report?.trades).toBe(0)
    expect(report?.realizedUsd).toBe(0)
    const sing = report?.byToken.find((t) => t.token.id === SING)
    expect(sing?.trades).toBe(1)
    expect(sing?.unrealizedUsd).toBeCloseTo(69099.416 * 0.0002 - (sing ? 0 : 0) - 1.0 * 4.8, 1)
    expect(report?.gasNear).toBeGreaterThan(0)
  })

  it('without history, positions still show balances and say PnL is unavailable rather than zero', async () => {
    const services = setup({ history: [] })
    await services.wallets.connect('fake')
    const p = (await services.portfolio.listPositions()).find((x) => x.token.id === SING)
    expect(p?.balance).toBeGreaterThan(0)
    expect(p?.pnl?.complete).toBe(false)
    expect(p?.pnl?.limitations).toContain('history-incomplete')
    expect(p?.pnlUsd).toBeNull()
  })
})
