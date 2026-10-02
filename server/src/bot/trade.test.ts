import { describe, expect, it } from 'vitest'
import findPathSingle from '@/services/rhea/fixtures/findpath-testnet-wrap-usdt.json'
import { accountsModule } from './accounts'
import type { Command } from './context'
import { coreModule } from './core'
import { settingsModule } from './settings'
import { ALICE, botHarness, GROUP } from './testing'
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
    await h.store.upsertUser({ userId: ALICE.id, username: 'alice', firstName: 'Alice', languageCode: null })
    await h.store.createLinkRequest({ codeHash: 'h', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    await h.store.completeLink({ codeHash: 'h', network: 'testnet', accountId: 'alice.testnet', userId: ALICE.id, publicKey: 'ed25519:K' })
    await h.store.updateSettings(ALICE.id, { defaultAccount: 'alice.testnet' })
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
    expect(ask?.text).toContain('<b>Buy USDT</b>')
    expect(ask?.text).toContain(USDT)
    expect(ask?.text).toContain('Wallet <code>alice.testnet</code>')
    expect(ask?.text).toContain('Balance <b>5 NEAR</b>')
    expect(h.buttons().map((b) => b.text)).toEqual(['0.1 NEAR', '0.5 NEAR', '1 NEAR', 'MAX · 4.95', '✏️ Custom', '✖ Cancel'])
    const one = h.buttons().find((b) => b.text === '1 NEAR')
    await h.press(one?.data ?? '')
    const quote = h.last()
    expect(quote?.text).toContain('You pay <b>1 NEAR</b>')
    expect(quote?.text).toContain('You receive <b>≈')
    expect(quote?.text).toContain('Minimum ')
    expect(quote?.text).toContain('Route NEAR → USDT')
    expect(quote?.text).toContain('NearKit fee none on testnet')
    expect(quote?.text).toMatch(/⏱ Quote for \d+s/)
    const sign = h.buttons().find((b) => b.text.startsWith('✍️'))
    expect(sign?.url).toMatch(new RegExp(`^https://nearkit\\.vercel\\.app/swap\\?from=near&to=${USDT.replace(/\./g, '\\.')}&amount=1&slippage=1&tg=[A-Za-z0-9_-]{22}$`))
    const id = new URL(sign?.url ?? 'x:').searchParams.get('tg') as string
    expect(await h.deps.handoffs.get(id)).toMatchObject({ accountId: 'alice.testnet', side: 'buy', tokenIn: 'near', tokenOut: USDT, amountIn: '1', status: 'open' })
  })

  it('quotes directly from one line and uses the saved slippage', async () => {
    const h = await bot()
    await h.store.updateSettings(ALICE.id, { slippagePct: 3 })
    await h.say(`/buy ${USDT} 0.5`)
    expect(h.last()?.text).toContain('You pay <b>0.5 NEAR</b>')
    expect(h.last()?.text).toContain('· 3% slippage')
  })

  it('sells a share of the balance', async () => {
    const h = await bot()
    await h.say('/sell USDT 50%')
    expect(h.last()?.text).toContain('<b>Sell USDT</b>')
    expect(h.last()?.text).toContain('You pay <b>50 USDT</b>')
    const sign = h.buttons().find((b) => b.text.startsWith('✍️'))
    expect(sign?.url).toContain(`from=${USDT}&to=near&amount=50&`)
  })

  it('refuses more than the account has', async () => {
    const h = await bot()
    await h.say(`/buy ${USDT} 50`)
    expect(h.last()?.text).toContain('Not enough NEAR for this trade plus gas')
    expect(h.last()?.text).toContain('less than 50 NEAR')
    expect(h.buttons().find((b) => b.text.startsWith('✍️'))).toBeUndefined()
  })

  it('says so plainly when Rhea has no route, and prepares nothing', async () => {
    const h = await bot({ noRoute: true })
    await h.say(`/buy ${USDT} 1`)
    expect(h.last()?.text).toMatch(/Rhea’s (router|aggregator) refused this quote \(code 1: no path\)/)
    expect(h.last()?.text).toContain('Nothing was prepared')
    expect(await h.store.db.all('SELECT * FROM handoffs')).toEqual([])
  })

  it('finds a brand-new token by its exact contract, as the web app does', async () => {
    const h = await bot()
    await h.say(`/buy ${FRESH}`)
    expect(h.last()?.text).toContain('FRESH')
    expect(h.last()?.text).toContain('How much NEAR?')
    expect(await h.store.userTokens(ALICE.id, 'testnet')).toEqual([FRESH])
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
    expect(card).toContain('24 decimals')
    expect(card).toContain('You hold <b>100 USDT</b>')
    expect(h.buttons().find((b) => b.text === '🔗 Explorer')?.url).toContain(USDT)
    await h.say('/balance')
    const wallet = h.last()?.text ?? ''
    expect(wallet).toContain('<b>Wallet</b>\n<code>alice.testnet</code>')
    expect(wallet).toContain('<b>5.00</b> NEAR')
    expect(wallet).toContain('100 <b>USDT</b>')
    // Where a balance was read from is a detail, not the first screen.
    expect(wallet).not.toContain('indexer')
    await h.say('/balance details')
    expect(h.last()?.text).toContain(`<code>${USDT}</code>`)
  })

  it('/start shows the linked wallet and its NEAR, and the full menu', async () => {
    const h = await bot()
    await h.say('/start')
    const m = h.last()
    expect(m?.text).toContain('👛 <code>alice.testnet</code> · 5.00 NEAR')
    expect(m?.buttons.map((b) => b.text)).toEqual(['🟢 Buy', '🔴 Sell', '👛 Wallet', '⚙️ Settings', '❓ Help'])
  })

  it('MAX spends the balance minus a reserve for gas', async () => {
    const h = await bot()
    await h.say('/buy usdt')
    await h.press(h.buttons().find((b) => b.text.startsWith('MAX'))?.data ?? '')
    expect(h.last()?.text).toContain('You pay <b>4.95 NEAR</b>')
  })

  it('Custom asks for an amount, and a typed amount is quoted', async () => {
    const h = await bot()
    await h.say('/buy usdt')
    await h.press('tr:custom')
    expect(h.last()?.text).toContain('Send the amount')
    await h.say('0.25')
    expect(h.last()?.text).toContain('You pay <b>0.25 NEAR</b>')
  })

  it('sells by share of the balance: 25, 50, 75 or 100%', async () => {
    const h = await bot()
    await h.say('/sell usdt')
    expect(h.last()?.text).toContain('Balance <b>100 USDT</b>')
    expect(h.buttons().map((b) => b.text)).toEqual(['25%', '50%', '75%', '100%', '✏️ Custom', '✖ Cancel'])
    await h.press(h.buttons().find((b) => b.text === '75%')?.data ?? '')
    expect(h.last()?.text).toContain('You pay <b>75 USDT</b>')
  })

  it('selling a token the wallet does not hold says so, with nothing to press', async () => {
    const h = await bot()
    await h.say(`/sell ${FRESH}`)
    expect(h.last()?.text).toContain('You don’t hold any FRESH in this wallet.')
    expect(h.buttons().map((b) => b.text)).toEqual(['« Menu'])
  })

  it('a double tap on an amount prepares one trade, not two', async () => {
    const h = await bot()
    await h.say('/buy usdt')
    const one = h.buttons().find((b) => b.text === '1 NEAR')?.data ?? ''
    await h.press(one)
    await h.press(one)
    expect(await h.store.db.all('SELECT * FROM handoffs')).toHaveLength(1)
    const toast = h.fake.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.params as { text?: string }
    expect(toast.text).toContain('Already on it')
  })

  it('an expired or unknown button says so instead of acting', async () => {
    const h = await bot()
    await h.press('tr:amt:nosuchbutton')
    const toast = h.fake.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.params as { text?: string; show_alert?: boolean }
    expect(toast.text).toContain('That button expired')
    expect(await h.store.db.all('SELECT * FROM handoffs')).toEqual([])
  })

  it('Cancel stops the trade and says nothing was prepared', async () => {
    const h = await bot()
    await h.say('/buy usdt')
    await h.press('tr:cancel')
    expect(h.last()?.text).toContain('Cancelled. Nothing was prepared or signed.')
    await h.say('0.5')
    // The amount step is gone: typing a number no longer starts a quote.
    expect(await h.store.db.all('SELECT * FROM handoffs')).toEqual([])
  })

  it('a mainnet contract on testnet is refused in plain words', async () => {
    const h = await bot()
    await h.say('/buy singularty.nearlytrade.near')
    expect(h.last()?.text).toContain('This belongs to NEAR mainnet while NearKit is using testnet.')
  })

  it('limits how often one user can ask Rhea for quotes', async () => {
    const h = await bot()
    for (let i = 0; i < 7; i++) await h.say(`/buy ${USDT} 0.1`)
    expect(h.last()?.text).toContain('Too many quotes')
  })
})

describe('a pasted contract', () => {
  it('opens the buy flow for that token at its amount step, prepares nothing, and adds the token to the user’s list', async () => {
    const h = await bot()
    await h.say(FRESH)
    const ask = h.last()
    expect(ask?.text).toContain('<b>Buy FRESH</b>')
    expect(ask?.text).toContain('How much NEAR?')
    expect(h.buttons().map((b) => b.text)).toContain('✖ Cancel')
    expect(await h.store.db.all('SELECT * FROM handoffs')).toEqual([])
    expect(await h.store.userTokens(ALICE.id, 'testnet')).toEqual([FRESH])
  })

  it('a token Rhea does not route still opens the buy flow; the quote says why and prepares nothing', async () => {
    const h = await bot({ noRoute: true })
    await h.say(USDT)
    expect(h.last()?.text).toContain('<b>Buy USDT</b>')
    await h.press(h.buttons().find((b) => b.text === '1 NEAR')?.data ?? '')
    expect(h.last()?.text).toMatch(/Rhea’s (router|aggregator) refused this quote \(code 1: no path\)/)
    expect(await h.store.db.all('SELECT * FROM handoffs')).toEqual([])
  })

  it('an address that is no token says so, and waits for nothing', async () => {
    const h = await bot()
    await h.say('nobody.testnet')
    expect(h.last()?.text).toContain('Token not found')
    expect(h.last()?.text).not.toContain('/help')
    // No step was left waiting: the next message is not read as a token.
    await h.say('hello')
    expect(h.last()?.text).toContain('Send /help to see what I can do')
  })

  it('arbitrary text, including a bare symbol, still gets the help pointer', async () => {
    const h = await bot()
    await h.say('what can you do')
    expect(h.last()?.text).toContain('Send /help to see what I can do')
    await h.say('USDT')
    expect(h.last()?.text).toContain('Send /help to see what I can do')
    expect(h.fake.messages()).toHaveLength(2)
  })

  it('asks to link a wallet first, as /buy does', async () => {
    const h = await bot({ link: false })
    await h.say(FRESH)
    expect(h.last()?.text).toContain('Link a NEAR account first')
  })

  it('is ignored in a group', async () => {
    const h = await bot()
    await h.say(FRESH, ALICE, GROUP)
    expect(h.fake.messages()).toHaveLength(0)
  })

  it('a step that is waiting for text keeps it', async () => {
    const h = await bot()
    await h.say('/sell')
    await h.say(USDT)
    expect(h.last()?.text).toContain('<b>Sell USDT</b>')
  })
})
