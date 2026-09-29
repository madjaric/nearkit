import { describe, expect, it } from 'vitest'
import findPathSingle from '@/services/rhea/fixtures/findpath-testnet-wrap-usdt.json'
import { accountsModule } from './accounts'
import type { Command } from './context'
import { coreModule } from './core'
import { settingsModule } from './settings'
import { ALICE, botHarness } from './testing'
import { tradeModule } from './trade'

const ONE = 10n ** 24n
const USDT = 'usdt.itachicara.testnet'
const FRESH = 'fresh.nearlytrade.testnet'

async function bot(options: { noRoute?: boolean; link?: boolean } = {}) {
  let list: () => { name: string; command: Command }[] = () => []
  const h = await botHarness({
    chain: {
      accounts: {
        'alice.testnet': { amount: 5n * ONE },
        [USDT]: { amount: ONE, code: true },
        [FRESH]: { amount: ONE, global: 'GlobalToken111' },
        'wrap.testnet': { amount: ONE, code: true },
      },
      tokens: {
        [USDT]: { symbol: 'USDT', name: 'Tether USD', decimals: 24, boundsMin: 1n, balances: { 'alice.testnet': 100n * ONE }, registered: ['alice.testnet'] },
        'wrap.testnet': { symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, boundsMin: 1n },
        [FRESH]: { symbol: 'FRESH', name: 'Fresh Launch', decimals: 18, boundsMin: 1n, totalSupply: 10n ** 27n },
      },
    },
    modules: () => [coreModule(() => list(), {}), accountsModule(), settingsModule(), tradeModule()],
  })
  list = () => h.app.commands()
  // Rhea's testnet router, answering each request with a route that matches it (pool 1352's rate).
  h.chain.route('https://smartroutertest.refburrow.top/findPath', (url) => {
    if (options.noRoute) return { result_code: 1, result_message: 'no path', result_data: null }
    const amountIn = url.searchParams.get('amountIn') ?? '0'
    const tokenIn = url.searchParams.get('tokenIn') ?? ''
    const tokenOut = url.searchParams.get('tokenOut') ?? ''
    if (amountIn === '1000000000000000000000000' && tokenIn === 'wrap.testnet') return findPathSingle
    const out = tokenIn === 'wrap.testnet' ? (BigInt(amountIn) * 4039n) / 1000n : (BigInt(amountIn) * 1000n) / 4039n
    const min = (out * 995n) / 1000n
    return {
      result_code: 0,
      result_message: '',
      result_data: {
        routes: [
          {
            pools: [{ pool_id: '1352', token_in: tokenIn, token_out: tokenOut, amount_in: amountIn, amount_out: '0', min_amount_out: String(min) }],
            amount_in: amountIn,
            min_amount_out: String(min),
            amount_out: '0',
          },
        ],
        contract_in: tokenIn,
        contract_out: tokenOut,
        amount_in: amountIn,
        amount_out: String(out),
      },
    }
  })
  if (options.link !== false) {
    h.store.upsertUser({ userId: ALICE.id, username: 'alice', firstName: 'Alice', languageCode: null })
    h.store.createLinkRequest({ codeHash: 'h', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    h.store.completeLink({ codeHash: 'h', network: 'testnet', accountId: 'alice.testnet', userId: ALICE.id, publicKey: 'ed25519:K' })
    h.store.updateSettings(ALICE.id, { defaultAccount: 'alice.testnet' })
  }
  return h
}

describe('trading from Telegram', () => {
  it('asks to link a wallet first', async () => {
    const h = await bot({ link: false })
    await h.say('/buy')
    expect(h.last()?.text).toContain('Link a NEAR account first')
    expect(h.buttons()[0]?.data).toBe('acct:link')
  })

  it('buys step by step: token by symbol, a preset amount, then a real Rhea quote and a link to sign in NearKit', async () => {
    const h = await bot()
    await h.say('/buy')
    expect(h.last()?.text).toContain('which token?')
    await h.say('usdt')
    const ask = h.last()
    expect(ask?.text).toContain('USDT')
    expect(ask?.text).toContain(USDT)
    expect(ask?.text).toContain('alice.testnet')
    expect(ask?.text).toMatch(/5(\.\d+)? NEAR available|NEAR available/)
    const one = h.buttons().find((b) => b.text === '1 NEAR')
    await h.press(one?.data ?? '')
    const quote = h.last()
    expect(quote?.text).toContain('Buy USDT with 1 NEAR')
    expect(quote?.text).toContain('You get ≈')
    expect(quote?.text).toContain('Route: NEAR → USDT')
    expect(quote?.text).toContain('No NearKit fee on testnet')
    expect(quote?.text).toContain('This is a quote, not a trade')
    const sign = h.buttons().find((b) => b.text.startsWith('✍️'))
    expect(sign?.url).toMatch(new RegExp(`^https://nearkit\\.vercel\\.app/swap\\?from=near&to=${USDT.replace(/\./g, '\\.')}&amount=1&slippage=1&tg=[A-Za-z0-9_-]{22}$`))
    const id = new URL(sign?.url ?? 'x:').searchParams.get('tg') as string
    expect(h.deps.handoffs.get(id)).toMatchObject({ accountId: 'alice.testnet', side: 'buy', tokenIn: 'near', tokenOut: USDT, amountIn: '1', status: 'open' })
  })

  it('quotes directly from one line and uses the saved slippage', async () => {
    const h = await bot()
    h.store.updateSettings(ALICE.id, { slippagePct: 3 })
    await h.say(`/buy ${USDT} 0.5`)
    expect(h.last()?.text).toContain('Buy USDT with 0.5 NEAR')
    expect(h.last()?.text).toContain('with 3% slippage')
  })

  it('sells a share of the balance', async () => {
    const h = await bot()
    await h.say('/sell USDT 50%')
    expect(h.last()?.text).toContain('Sell USDT · 50 USDT')
    const sign = h.buttons().find((b) => b.text.startsWith('✍️'))
    expect(sign?.url).toContain(`from=${USDT}&to=near&amount=50&`)
  })

  it('refuses more than the account has', async () => {
    const h = await bot()
    await h.say(`/buy ${USDT} 50`)
    expect(h.last()?.text).toContain('less than 50 NEAR')
    expect(h.buttons().find((b) => b.text.startsWith('✍️'))).toBeUndefined()
  })

  it('says so plainly when Rhea has no route, and prepares nothing', async () => {
    const h = await bot({ noRoute: true })
    await h.say(`/buy ${USDT} 1`)
    expect(h.last()?.text).toContain('Rhea found no route')
    expect(h.last()?.text).toContain('Nothing was prepared')
    expect(h.store.db.all('SELECT * FROM handoffs')).toEqual([])
  })

  it('finds a brand-new token by its exact contract, as the web app does', async () => {
    const h = await bot()
    await h.say(`/buy ${FRESH}`)
    expect(h.last()?.text).toContain('FRESH')
    expect(h.last()?.text).toContain('How much NEAR?')
    expect(h.store.userTokens(ALICE.id, 'testnet')).toEqual([FRESH])
  })

  it('refuses amounts that are not numbers', async () => {
    const h = await bot()
    await h.say('/buy usdt')
    await h.say('lots')
    expect(h.last()?.text).toContain('is not an amount above 0')
  })

  it('shows a token card and balances read from chain', async () => {
    const h = await bot()
    await h.say(`/token ${USDT}`)
    const card = h.last()?.text ?? ''
    expect(card).toContain('Tether USD')
    expect(card).toContain('Decimals: 24')
    expect(card).toContain('You hold: 100 USDT')
    await h.say('/balance')
    expect(h.last()?.text).toContain('Balances · alice.testnet')
    expect(h.last()?.text).toContain('100 <b>USDT</b>')
  })

  it('limits how often one user can ask Rhea for quotes', async () => {
    const h = await bot()
    for (let i = 0; i < 7; i++) await h.say(`/buy ${USDT} 0.1`)
    expect(h.last()?.text).toContain('Too many quotes')
  })
})
