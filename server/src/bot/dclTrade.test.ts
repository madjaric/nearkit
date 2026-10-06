import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { dclPoolId } from '@/services/dcl/pools'
import { ONE, REG, USDT, WRAP, walletBot } from './walletTesting'

/**
 * A token launched outside every list, with a DCL pool and no Rhea route: bought and sold from
 * the NearKit wallet entirely in Telegram, through the generic router, the engine, the signer's
 * policy and the signer's own on-chain quote. Testnet: no NearKit fee.
 */
const FRESH = 'fresh.nearlytrade.testnet'
const DCL = NETWORKS.testnet.dex.dcl.contract
const POOL = dclPoolId(FRESH, WRAP, 10000)
/** 1 wNEAR (24 decimals) buys 1,000 FRESH (18 decimals), less the pool's 1% fee; and back. */
const rate = (tokenIn: string, amountIn: bigint) => ((tokenIn === WRAP ? amountIn / 1000n : amountIn * 1000n) * 99n) / 100n
const FRESH_TOKEN = { symbol: 'FRESH', name: 'Fresh Launch Token', decimals: 18, boundsMin: REG, balances: {}, registered: [DCL] }
const accounts = { [DCL]: { amount: ONE, code: true }, [FRESH]: { amount: ONE, global: 'GlobalTokenContract1111111111111' } }
const bot = (
  pools: Record<string, { tokenX: string; tokenY: string; fee: number; liquidity: bigint; rate: typeof rate }> = {
    [POOL]: { tokenX: FRESH, tokenY: WRAP, fee: 10000, liquidity: 10n ** 23n, rate },
  },
) => walletBot({ chain: { accounts, tokens: { [FRESH]: FRESH_TOKEN }, dcl: { contract: DCL, pools } } })

type Harness = Awaited<ReturnType<typeof walletBot>>
const freshOf = (h: Harness, account: string) => h.chain.tokens.get(FRESH)?.balances.get(account) ?? 0n
const nearOf = (h: Harness, account: string) => h.chain.accounts.get(account)?.amount ?? 0n
const landed = (h: Harness) => h.chain.sent.filter((s) => s.mode === 'apply' || s.mode === 'timeout')

describe('a token outside every list, routed on DCL directly, from the NEARKITS wallet in Telegram', () => {
  it('buy by exact contract: quoted on the pair’s pool, the route says DCL, no fee on testnet, confirmed from chain', async () => {
    const h = await bot()
    const w = await h.funded(3n * ONE)
    await h.say(`/buy ${FRESH} 0.1`)
    const quote = h.last()?.text ?? ''
    for (const part of ['🟢 <b>Buy FRESH</b>', 'You pay <b>0.1 NEAR</b>', 'You receive <b>≈ 99 FRESH</b>', 'NEARKITS fee none on testnet', 'Route NEAR → FRESH · DCL'])
      expect(quote).toContain(part)
    await h.press(h.button('Confirm buy'))
    const result = h.last()?.text ?? ''
    expect(result).toContain('Buy confirmed')
    expect(result).toContain('Spent <b>0.1 NEAR</b>')
    expect(result).toContain('Received <b>99 FRESH</b>')
    expect(freshOf(h, w.accountId)).toBe(99n * 10n ** 18n)
    // Registration on FRESH, then (the wallet's first wNEAR) registration, wrap and swap to the DCL contract in one transaction; nothing else.
    expect(landed(h).map((s) => s.tx.receiverId)).toEqual([FRESH, WRAP])
    const swap = landed(h)[1]?.tx.actions.map((a) =>
      a.type === 'FunctionCall' ? `${a.methodName}:${String((JSON.parse(new TextDecoder().decode(a.args)) as { receiver_id?: string }).receiver_id ?? '')}` : a.type,
    )
    expect(swap).toEqual(['storage_deposit:', 'near_deposit:', `ft_transfer_call:${DCL}`])
    expect(await h.custody.store.allInFlight()).toEqual([])
  })

  it('sell for NEAR: the pool pays wNEAR, unwrapped to NEAR on the way, no fee on testnet', async () => {
    const h = await bot()
    const w = await h.funded(ONE)
    const t = h.chain.tokens.get(FRESH)
    t?.balances.set(w.accountId, 200n * 10n ** 18n)
    t?.registered.add(w.accountId)
    await h.say(`/sell ${FRESH}`)
    await h.press(h.button('50%'))
    const quote = h.last()?.text ?? ''
    expect(quote).toContain('You pay <b>100 FRESH</b>')
    expect(quote).toContain('You receive <b>≈ 0.099 NEAR</b>')
    expect(quote).toContain('Route FRESH → NEAR · DCL')
    const before = nearOf(h, w.accountId)
    await h.press(h.button('Confirm sell'))
    const result = h.last()?.text ?? ''
    expect(result).toContain('Sell confirmed')
    expect(result).toContain('Sold <b>100 FRESH</b>')
    expect(result).toContain('Received <b>0.099 NEAR</b>')
    expect(freshOf(h, w.accountId)).toBe(100n * 10n ** 18n)
    expect(nearOf(h, w.accountId) - before).toBeGreaterThan(9n * 10n ** 22n)
  })

  it('a token that taxes its pool 1% each way: the quote and the result are what the wallet actually gets, and the sell does not revert', async () => {
    const h = await walletBot({
      chain: {
        accounts,
        tokens: { [FRESH]: { ...FRESH_TOKEN, tax: { buyBps: 100, sellBps: 100, pairs: [DCL] } } },
        dcl: { contract: DCL, pools: { [POOL]: { tokenX: FRESH, tokenY: WRAP, fee: 10000, liquidity: 10n ** 23n, rate } } },
      },
    })
    const w = await h.funded(3n * ONE)
    await h.say(`/buy ${FRESH} 0.1`)
    const quote = h.last()?.text ?? ''
    expect(quote).toContain('You receive <b>≈ 98.01 FRESH</b>')
    expect(quote).toContain('Minimum 97.0299 FRESH')
    expect(quote).toContain('Token tax 1% on tokens leaving the pool')
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Received <b>98.01 FRESH</b>')
    expect(freshOf(h, w.accountId)).toBe(9801n * 10n ** 16n)
    await h.say(`/sell ${FRESH}`)
    await h.press(h.button('100%'))
    const sellQuote = h.last()?.text ?? ''
    // 98.01 FRESH sold: the pool receives 97.0299 after the sell tax, and pays 1,000 wNEAR per million less 1%.
    expect(sellQuote).toContain('You pay <b>98.01 FRESH</b>')
    expect(sellQuote).toContain('You receive <b>≈ 0.096059 NEAR</b>')
    expect(sellQuote).toContain('Token tax 1% on tokens entering the pool')
    await h.press(h.button('Confirm sell'))
    expect(h.last()?.text).toContain('Sell confirmed')
    expect(h.last()?.text).toContain('Received <b>0.096059 NEAR</b>')
    expect(freshOf(h, w.accountId)).toBe(0n)
  })

  it('with no pool and no Rhea route, the quote says no executable route was found, never that the token is unsupported', async () => {
    const h = await bot({})
    await h.funded(3n * ONE)
    await h.say(`/buy ${FRESH} 0.1`)
    const text = h.last()?.text ?? ''
    expect(text).toContain('No executable route found for NEAR → FRESH')
    expect(text).not.toMatch(/not supported|not listed|unsupported/i)
  })

  it('a token Rhea routes still goes through Rhea, unchanged', async () => {
    const h = await bot()
    await h.funded(3n * ONE)
    await h.say(`/buy ${USDT} 0.1`)
    expect(h.last()?.text).toContain('Route NEAR → USDT · Rhea')
  })
})
