import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { formatUnits } from '@/lib/amounts'
import type { SwapQuote } from '../custody/swap'
import { buyReserve } from '../custody/swap'
import { ALICE } from './testing'
import { ONE, USDT, WRAP, walletBot } from './walletTesting'

type Harness = Awaited<ReturnType<typeof walletBot>>
const usdtOf = (h: Harness, account: string) => h.chain.tokens.get(USDT)?.balances.get(account) ?? 0n
const nearOf = (h: Harness, account: string) => h.chain.accounts.get(account)?.amount ?? 0n
/** Transactions that reached the chain (not dropped). */
const landed = (h: Harness) => h.chain.sent.filter((s) => s.mode === 'apply' || s.mode === 'timeout')
/** The intent behind the Confirm button on screen. */
const shownIntent = (h: Harness) => h.button('Confirm buy').slice('cx:ok:'.length)
const shownNeed = async (h: Harness) => BigInt(((await h.custody.store.intent(shownIntent(h)))?.quote as unknown as SwapQuote).need ?? '0')
/** Sets the wallet's NEAR to exactly `yocto`. */
const setNear = (h: Harness, account: string, yocto: bigint) => {
  const a = h.chain.accounts.get(account)
  if (!a) throw new Error('no such account')
  a.amount = yocto
}

describe('Buy from the NearKit wallet, entirely in Telegram', () => {
  it('buy by ticker: a compact quote, one Confirm, the result read from chain', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.say('/buy')
    await h.say('USDT')
    expect(h.last()?.text).toContain('From your NearKit wallet')
    await h.press(h.button('0.1 NEAR'))
    const quote = h.last()?.text ?? ''
    for (const part of [
      '🟢 <b>Buy USDT</b>',
      'You pay <b>0.1 NEAR</b>',
      'You receive <b>≈ 0.4 USDT</b>',
      'Minimum 0.398 USDT · 1% slippage',
      'NearKit fee none on testnet',
      'Network fee ≈',
      'Registration 0.0025 NEAR',
      'of it is gas held while the swap runs, back within seconds',
      'Route NEAR → USDT · Rhea',
    ])
      expect(quote).toContain(part)
    expect(quote).not.toContain('Deposit at least')
    // No browser, no web hand-off: the button runs the trade here.
    expect(h.buttons().some((b) => b.url)).toBe(false)
    const confirm = h.button('Confirm buy')
    await h.press(confirm)
    const result = h.last()?.text ?? ''
    expect(result).toContain('Buy confirmed')
    expect(result).toContain('Spent <b>0.1 NEAR</b>')
    expect(result).toContain('Received <b>0.4 USDT</b>')
    expect(result).toMatch(/Tx <a href="https:\/\/testnet\.nearblocks\.io\/txns\//)
    expect(usdtOf(h, w.accountId)).toBe(400_000n)
    // Registration on USDT, then wrap + swap in one transaction.
    expect(landed(h).map((s) => s.tx.receiverId)).toEqual([USDT, WRAP])
    const sent = h.chain.sent.length
    await h.press(confirm)
    await h.press(confirm)
    expect(h.chain.sent.length).toBe(sent)
    const intent = await h.custody.store.allInFlight()
    expect(intent).toEqual([])
  })

  it('buy by exact contract, with the amount in the command', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.say(`/buy ${USDT} 0.25`)
    expect(h.last()?.text).toContain('You pay <b>0.25 NEAR</b>')
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Received <b>1 USDT</b>')
    expect(usdtOf(h, w.accountId)).toBe(1_000_000n)
  })

  it('MAX buys everything but the gas NEAR must buy upfront, and it goes through', async () => {
    const h = await walletBot()
    const w = await h.funded(2n * ONE)
    await h.say('/buy USDT')
    const max = h.button('MAX')
    expect(h.buttons().find((b) => b.data === max)?.text).toContain(formatUnits(2n * ONE - buyReserve(NETWORKS.testnet), 24, { maxFraction: 2, group: true }))
    await h.press(max)
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Buy confirmed')
    expect(nearOf(h, w.accountId)).toBeGreaterThan(0n)
  })

  it('a token from the other network, a pair with no route, and too little NEAR are refused in plain words', async () => {
    const h = await walletBot()
    await h.funded(ONE / 5n)
    await h.say('/buy singularty.nearlytrade.near')
    expect(h.last()?.text).toContain('This belongs to NEAR mainnet while NearKit is using testnet.')
    await h.say('/buy USDT 1')
    expect(h.last()?.text).toContain('Not enough NEAR for this trade plus gas.')
    // The amount screen says up front that a buy needs NEAR for gas besides the amount.
    await h.say('/buy USDT')
    expect(h.last()?.text).toContain('⚠️ Buying needs up to')
    await h.say('/cancel')
    // Enough for the amount, not for the gas held upfront: the quote says so, and Confirm sends nothing.
    await h.say('/buy USDT 0.1')
    expect(h.last()?.text).toContain('⚠️ Your NearKit wallet has 0.2 NEAR. Deposit at least')
    await h.press(h.button('Confirm buy'))
    const refused = h.last()?.text ?? ''
    expect(refused).toContain('Buy failed')
    expect(refused).toMatch(
      /This buy needs [\d.]+ NEAR available and your NearKit wallet has 0\.2 NEAR: 0\.1 NEAR to swap, [\d.]+ NEAR for one-time registrations and [\d.]+ NEAR for gas/,
    )
    expect(refused).toContain('Deposit at least')
    expect(refused).toContain('Nothing was sent.')
    expect(h.chain.sent).toHaveLength(0)
    h.market.noRoute = true
    await h.say('/buy USDT 0.1')
    expect(h.last()?.text).toContain('No route is available for this pair right now.')
    expect(h.chain.sent).toHaveLength(0)
  })
})

describe('NEAR a buy needs: its steps one after another, gas refunded in between', () => {
  it('a first buy goes through with exactly the NEAR its plan needs at its peak; 1 yocto less is refused and sends nothing', async () => {
    for (const short of [1n, 0n]) {
      const h = await walletBot()
      const w = await h.funded(3n * ONE)
      await h.say('/buy USDT 0.1')
      const need = await shownNeed(h)
      expect(need).toBeGreaterThan(ONE / 10n)
      setNear(h, w.accountId, need - short)
      await h.press(h.button('Confirm buy'))
      if (short) {
        expect(h.last()?.text).toContain('Buy failed')
        expect(h.last()?.text).toContain('Deposit at least 0.0001 NEAR more.')
        expect(h.chain.sent).toHaveLength(0)
      } else {
        expect(h.last()?.text).toContain('Buy confirmed')
        // Registration on USDT, then wrap + swap.
        expect(landed(h).map((s) => s.tx.receiverId)).toEqual([USDT, WRAP])
        expect(usdtOf(h, w.accountId)).toBe(400_000n)
      }
    }
  })

  it('the swap is signed only once the registration’s gas refund has landed', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.say('/buy USDT 0.1')
    setNear(h, w.accountId, await shownNeed(h))
    // The refund arrives only after a few more reads of the wallet's balance.
    h.chain.lateRefunds(3)
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Buy confirmed')
    expect(landed(h).map((s) => s.tx.receiverId)).toEqual([USDT, WRAP])
  })

  it('a refund that doesn’t land in time stops the plan before the swap: the registration went through, nothing more was signed', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.say('/buy USDT 0.1')
    setNear(h, w.accountId, await shownNeed(h))
    const id = shownIntent(h)
    h.chain.lateRefunds(10_000)
    await h.press(h.button('Confirm buy'))
    const text = h.last()?.text ?? ''
    expect(text).toContain('Buy failed')
    expect(text).toMatch(
      /The next step needs [\d.]+ NEAR available and your NearKit wallet has [\d.]+ NEAR, so it wasn’t sent\. Earlier steps went through; see the transactions\./,
    )
    expect(landed(h).map((s) => s.tx.receiverId)).toEqual([USDT])
    expect(await h.custody.store.txsOf(id)).toHaveLength(1)
  })
})

describe('Sell from the NearKit wallet', () => {
  it('sell by ticker with 50% and 100%: exact token amounts, NEAR delivered unwrapped', async () => {
    const h = await walletBot()
    const w = await h.funded(ONE, 10_000_000n)
    await h.say('/sell USDT')
    expect(h.buttons().map((b) => b.text)).toEqual(expect.arrayContaining(['25%', '50%', '75%', '100%']))
    await h.press(h.button('50%'))
    expect(h.last()?.text).toContain('You pay <b>5 USDT</b>')
    expect(h.last()?.text).toContain('You receive <b>≈ 1.25 NEAR</b>')
    const before = nearOf(h, w.accountId)
    await h.press(h.button('Confirm sell'))
    expect(h.last()?.text).toContain('Sell confirmed')
    expect(h.last()?.text).toContain('Sold <b>5 USDT</b>')
    expect(h.last()?.text).toContain('Received <b>1.25 NEAR</b>')
    expect(nearOf(h, w.accountId) - before).toBeGreaterThan(ONE)
    await h.say('/sell USDT')
    await h.press(h.button('100%'))
    await h.press(h.button('Confirm sell'))
    expect(h.last()?.text).toContain('Sold <b>5 USDT</b>')
    expect(usdtOf(h, w.accountId)).toBe(0n)
  })

  it('sell by exact contract with a custom amount', async () => {
    const h = await walletBot()
    const w = await h.funded(ONE, 10_000_000n)
    await h.say(`/sell ${USDT}`)
    await h.press(h.button('Custom'))
    await h.say('2.5')
    await h.press(h.button('Confirm sell'))
    expect(h.last()?.text).toContain('Sold <b>2.5 USDT</b>')
    expect(usdtOf(h, w.accountId)).toBe(7_500_000n)
  })
})

describe('quote freshness', () => {
  it('a worse price at Confirm shows the new quote and sends nothing; its Confirm then trades', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.say('/buy USDT 1')
    h.market.usdtPerNear = 3_900_000n
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Quote changed. Review the new price.')
    expect(h.last()?.text).toContain('You receive <b>≈ 3.9 USDT</b>')
    expect(h.chain.sent).toHaveLength(0)
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Received <b>3.9 USDT</b>')
    expect(usdtOf(h, w.accountId)).toBe(3_900_000n)
  })

  it('a better price at Confirm just trades, at the fresh route', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.say('/buy USDT 1')
    h.market.usdtPerNear = 4_100_000n
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Received <b>4.1 USDT</b>')
    expect(usdtOf(h, w.accountId)).toBe(4_100_000n)
  })

  it('an expired quote, and a quote replaced by Refresh, send nothing', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    await h.say('/buy USDT 1')
    const old = h.button('Confirm buy')
    h.advance(61_000)
    await h.press(old)
    expect(h.last()?.text).toContain('expired')
    await h.say('/buy USDT 1')
    const first = h.button('Confirm buy')
    await h.press(h.button('Refresh'))
    const second = h.button('Confirm buy')
    expect(second).not.toBe(first)
    await h.press(first)
    expect(h.chain.sent).toHaveLength(0)
    expect((await h.custody.store.intent(first.slice('cx:ok:'.length)))?.status).toBe('cancelled')
  })

  it('the quote carries NearKit’s canonical fee rate, charged only where a fee account runs (not on testnet)', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    await h.say('/buy USDT 1')
    const id = h.button('Confirm buy').slice('cx:ok:'.length)
    const q = (await h.custody.store.intent(id))?.quote as unknown as SwapQuote
    expect(q.fee).toMatchObject({ charged: false, bps: NEARKIT_FEE_BPS })
    expect(NEARKIT_FEE_BPS).toBe(50)
  })
})

describe('failures on chain', () => {
  it('a swap the exchange refunds is a failed buy (wNEAR back), with Unwrap one tap away', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.say('/buy USDT 1')
    // The price crashes between the fresh route and the swap's execution.
    h.chain.onSend((tx) => {
      if (tx.receiverId === WRAP) h.market.usdtPerNear = 1_000_000n
      return 'apply'
    })
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Buy failed')
    expect(h.last()?.text).toContain('The price moved past your slippage.')
    expect(h.last()?.text).toContain('as wNEAR')
    expect(usdtOf(h, w.accountId)).toBe(0n)
    expect(h.chain.tokens.get(WRAP)?.balances.get(w.accountId)).toBe(ONE)
    await h.press(h.button('Unwrap wNEAR'))
    expect(h.last()?.text).toContain('1 wNEAR → NEAR')
    await h.press(h.button('Confirm unwrap'))
    expect(h.last()?.text).toContain('Unwrapped')
    expect(h.chain.tokens.get(WRAP)?.balances.get(w.accountId)).toBe(0n)
  })

  it('positions afterwards come from chain: the NearKit wallet’s new token is there', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    await h.say('/buy USDT 1')
    await h.press(h.button('Confirm buy'))
    await h.say('/positions')
    const text =
      h.fake
        .messages()
        .filter((m) => m.chatId === ALICE.id)
        .at(-1)?.text ?? ''
    expect(text).toContain('USDT')
  })
})

describe('a slow NEAR network', () => {
  // The fake testnet chain keeps every account on one shard.
  const ONE_SHARD = { V3: { boundary_accounts: [], shard_ids: [0] } }
  const PGAS = 10n ** 15n
  const lastToAlice = (h: Harness) =>
    h.fake
      .messages()
      .filter((m) => m.chatId === ALICE.id)
      .at(-1)?.text ?? ''

  it('the quote says when wrap.near’s shard is backed up, and Confirm still trades', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    h.chain.congest(ONE_SHARD, { 0: 36n * PGAS })
    await h.say('/buy USDT 0.1')
    expect(h.last()?.text).toContain('⚠️ NEAR network is currently busy. This swap may take longer than usual.')
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Buy confirmed')
  })

  it('says nothing about it on a quiet network', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    h.chain.congest(ONE_SHARD, { 0: 0n })
    await h.say('/buy USDT 0.1')
    expect(h.last()?.text).not.toContain('NEAR network is currently busy')
  })

  it('a buy still running when the live wait ends shows Processing, never a failure, and its result follows', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.say('/buy USDT 0.1')
    // The swap lands, but the chain's answer lags behind.
    h.chain.onSend((tx) => (tx.receiverId === WRAP ? 'hidden' : 'apply'))
    await h.press(h.button('Confirm buy'))
    const waiting = h.last()?.text ?? ''
    expect(waiting).toContain('Processing — NEAR network is taking longer than usual')
    expect(waiting).toContain('Nothing will be sent twice')
    expect(waiting).not.toMatch(/fail|went wrong/i)
    h.chain.reveal()
    await h.custody.engine.resolvePending()
    expect(lastToAlice(h)).toContain('Buy confirmed')
    expect(usdtOf(h, w.accountId)).toBe(400_000n)
    expect(landed(h).length + h.chain.sent.filter((s) => s.mode === 'hidden').length).toBe(2)
  })
})
