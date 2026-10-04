import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { dclPoolId } from '@/services/dcl/pools'
import type { MarketFigure, TokenMarket } from '@/types/domain'
import type { TradingWallet } from '../custody/store'
import { shortAccount } from '../telegram/html'
import { ONE, REG, USDT, WRAP, walletBot } from './walletTesting'

/**
 * The Telegram BUY screen: the token, its live market (the shared market service: DEX Screener,
 * GeckoTerminal, CoinGecko), the NearKit wallet and its balance, then the amounts and the quick
 * actions. A market cap no source knows is said to be unavailable, never made up.
 */

type Harness = Awaited<ReturnType<typeof walletBot>>

const known = (value: number, source = 'DEX Screener'): MarketFigure => ({ state: 'known', value, source, at: 0 })
const missing = (reason: string): MarketFigure => ({ state: 'unavailable', reason })

/** Figures as the shared market service returns them. */
function marketOf(tokenId: string, over: Partial<TokenMarket> = {}): TokenMarket {
  return {
    tokenId,
    priceUsd: known(0.0004737),
    priceNear: known(0.00021),
    change24hPct: known(-3.2),
    marketCapUsd: known(474_000, 'CoinGecko'),
    fdvUsd: known(500_000),
    liquidityUsd: known(43_626),
    volume24hUsd: known(12_000),
    supply: { circulating: 1e9, total: 1e9, source: 'CoinGecko' },
    pair: { id: 'refv2-usdt', dex: 'Rhea', baseSymbol: 'USDT', quoteSymbol: 'wNEAR', createdAt: null, url: null, txns24h: null },
    updatedAt: 0,
    ...over,
  }
}

/** The market the bot reads next (or a read that fails). */
function serve(h: Harness, market: TokenMarket | Error) {
  h.deps.near.tokens.getMarketData = async () => {
    if (market instanceof Error) throw market
    return market
  }
}

async function buyScreen(h: Harness, token = 'USDT'): Promise<string> {
  await h.say('/buy')
  await h.say(token)
  return h.last()?.text ?? ''
}

/** A second NearKit wallet, made with the bot's own Create button. */
async function newWallet(h: Harness): Promise<TradingWallet> {
  h.advance(10_000)
  await h.press('cw:list')
  await h.press(h.button('New wallet') || h.button('Create NearKit wallet'))
  return (await h.wallet()) as TradingWallet
}

describe('the Telegram BUY screen', () => {
  it('shows the token, its live market, the NearKit wallet and its balance, then the amounts and quick actions; no fee text before the quote', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    serve(h, marketOf(USDT))
    const text = await buyScreen(h)
    for (const part of [
      '🟢 <b>Buy USDT</b> · Tether USD',
      `<code>${USDT}</code>`,
      'USDT/wNEAR on Rhea',
      '📊 Market cap <b>$474K</b>',
      '💧 Liquidity <b>$43.6K</b>',
      '💵 Price <b>$0.000474</b> · 24h <b>−3.20%</b>',
      `👛 <b>Main</b> ${shortAccount(w.accountId)} · <b>3 NEAR</b>`,
      '⚙️ Slippage <b>1%</b>',
      'How much NEAR?',
    ])
      expect(text).toContain(part)
    // NearKit's fee is disclosed on the quote, not here.
    expect(text).not.toMatch(/fee/i)
    const labels = h.buttons().map((b) => b.text)
    expect(labels.slice(0, 3)).toEqual(['0.1 NEAR', '0.5 NEAR', '1 NEAR'])
    expect(labels.some((l) => l.startsWith('MAX · '))).toBe(true)
    expect(labels.slice(-6)).toEqual(['✏️ Custom', '🔄 Refresh', '📈 Chart', '📋 Copy CA', '📊 Positions', '✖ Close'])
    // One wallet: nothing to switch to.
    expect(labels.some((l) => l.includes('Switch wallet'))).toBe(false)
  })

  it('a market cap no source knows is “unavailable”, never a number; a market read that fails says so', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    serve(h, marketOf(USDT, { marketCapUsd: missing('No source knows its circulating supply') }))
    const text = await buyScreen(h)
    expect(text).toContain('📊 Market cap unavailable')
    expect(text).not.toContain('$474K')
    expect(text).toContain('💵 Price <b>$0.000474</b>')
    serve(h, new Error('DEX Screener answered HTTP 503'))
    await h.press(h.button('Refresh'))
    expect(h.last()?.text).toContain('📊 Market data didn’t load. Refresh to try again.')
  })

  it('on a network without market prices it says so in one line', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    expect(await buyScreen(h)).toContain('📊 Testnet has no market prices.')
  })

  it('a token that taxes transfers to its DCL pool shows the tax, read from the token as the route reads it', async () => {
    const FRESH = 'fresh.nearlytrade.testnet'
    const DCL = NETWORKS.testnet.dex.dcl.contract
    const h = await walletBot({
      chain: {
        accounts: { [DCL]: { amount: ONE, code: true }, [FRESH]: { amount: ONE, global: 'GlobalTokenContract1111111111111' } },
        tokens: {
          [FRESH]: { symbol: 'FRESH', name: 'Fresh Launch Token', decimals: 18, boundsMin: REG, balances: {}, registered: [DCL], tax: { buyBps: 100, sellBps: 50, pairs: [DCL] } },
        },
        dcl: {
          contract: DCL,
          pools: {
            [dclPoolId(FRESH, WRAP, 10000)]: { tokenX: FRESH, tokenY: WRAP, fee: 10000, liquidity: 10n ** 23n, rate: (_tokenIn: string, amountIn: bigint) => amountIn * 1000n },
          },
        },
      },
    })
    await h.funded(3n * ONE)
    expect(await buyScreen(h, FRESH)).toContain('🧾 Tax buy <b>1%</b> · sell <b>0.5%</b>')
    // An ordinary token has no tax line.
    serve(h, marketOf(USDT))
    expect(await buyScreen(h)).not.toContain('Tax')
  })

  it('🔄 Refresh reads the market and the balance again, in the same message', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    serve(h, marketOf(USDT))
    await buyScreen(h)
    const sends = () => h.fake.messages().filter((m) => m.method === 'sendMessage').length
    const sent = sends()
    h.chain.fund(w.accountId, 2n * ONE)
    serve(h, marketOf(USDT, { marketCapUsd: known(1_250_000, 'CoinGecko') }))
    h.advance(30_000)
    await h.press(h.button('Refresh'))
    const text = h.last()?.text ?? ''
    expect(text).toContain('📊 Market cap <b>$1.25M</b>')
    expect(text).toContain('· <b>5 NEAR</b>')
    // The screen the button sits on is edited: no new screen piles up in the chat.
    expect(h.fake.messages().at(-1)?.method).toBe('editMessageText')
    expect(sends()).toBe(sent)
  })

  it('switching wallet lists only the user’s own active NearKit wallets; the pick is the trade’s wallet and the selected one from then on', async () => {
    const h = await walletBot()
    const first = await h.funded(3n * ONE)
    const second = await newWallet(h)
    h.chain.fund(second.accountId, 2n * ONE)
    await h.press(`cw:sel:${first.id}`)
    serve(h, marketOf(USDT))
    expect(await buyScreen(h)).toContain(`👛 <b>Main</b> ${shortAccount(first.accountId)}`)
    await h.press(h.button('Switch wallet'))
    const choices = h.buttons().map((b) => b.text)
    expect(choices).toEqual(['✅ 1. Main', `2. ${second.label ?? 'Wallet 2'}`, '« Back'])
    await h.press(h.button('2. '))
    const text = h.last()?.text ?? ''
    expect(text).toContain(`${shortAccount(second.accountId)} · <b>2 NEAR</b>`)
    expect(text).toContain('How much NEAR?')
    expect((await h.wallet())?.id).toBe(second.id)
  })

  it('Chart opens NearKit’s token page, Copy CA copies the full contract, Close ends the flow', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    serve(h, marketOf(USDT))
    await buyScreen(h)
    const buttons = h.buttons()
    expect(buttons.find((b) => b.text === '📈 Chart')?.url).toBe(`${h.config.webUrl}/token/${encodeURIComponent(USDT)}`)
    expect(buttons.find((b) => b.text === '📋 Copy CA')?.copy).toBe(USDT)
    expect(buttons.find((b) => b.text === '📊 Positions')?.data).toBe('pf:positions')
    await h.press(h.button('Close'))
    expect(h.last()?.text).toContain('Cancelled. Nothing was prepared or signed.')
  })
})
