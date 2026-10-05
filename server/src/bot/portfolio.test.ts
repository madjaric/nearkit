import { describe, expect, it } from 'vitest'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import type { Command } from './context'
import { coreModule } from './core'
import { portfolioModule } from './portfolio'
import { ALICE, botHarness } from './testing'

const SING = 'singularty.nearlytrade.near'
const ACCOUNT = 'mort1705.tg'
const TX = directBuy as unknown as { transaction: { hash: string }; block_height: number; block_timestamp: string }

async function bot(options: { link?: boolean; network?: 'mainnet' | 'testnet'; history?: boolean } = {}) {
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
  const txs = options.history === false ? [] : [TX]
  h.chain.route(`${host}/v0/account`, () => ({
    account_txs: txs.map((t) => ({ transaction_hash: t.transaction.hash, tx_block_height: t.block_height, tx_block_timestamp: t.block_timestamp })),
  }))
  h.chain.route(`${host}/v0/transactions`, () => ({ transactions: txs }))
  const hour = Math.floor(Number(BigInt(TX.block_timestamp) / 1_000_000n) / 3_600_000) * 3_600
  h.chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/candles', () => [[hour, 4.5, 4.9, 4.6, 4.8, 1]])
  h.chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/ticker', () => ({ price: '5.00' }))
  h.chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/stats', () => ({ open: '5', last: '5' }))
  h.chain.route('https://api.rhea.finance/list-token-price', () => ({ [SING]: { price: '0.0001' } }))
  if (options.link !== false) {
    await h.store.upsertUser({ userId: ALICE.id, username: 'alice', firstName: 'Alice', languageCode: null })
    await h.store.createLinkRequest({ codeHash: 'h', userId: ALICE.id, network, nonce: 'n', message: 'm', ttlMs: 60_000 })
    await h.store.completeLink({ codeHash: 'h', network, accountId: ACCOUNT, userId: ALICE.id, publicKey: 'ed25519:K' })
  }
  return h
}

describe('/positions and /pnl in Telegram', () => {
  it('asks to link an account first', async () => {
    const h = await bot({ link: false })
    await h.say('/positions')
    expect(h.last()?.text).toContain('Link a NEAR account or create a NearKit wallet first')
  })

  it('shows holdings valued now, with unrealized PnL from the real buy', async () => {
    const h = await bot()
    await h.say('/positions')
    const text = h.last()?.text ?? ''
    expect(text).toContain(`<b>Positions</b> · <code>${ACCOUNT}</code>`)
    expect(text).toContain('<b>SINGULARTY</b> · 69.1K ≈ $6.91')
    // Cost: ~1.0024 NEAR × $4.80 ≈ $4.81; value $6.91 → about +$2.10.
    expect(text).toMatch(/PnL \+\$2\.\d\d \(\+4\d\.\d%\)/)
    expect(text).not.toContain('partial')
    // The method and sources wait behind Details.
    expect(text).not.toContain('Average cost')
    await h.press('pf:posdetails')
    const details = h.last()?.text ?? ''
    expect(details).toMatch(/Cost \$4\.8\d · avg entry/)
    expect(details).toContain('Average cost from your on-chain history')
    expect(h.buttons().find((b) => b.url)?.url).toBe('https://nearkits.com/positions')
  })

  it('reports PnL from the same engine, with gas and no invented sales', async () => {
    const h = await bot()
    await h.say('/pnl')
    const text = h.last()?.text ?? ''
    expect(text).toContain('<b>PnL</b> · all time')
    expect(text).toContain('Realized <b>$0.00</b> · 0 sales')
    expect(text).toMatch(/Unrealized <b>\+\$2\.\d\d<\/b>/)
    expect(text).toMatch(/Gas 0\.00\d+ NEAR/)
    await h.press('pf:pnl7d')
    expect(h.last()?.text).toContain('<b>PnL</b> · last 7d')
    await h.press('pf:pnlalld')
    expect(h.last()?.text).toContain('Gas counted over the whole history, 1 transaction.')
  })

  it('a holding the history does not explain makes /pnl say it is partial', async () => {
    const h = await bot({ history: false })
    await h.say('/pnl details')
    const text = h.last()?.text ?? ''
    expect(text).toContain('doesn’t explain the whole balance')
    expect(text).toContain('Gas counted over the whole history, 0 transactions.')
  })

  it('an unknown figure reads as unknown, never as 0', async () => {
    const h = await bot()
    h.chain.route('https://api.rhea.finance/list-token-price', () => ({}))
    await h.say('/pnl')
    const text = h.last()?.text ?? ''
    expect(text).toContain('Unrealized <b>—</b> · no price')
    expect(text).not.toMatch(/Unrealized <b>[+−-]?\$0\.00<\/b>/)
  })

  it('on testnet, without USD prices, speaks NEAR', async () => {
    const h = await bot({ network: 'testnet' })
    await h.say('/pnl details')
    expect(h.last()?.text).toContain('in NEAR (no USD prices on this network)')
  })
})
