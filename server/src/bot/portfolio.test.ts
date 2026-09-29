import { describe, expect, it } from 'vitest'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import type { Command } from './context'
import { coreModule } from './core'
import { portfolioModule } from './portfolio'
import { ALICE, botHarness } from './testing'

const SING = 'singularty.nearlytrade.near'
const ACCOUNT = 'mort1705.tg'
const TX = directBuy as unknown as { transaction: { hash: string }; block_height: number; block_timestamp: string }

async function bot(options: { link?: boolean; network?: 'mainnet' | 'testnet' } = {}) {
  let list: () => { name: string; command: Command }[] = () => []
  const network = options.network ?? 'mainnet'
  const h = await botHarness({
    env: { NEAR_NETWORK: network, ...(network === 'mainnet' ? { NEARKIT_FEE_RECIPIENT: 'fees.example.near' } : {}) },
    chain: {
      accounts: { [ACCOUNT]: { amount: 10n ** 24n }, [SING]: { amount: 10n ** 24n, global: 'G' } },
      tokens: {
        [SING]: { symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18, boundsMin: 1n, totalSupply: 10n ** 27n, balances: { [ACCOUNT]: 69099416000669574619652n } },
      },
    },
    modules: () => [coreModule(() => list(), {}), portfolioModule()],
  })
  list = () => h.app.commands()
  const host = network === 'mainnet' ? 'https://tx.main.fastnear.com' : 'https://tx.test.fastnear.com'
  h.chain.route(`${host}/v0/account`, () => ({
    account_txs: [{ transaction_hash: TX.transaction.hash, tx_block_height: TX.block_height, tx_block_timestamp: TX.block_timestamp }],
  }))
  h.chain.route(`${host}/v0/transactions`, () => ({ transactions: [TX] }))
  const hour = Math.floor(Number(BigInt(TX.block_timestamp) / 1_000_000n) / 3_600_000) * 3_600
  h.chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/candles', () => [[hour, 4.5, 4.9, 4.6, 4.8, 1]])
  h.chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/ticker', () => ({ price: '5.00' }))
  h.chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/stats', () => ({ open: '5', last: '5' }))
  h.chain.route('https://api.rhea.finance/list-token-price', () => ({ [SING]: { price: '0.0001' } }))
  if (options.link !== false) {
    h.store.upsertUser({ userId: ALICE.id, username: 'alice', firstName: 'Alice', languageCode: null })
    h.store.createLinkRequest({ codeHash: 'h', userId: ALICE.id, network, nonce: 'n', message: 'm', ttlMs: 60_000 })
    h.store.completeLink({ codeHash: 'h', network, accountId: ACCOUNT, userId: ALICE.id, publicKey: 'ed25519:K' })
  }
  return h
}

describe('/positions and /pnl in Telegram', () => {
  it('asks to link an account first', async () => {
    const h = await bot({ link: false })
    await h.say('/positions')
    expect(h.last()?.text).toContain('Link a NEAR account first')
  })

  it('shows holdings valued now, with unrealized PnL from the real buy', async () => {
    const h = await bot()
    await h.say('/positions')
    const text = h.last()?.text ?? ''
    expect(text).toContain(`Positions · ${ACCOUNT}`)
    expect(text).toContain('<b>SINGULARTY</b> 69.1K ≈ $6.91')
    // Cost: ~1.0024 NEAR × $4.80 ≈ $4.81; value $6.91 → about +$2.10.
    expect(text).toMatch(/unrealized \+\$2\.\d\d \(\+4\d\.\d%\)/)
    expect(text).not.toContain('partial')
    expect(h.buttons().find((b) => b.url)?.url).toBe('https://nearkit.vercel.app/positions')
  })

  it('reports PnL from the same engine, with gas and no invented sales', async () => {
    const h = await bot()
    await h.say('/pnl')
    const text = h.last()?.text ?? ''
    expect(text).toContain('PnL · all time')
    expect(text).toContain('Realized: <b>$0.00</b> over 0 sales')
    expect(text).toMatch(/Unrealized now: <b>\+\$2\.\d\d<\/b>/)
    expect(text).toMatch(/Gas paid \(all history\): 0\.00\d+ NEAR/)
    await h.press('pf:pnl7d')
    expect(h.last()?.text).toContain('PnL · last 7d')
  })

  it('on testnet, without USD prices, speaks NEAR', async () => {
    const h = await bot({ network: 'testnet' })
    await h.say('/pnl')
    expect(h.last()?.text).toContain('in NEAR (no USD prices on this network)')
  })
})
