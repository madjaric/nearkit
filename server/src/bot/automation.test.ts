import { describe, expect, it, vi } from 'vitest'
import { REQUEST_KEY } from '@/lib/automation/api'
import type { StrategyKind } from '@/lib/automation/config'
import { menuCommands } from '../app'
import { createAutomationService } from '../automation/service'
import { AutomationStore } from '../automation/store'
import type { TgUser } from '../telegram/types'
import { requestKeyOf } from './automation'
import { ALICE } from './testing'
import { ONE, USDT, walletBot } from './walletTesting'

/**
 * Trading automation in Telegram (/orders, /copy, /snipe, /dca, /auto) on the fake chain, through the
 * very service NEARKITS web uses: Alice has a funded NEARKITS wallet with 40 USDT, and USDT trades at
 * about 0.25 NEAR. Every strategy the bot creates is read back through the service (as the web reads it).
 */

const ALL: StrategyKind[] = ['limit', 'copy', 'sniper', 'dca']
const MALLORY: TgUser = { ...ALICE, id: 303, first_name: 'Mallory', username: 'mallory' }

async function autoBot(options: { enabled?: StrategyKind[]; service?: boolean } = {}) {
  const h = await walletBot()
  const store = new AutomationStore(h.db, h.deps.now)
  const service = createAutomationService({
    store,
    custody: h.custody,
    near: h.deps.near,
    network: h.config.network,
    enabled: new Set(options.enabled ?? ALL),
    // These tests go through buying snipers too (production starts with them off: NEARKIT_AUTOMATION_SNIPER_BUY).
    sniperBuy: true,
    now: h.deps.now,
  })
  if (options.service !== false) h.deps.automation = service
  const wallet = await h.funded(5n * ONE, 40_000_000n)
  // The router allows a burst of 15 events, then one every 2 s: each step here is 2 s apart.
  const say = async (text: string, user: TgUser = ALICE) => {
    h.advance(2_000)
    await h.say(text, user)
  }
  const press = async (data: string, user: TgUser = ALICE) => {
    h.advance(2_000)
    await h.press(data, user)
  }
  const tap = async (label: string) => {
    const data = h.button(label)
    if (!data)
      throw new Error(
        `no button "${label}" on: ${h.last()?.text}\n${h
          .buttons()
          .map((b) => b.text)
          .join(' | ')}`,
      )
    await press(data)
  }
  const text = () => h.last()?.text ?? ''
  const toasts = () => h.fake.calls.filter((c) => c.method === 'answerCallbackQuery' && c.params.text).map((c) => String(c.params.text))
  /** A tap with no time passing (the clock stands still). */
  const pressNow = h.press
  return { ...h, service, autoStore: store, wallet, say, press, pressNow, tap, text, toasts }
}

type Bot = Awaited<ReturnType<typeof autoBot>>

/** /orders → New order → Limit buy USDT with 1 NEAR at `price`, up to the review. */
async function reviewLimitBuy(h: Bot, price = '0.1') {
  await h.say('/orders')
  await h.tap('New order')
  await h.tap('Limit buy')
  await h.say(USDT)
  await h.say('1')
  await h.say(price)
  await h.tap('1%')
  await h.tap('Good till cancelled')
}

describe('limit orders in Telegram (/orders)', () => {
  it('a limit buy end to end: preview before Confirm, created once however often Confirm is tapped, the same record the web lists', async () => {
    const h = await autoBot()
    await h.say('/orders')
    expect(h.text()).toContain('Limit orders')
    expect(h.text()).toContain('No limit orders yet')
    await h.tap('New order')
    expect(h.text()).toContain('What kind of order?')
    await h.tap('Limit buy')
    // One NEARKITS wallet: chosen without asking. Then the token.
    expect(h.text()).toContain('Which token?')
    await h.say(USDT)
    expect(h.text()).toContain('How much NEAR')
    await h.say('0.01')
    expect(h.text()).toContain('at least 0.05')
    await h.say('1')
    // The trigger step shows the current executable price for this amount.
    expect(h.text()).toContain('Trigger price')
    expect(h.text()).toMatch(/Now ≈ <b>0\.2\d+ NEAR<\/b> per USDT/)
    await h.say('abc')
    expect(h.text()).toContain('Send a price in NEAR above 0')
    await h.say('0.1')
    await h.tap('1%')
    await h.tap('Good till cancelled')
    const review = h.text()
    expect(review).toContain('Review · Limit buy USDT')
    expect(review).toContain('Buy with <b>1 NEAR</b> when the price is at or below <b>0.1</b> NEAR per USDT')
    expect(review).toMatch(/Now ≈ <b>0\.2\d+ NEAR<\/b>/)
    expect(review).toContain('Not met at this quote')
    expect(review).toContain('minimum')
    expect(review).toContain('Good till cancelled')
    // Nothing exists before Confirm.
    expect(await h.service.list(ALICE.id)).toEqual([])
    const ok = h.button('Confirm order')
    expect(ok).toMatch(/^au:ok:/)
    await h.press(ok)
    expect(h.text()).toContain('Limit buy USDT created')
    // A second tap (or a replay) of the same Confirm creates nothing.
    await h.press(ok)
    expect(h.text()).toContain('used already')
    const list = await h.service.list(ALICE.id)
    expect(list).toHaveLength(1)
    const order = list[0]
    expect(order?.status).toBe('active')
    expect(order?.walletId).toBe(h.wallet.id)
    expect(order?.config).toMatchObject({
      kind: 'limit',
      limit: { type: 'limit-buy', triggerPriceNear: '0.1', amount: { kind: 'near', value: '1' }, slippagePct: 1, expiresAt: null },
    })
    // The list and the detail show it.
    await h.say('/orders')
    expect(h.text()).toContain('Limit buy USDT')
    await h.press(`au:v:${order?.id}`)
    expect(h.text()).toContain('🟢 Active')
    expect(h.text()).toContain('Recent events')
    expect(h.text()).toContain('Created and active')
  })

  it('pause, resume and cancel (cancel asks first); each re-reads the order through the service', async () => {
    const h = await autoBot()
    await reviewLimitBuy(h)
    await h.tap('Confirm order')
    const id = (await h.service.list(ALICE.id))[0]?.id as string
    await h.press(`au:v:${id}`)
    await h.tap('Pause')
    expect(h.text()).toContain('Paused. Nothing trades until you resume it.')
    expect((await h.service.detail(ALICE.id, id)).strategy.status).toBe('paused')
    await h.tap('Resume')
    expect(h.text()).toContain('Resumed')
    expect((await h.service.detail(ALICE.id, id)).strategy.status).toBe('active')
    await h.tap('Cancel order')
    expect(h.text()).toContain('It ends for good')
    expect((await h.service.detail(ALICE.id, id)).strategy.status).toBe('active')
    await h.tap('Yes, cancel it')
    expect(h.text()).toContain('Cancelled. Nothing new is sent for it.')
    expect((await h.service.detail(ALICE.id, id)).strategy.status).toBe('cancelled')
    // Tapped again: still cancelled, nothing else happens.
    await h.press(`au:xx:${id}`)
    expect((await h.service.detail(ALICE.id, id)).strategy.status).toBe('cancelled')
    expect(h.buttons().map((b) => b.text)).not.toContain('⏸ Pause')
  })

  it('take profit + stop loss: one review previews both, one Confirm creates the pair, and cancelling either cancels both', async () => {
    const h = await autoBot()
    await h.say('/orders')
    await h.tap('New order')
    await h.tap('Take profit + stop loss')
    await h.say('USDT')
    expect(h.text()).toContain('How much USDT does it sell?')
    await h.tap('100%')
    expect(h.text()).toContain('Take profit price')
    await h.say('0.5')
    expect(h.text()).toContain('Stop loss price')
    await h.say('0.6')
    expect(h.text()).toContain('The stop loss must be below the take profit (0.5)')
    await h.say('0.1')
    await h.tap('2%')
    await h.tap('7 days')
    const review = h.text()
    expect(review).toContain('Take profit + stop loss USDT')
    expect(review).toContain('Sell <b>100% of the USDT held then</b> when the price is at or above <b>0.5</b>')
    expect(review).toContain('Sell <b>100% of the USDT held then</b> when the price is at or below <b>0.1</b>')
    expect(review).toContain('The first of the two to trigger cancels the other.')
    expect(review).toContain('Expires in 7 days')
    expect(review.match(/Not met at this quote/g)).toHaveLength(2)
    await h.tap('Confirm both orders')
    expect(h.text()).toContain('Take profit + stop loss created')
    const pair = await h.service.list(ALICE.id, ['limit'])
    expect(pair).toHaveLength(2)
    expect(new Set(pair.map((v) => (v.config.kind === 'limit' ? v.config.limit.type : null)))).toEqual(new Set(['take-profit', 'stop-loss']))
    expect(pair[0]?.ocoGroup).toBeTruthy()
    expect(pair[0]?.ocoGroup).toBe(pair[1]?.ocoGroup)
    expect(pair.every((v) => v.expiresAt !== null && v.expiresAt > h.deps.now() + 6 * 86_400_000)).toBe(true)
    const tp = pair.find((v) => v.config.kind === 'limit' && v.config.limit.type === 'take-profit')
    await h.press(`au:v:${tp?.id}`)
    expect(h.text()).toContain('Paired')
    expect(h.buttons().some((b) => b.text.includes('Its pair: Stop loss USDT'))).toBe(true)
    await h.tap('Cancel order')
    expect(h.text()).toContain('cancelling it cancels the other order too')
    await h.tap('Yes, cancel both orders')
    expect(h.text()).toContain('Both orders of the pair are cancelled')
    expect((await h.service.list(ALICE.id, ['limit'])).map((v) => v.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('two Confirm taps at the same moment still create one order', async () => {
    const h = await autoBot()
    await reviewLimitBuy(h)
    const ok = h.button('Confirm order')
    h.advance(10_000)
    await Promise.all([h.press(ok), h.press(ok), h.press(ok)])
    expect(await h.service.list(ALICE.id)).toHaveLength(1)
  })

  it('the detail shows the worker’s trades with explorer links, as the chain confirmed them', async () => {
    const h = await autoBot()
    await reviewLimitBuy(h, '0.3')
    await h.tap('Confirm order')
    const order = (await h.service.list(ALICE.id))[0]
    const id = order?.id as string
    // What the worker records once the chain confirms the fill (runner.ts / execute.ts).
    const e = await h.autoStore.addExecution({
      strategyId: id,
      userId: ALICE.id,
      walletId: h.wallet.id,
      idemKey: `limit:${id}:1`,
      side: 'buy',
      token: USDT,
      expectedOutRaw: '3980000',
    })
    await h.autoStore.updateExecution(e?.id as string, ['executing'], 'confirmed', { nearRaw: (1n * ONE).toString(), tokenRaw: '3975000', txHashes: ['9xHashOfTheFill1111'] })
    await h.autoStore.transition(id, ['active'], 'filled', { reason: 'Filled on chain' })
    await h.press(`au:v:${id}`)
    expect(h.text()).toContain('✅ Filled: Filled on chain')
    expect(h.text()).toContain('✅ Buy · 1 NEAR → 3.975 USDT')
    expect(h.text()).toContain(`href="${h.config.network.explorerUrl}/txns/9xHashOfTheFill1111"`)
    // Ended: no Pause or Cancel any more.
    expect(h.buttons().map((b) => b.text)).not.toEqual(expect.arrayContaining(['⏸ Pause']))
    expect(h.buttons().some((b) => b.text.includes('Cancel order'))).toBe(false)
  })

  it('no live preview (too many quotes in a minute), no Confirm: even a crafted one only refreshes the review', async () => {
    const h = await autoBot()
    await reviewLimitBuy(h)
    for (let i = 0; i < 14 && h.button('Confirm order'); i++) await h.pressNow(h.button('Refresh'))
    expect(h.text()).toContain('Too many quotes in a minute')
    expect(h.button('Confirm order')).toBe('')
    const id = h.button('Refresh').split(':').at(-1)
    await h.pressNow(`au:ok:${id}`)
    expect(h.text()).toContain('Too many quotes in a minute')
    expect(h.button('Confirm order')).toBe('')
    expect(await h.service.list(ALICE.id)).toEqual([])
    h.advance(60_000)
    await h.press(h.button('Refresh'))
    expect(h.text()).toContain('Not met at this quote')
    await h.tap('Confirm order')
    expect(await h.service.list(ALICE.id)).toHaveLength(1)
  })

  it('a limit buy whose condition holds now says so in the preview', async () => {
    const h = await autoBot()
    await reviewLimitBuy(h, '0.3')
    expect(h.text()).toContain('Its condition holds at this quote')
  })

  it('another Telegram user can’t view, pause, cancel or confirm someone else’s automation', async () => {
    const h = await autoBot()
    await reviewLimitBuy(h)
    const ok = h.button('Confirm order')
    // Mallory replays Alice's Confirm: refused, and it still works for Alice.
    await h.press(ok, MALLORY)
    expect(h.text()).toContain('used already or has expired')
    expect(await h.service.list(ALICE.id)).toEqual([])
    await h.press(ok)
    const id = (await h.service.list(ALICE.id))[0]?.id as string
    for (const data of [`au:v:${id}`, `au:p:${id}`, `au:x:${id}`, `au:xx:${id}`, `au:xb:${id}`]) {
      await h.press(data, MALLORY)
      expect(h.last()?.chatId).toBe(MALLORY.id)
      expect(h.text()).toContain('That isn’t one of your automations, or it’s gone.')
      expect(h.text()).not.toContain('Limit buy')
    }
    expect((await h.service.detail(ALICE.id, id)).strategy.status).toBe('active')
    await expect(h.service.detail(MALLORY.id, id)).rejects.toThrow('isn’t one of your automations')
    // A setup button of Alice's does nothing for Mallory either.
    await h.say('/orders')
    await h.tap('New order')
    const type = h.button('Limit buy')
    await h.press(type, MALLORY)
    expect(h.toasts().at(-1)).toContain('This setup has ended')
  })
})

describe('switched off', () => {
  it('without the automation service, every command says it isn’t switched on yet', async () => {
    const h = await autoBot({ service: false })
    for (const c of ['/orders', '/copy', '/snipe', '/dca', '/auto']) {
      await h.say(c)
      expect(h.text()).toContain('Trading automation isn’t switched on yet')
    }
    await h.press('au:new:limit')
    expect(h.text()).toContain('isn’t switched on yet')
    await h.say('/start')
    expect(h.buttons().some((b) => b.text.includes('Automation'))).toBe(false)
  })

  it('the main menu offers Automation once NEARKITS has switched a kind on', async () => {
    const h = await autoBot({ enabled: ['limit'] })
    await h.say('/start')
    await h.tap('🤖 Automation')
    expect(h.text()).toContain('Your automations')
  })

  it('a kind NEARKITS hasn’t switched on offers no New button and refuses to start one', async () => {
    const h = await autoBot({ enabled: ['limit'] })
    await h.say('/dca')
    expect(h.text()).toContain('isn’t switched on yet')
    expect(h.buttons().some((b) => b.text.includes('New DCA'))).toBe(false)
    await h.press('au:new:dca')
    expect(h.text()).toContain('DCA isn’t switched on by NEARKITS yet')
    await h.say('/auto')
    expect(h.text()).toContain('DCA: not switched on yet')
    expect(h.text()).toContain('Limit orders: 0 live')
    expect(h.buttons().some((b) => b.text.includes('New order'))).toBe(true)
    expect(h.buttons().some((b) => b.text.includes('New sniper'))).toBe(false)
  })
})

describe('Copy Trade (/copy)', () => {
  it('follow an account: a summary before Start copying, then stop it (asked first)', async () => {
    const h = await autoBot()
    await h.say('/copy')
    expect(h.text()).toContain('No copy trade yet')
    await h.tap('Follow a wallet')
    expect(h.text()).toContain('Which NEAR account do you follow?')
    await h.say('Bad Account!')
    expect(h.text()).toContain('isn’t a NEAR account ID')
    await h.say('bob.testnet')
    await h.tap('Buys and sells')
    await h.say('10%')
    await h.tap('1 NEAR')
    await h.tap('5 NEAR')
    await h.tap('1%')
    const review = h.text()
    expect(review).toContain('Copies buys and sells of <code>bob.testnet</code>: 10% of what they spent per buy')
    expect(review).toContain('at most <b>1 NEAR</b> a trade and <b>5 NEAR</b> open in all')
    expect(h.buttons().some((b) => b.url?.endsWith('/copy-trade'))).toBe(true)
    expect(await h.service.list(ALICE.id)).toEqual([])
    await h.tap('Start copying')
    expect(h.text()).toContain('Copy bob.testnet created')
    const [rule] = await h.service.list(ALICE.id, ['copy'])
    expect(rule?.config).toMatchObject({ kind: 'copy', copy: { target: 'bob.testnet', copy: 'both', sizing: { mode: 'percent', pct: 10 }, maxTradeNear: 1, maxExposureNear: 5 } })
    await h.press(`au:v:${rule?.id}`)
    await h.tap('Pause')
    expect((await h.service.detail(ALICE.id, rule?.id as string)).strategy.status).toBe('paused')
    await h.tap('Resume')
    await h.tap('Stop')
    expect(h.text()).toContain('It ends for good')
    expect((await h.service.detail(ALICE.id, rule?.id as string)).strategy.status).toBe('active')
    await h.tap('Yes, stop it')
    expect(h.text()).toContain('Stopped')
    expect((await h.service.detail(ALICE.id, rule?.id as string)).strategy.status).toBe('stopped')
  })

  it('a NEARKITS wallet can’t be followed: refused at the review, nothing created', async () => {
    const h = await autoBot()
    await h.say('/copy')
    await h.tap('Follow a wallet')
    await h.say(h.wallet.accountId)
    await h.tap('Buys only')
    await h.say('0.5')
    await h.tap('1 NEAR')
    await h.tap('2 NEAR')
    await h.tap('1%')
    expect(h.text()).toContain('That account is a NEARKITS wallet')
    expect(h.buttons().some((b) => b.text.includes('Start copying'))).toBe(false)
    expect(await h.service.list(ALICE.id)).toEqual([])
  })
})

describe('Sniper (/snipe)', () => {
  async function reviewSniper(h: Bot, mode: 'Notify only' | 'Buy automatically') {
    await h.say('/snipe')
    await h.tap('New sniper')
    expect(h.text()).toContain('What does the sniper watch?')
    await h.tap('One token')
    await h.say('USDT')
    await h.tap('0.5 NEAR')
    await h.tap('1%')
    await h.tap('10%')
    await h.tap('24 hours')
    expect(h.text()).toContain('Notify only, or buy?')
    await h.tap(mode)
  }

  it('notify only by default: created on one Confirm', async () => {
    const h = await autoBot()
    await reviewSniper(h, 'Notify only')
    expect(h.text()).toContain('Notify only: you get a message the moment it trades')
    expect(h.text()).toMatch(/Now ≈ <b>0\.\d+ NEAR<\/b>/)
    await h.tap('Confirm sniper')
    expect(h.text()).toContain('Sniper USDT created')
    const [s] = await h.service.list(ALICE.id, ['sniper'])
    expect(s?.config).toMatchObject({ kind: 'sniper', sniper: { mode: 'notify', amountNear: 0.5, maxImpactPct: 10, slippagePct: 1 } })
    expect(s?.expiresAt).toBeGreaterThan(h.deps.now())
  })

  it('a sniper that buys needs a second, explicit yes: Confirm alone creates nothing', async () => {
    const h = await autoBot()
    await reviewSniper(h, 'Buy automatically')
    expect(h.text()).toContain('you confirm that once more next')
    await h.tap('Confirm sniper')
    expect(h.text()).toContain('Buy automatically?')
    expect(await h.service.list(ALICE.id)).toEqual([])
    const yes = h.button('Yes, buy automatically')
    await h.press(yes)
    expect(h.text()).toContain('It’s active and buys once the token trades.')
    const list = await h.service.list(ALICE.id, ['sniper'])
    expect(list).toHaveLength(1)
    expect(list[0]?.config).toMatchObject({ kind: 'sniper', sniper: { mode: 'execute' } })
    await h.press(yes)
    expect(h.text()).toContain('used already')
    expect(await h.service.list(ALICE.id, ['sniper'])).toHaveLength(1)
  })
})

describe('Sniper on new pools (/snipe → 🆕 New pools)', () => {
  /** /snipe → New sniper → New pools, ticking `sources`, up to the review (or, buying, up to the number of tokens). */
  async function reviewNewPools(h: Bot, o: { sources?: string[]; min?: string; amount?: string; expiry?: string; mode?: 'Notify only' | 'Buy automatically'; buys?: string } = {}) {
    await h.say('/snipe')
    await h.tap('New sniper')
    await h.tap('New pools')
    for (const x of o.sources ?? ['Nearly launches', 'meme.cooking graduations']) await h.tap(`⬜ ${x}`)
    await h.tap('Continue')
    await h.tap(o.min ?? '5 NEAR')
    await h.tap(o.amount ?? '0.5 NEAR')
    await h.tap('1%')
    await h.tap('10%')
    await h.tap(o.expiry ?? 'No expiry')
    await h.tap(o.mode ?? 'Notify only')
    if (o.buys) await h.tap(o.buys)
  }

  const labels = (h: Bot) => h.buttons().map((b) => b.text)

  it('notify only, end to end through the buttons: sources ticked, the pool minimum, a summary instead of a quote, one Confirm creates it', async () => {
    const h = await autoBot()
    await h.say('/snipe')
    await h.tap('New sniper')
    expect(h.text()).toContain('What does the sniper watch?')
    expect(labels(h)).toEqual(expect.arrayContaining(['🎯 One token', '🆕 New pools']))
    await h.tap('New pools')
    // Sources: toggles, none ticked until the user ticks them; Continue needs at least one.
    expect(h.text()).toContain('Which new pools?')
    expect(labels(h)).toEqual(expect.arrayContaining(['⬜ Nearly launches', '⬜ meme.cooking graduations', '⬜ Other new pools', 'Continue »']))
    await h.tap('Continue')
    expect(h.toasts().at(-1)).toContain('Tick at least one')
    expect(h.text()).toContain('Which new pools?')
    await h.tap('⬜ Nearly launches')
    await h.tap('⬜ Other new pools')
    await h.tap('⬜ meme.cooking graduations')
    await h.tap('✅ Other new pools')
    expect(labels(h)).toEqual(expect.arrayContaining(['✅ Nearly launches', '✅ meme.cooking graduations', '⬜ Other new pools']))
    await h.tap('Continue')
    // The pool's NEAR minimum: buttons, or typed.
    expect(h.text()).toContain('The least NEAR a new pool must hold?')
    expect(labels(h)).toEqual(expect.arrayContaining(['1 NEAR', '5 NEAR', '20 NEAR']))
    await h.say('lots')
    expect(h.text()).toContain('from 0 to 100,000')
    await h.say('7.5')
    expect(h.text()).toContain('How much NEAR does it buy each new token with?')
    await h.tap('0.5 NEAR')
    await h.tap('1%')
    await h.tap('10%')
    await h.tap('7 days')
    expect(h.text()).toContain('Notify only, or buy?')
    expect(h.text()).toContain('each new pool whose token passes the checks')
    await h.tap('Notify only')
    // Notify only asks no number of tokens: straight to the review, a summary (nothing to quote yet).
    const review = h.text()
    expect(review).toContain('Review · Sniper: new pools')
    expect(review).toContain('Watches Nearly launch pools and meme.cooking graduation pools holding at least <b>7.5 NEAR</b>')
    expect(review).toContain('nothing is bought')
    expect(review).toContain('nothing to quote until a new pool appears')
    expect(review).toContain('New pools as Ref DCL and Ref v2 create them')
    expect(review).toContain('at least your NEAR minimum')
    expect(review).toContain('within your price impact')
    expect(review).toContain('may lose at most 25%')
    expect(review).toContain('Pools made before the sniper are never reported.')
    expect(review).toContain('Expires in 7 days')
    expect(review).toContain('Notify only: you get a message for each new pool whose token passes the checks; nothing is bought.')
    expect(review).not.toContain('Now ≈')
    expect(review).not.toContain('Too many quotes')
    expect(await h.service.list(ALICE.id)).toEqual([])
    await h.tap('Confirm sniper')
    expect(h.text()).toContain('Sniper: new pools created')
    expect(h.text()).toContain('you get a message for each new pool whose token passes the checks')
    const list = await h.service.list(ALICE.id, ['sniper'])
    expect(list).toHaveLength(1)
    const [s] = list
    expect(s?.subject).toBe('new-pools')
    expect(s?.config).toEqual({
      kind: 'sniper',
      sniper: {
        target: 'new-pools',
        token: null,
        sources: ['nearly', 'meme-cooking'],
        minPoolNear: 7.5,
        maxBuys: 1,
        amountNear: 0.5,
        slippagePct: 1,
        maxImpactPct: 10,
        minLiquidityUsd: null,
        maxAttempts: 3,
        expiresAt: expect.any(Number),
        mode: 'notify',
      },
    })
    expect(s?.expiresAt).toBeGreaterThan(h.deps.now() + 6 * 86_400_000)
    // The list and the detail name it and say what it watches.
    await h.say('/snipe')
    expect(h.text()).toContain('Sniper: new pools')
    await h.press(`au:v:${s?.id}`)
    expect(h.text()).toContain('🔫 <b>Sniper: new pools</b>')
    expect(h.text()).toContain('Watches Nearly launch pools and meme.cooking graduation pools holding at least <b>7.5 NEAR</b>')
    expect(h.text()).toContain('🟢 Active')
  })

  it('a new-pools sniper that buys: the number of tokens, then a second yes that says what it buys; Confirm alone creates nothing', async () => {
    const h = await autoBot()
    await reviewNewPools(h, { sources: ['Other new pools'], min: '20 NEAR', amount: '1 NEAR', mode: 'Buy automatically' })
    expect(h.text()).toContain('How many new tokens may it buy?')
    expect(labels(h)).toEqual(expect.arrayContaining(['1 token', '3 tokens', '5 tokens']))
    await h.say('11')
    expect(h.text()).toContain('from 1 to 10')
    await h.say('3')
    const review = h.text()
    expect(review).toContain('Watches other new pools holding at least <b>20 NEAR</b>: buys <b>1 NEAR</b> of each new token that passes the checks, up to 3 tokens')
    expect(review).toContain('you confirm that once more next')
    expect(review).toContain('No expiry')
    await h.tap('Confirm sniper')
    const second = h.text()
    expect(second).toContain('Buy automatically?')
    expect(second.replace(/<\/?b>/g, '')).toContain('buys 1 NEAR of each new token that passes the checks, up to 3 tokens')
    expect(second).toContain('at most 3 NEAR in all')
    expect(await h.service.list(ALICE.id)).toEqual([])
    const yes = h.button('Yes, buy automatically')
    expect(yes).toMatch(/^au:okx:/)
    await h.press(yes)
    expect(h.text()).toContain('Sniper: new pools created')
    expect(h.text()).toContain('it buys each new token that passes the checks, up to 3 tokens')
    const list = await h.service.list(ALICE.id, ['sniper'])
    expect(list).toHaveLength(1)
    expect(list[0]?.config).toMatchObject({
      kind: 'sniper',
      sniper: { target: 'new-pools', token: null, sources: ['other'], minPoolNear: 20, maxBuys: 3, amountNear: 1, mode: 'execute', expiresAt: null },
    })
    await h.press(yes)
    expect(h.text()).toContain('used already')
    expect(await h.service.list(ALICE.id, ['sniper'])).toHaveLength(1)
  })

  it('a buying new-pools sniper can’t skip the second yes: the plain Confirm only asks it', async () => {
    const h = await autoBot()
    await reviewNewPools(h, { mode: 'Buy automatically', buys: '1 token' })
    const ok = h.button('Confirm sniper')
    await h.press(ok)
    await h.press(ok)
    expect(h.text()).toContain('Buy automatically?')
    expect(h.text().replace(/<\/?b>/g, '')).toContain('buys 0.5 NEAR of each new token that passes the checks, up to 1 token,')
    expect(await h.service.list(ALICE.id)).toEqual([])
  })

  it('the detail lists the new pools it saw (pool, token, what became of it) and never calls one bought before its trade is confirmed', async () => {
    const h = await autoBot()
    await reviewNewPools(h, { mode: 'Buy automatically', buys: '3 tokens' })
    await h.tap('Confirm sniper')
    await h.tap('Yes, buy automatically')
    const id = (await h.service.list(ALICE.id, ['sniper']))[0]?.id as string
    // What the worker records (runner.ts): each pool once, keyed by its exchange and pool id.
    const dcl = 'pool:dcl:pepe.nearlytrade.near|wrap.testnet|2000'
    await h.autoStore.addDetection({
      strategyId: id,
      sourceKey: dcl,
      side: 'buy',
      token: 'pepe.nearlytrade.near',
      tokenRaw: null,
      nearRaw: (12n * ONE).toString(),
      status: 'detected',
      reason: 'Waiting for a route from a NEARKITS wallet',
    })
    h.advance(1_000)
    await h.autoStore.addDetection({
      strategyId: id,
      sourceKey: 'pool:ref:5120',
      side: 'buy',
      token: 'cook.meme-cooking.near',
      tokenRaw: null,
      nearRaw: ONE.toString(),
      status: 'skipped',
      reason: 'A round trip loses 31.00% (fees, a tax or a thin pool): over 25%',
    })
    h.advance(1_000)
    // Recorded as traded, but its own trade is only sent: no fill is claimed.
    const sent = 'pool:ref:5121'
    await h.autoStore.addDetection({
      strategyId: id,
      sourceKey: sent,
      side: 'buy',
      token: USDT,
      tokenRaw: '1990000',
      nearRaw: (ONE / 2n).toString(),
      status: 'eligible',
      reason: 'checks passed',
    })
    const e = await h.autoStore.addExecution({
      strategyId: id,
      userId: ALICE.id,
      walletId: h.wallet.id,
      idemKey: `sniper:${id}:${sent}`,
      side: 'buy',
      token: USDT,
      amountInRaw: (ONE / 2n).toString(),
      expectedOutRaw: '1990000',
      source: sent,
    })
    await h.autoStore.updateExecution(e?.id as string, ['executing'], 'submitted', { txHashes: ['4bSentNotConfirmed111'] })
    await h.autoStore.updateDetection(id, sent, 'confirmed', { executionId: e?.id as string })
    await h.press(`au:v:${id}`)
    let t = h.text()
    expect(t).toContain('Seen lately')
    expect(t).toContain(
      '🆕 New pool <code>pepe.nearlytrade.near|wrap.testnet|2000</code> (Ref DCL) · <code>pepe.nearlytrade.near</code> · 👀 seen: Waiting for a route from a NEARKITS wallet',
    )
    expect(t).toContain('🆕 New pool <code>5120</code> (Ref v2) · <code>cook.meme-cooking.near</code> · ⏭ skipped: A round trip loses 31.00%')
    expect(t).toContain(`🆕 New pool <code>5121</code> (Ref v2) · <code>${USDT}</code> · 📨 sent, not confirmed yet`)
    expect(t).toContain(`📨 Buy · 0.5 NEAR → ${USDT}`)
    expect(t).not.toContain('confirmed on chain')
    expect(t).not.toContain('bought,')
    // Once the chain confirms its trade, it is called bought.
    await h.autoStore.updateExecution(e?.id as string, ['submitted'], 'confirmed', { nearRaw: (ONE / 2n).toString(), tokenRaw: '1985000', txHashes: ['4bSentNotConfirmed111'] })
    await h.press(`au:v:${id}`)
    t = h.text()
    expect(t).toContain(`🆕 New pool <code>5121</code> (Ref v2) · <code>${USDT}</code> · ✅ bought, confirmed on chain`)
    expect(t).toContain('👀 seen: Waiting for a route')
  })

  it('a detection recorded as traded with no confirmed trade of its own is never called a fill', async () => {
    const h = await autoBot()
    await reviewNewPools(h)
    await h.tap('Confirm sniper')
    const id = (await h.service.list(ALICE.id, ['sniper']))[0]?.id as string
    await h.autoStore.addDetection({
      strategyId: id,
      sourceKey: 'pool:dcl:x.nearlytrade.near|wrap.testnet|2000',
      side: 'buy',
      token: 'x.nearlytrade.near',
      tokenRaw: null,
      nearRaw: null,
      status: 'confirmed',
      reason: null,
    })
    await h.press(`au:v:${id}`)
    expect(h.text()).toContain('📨 sent: see Trades for the chain’s answer')
    expect(h.text()).not.toContain('confirmed on chain')
  })
})

describe('Confirm is idempotent on the server too (a request key per review)', () => {
  /** A notify-only new-pools sniper with no expiry: its configuration is the same whenever it is confirmed. */
  async function reviewTimeless(h: Bot) {
    await h.say('/snipe')
    await h.tap('New sniper')
    await h.tap('New pools')
    await h.tap('⬜ Nearly launches')
    await h.tap('Continue')
    await h.tap('1 NEAR')
    await h.tap('0.5 NEAR')
    await h.tap('1%')
    await h.tap('10%')
    await h.tap('No expiry')
    await h.tap('Notify only')
  }

  it('the key is the review’s: tg-<its Confirm id>, within what the server accepts (anything else is hashed into it)', () => {
    expect(requestKeyOf('AbC_12-xyz')).toBe('tg-AbC_12-xyz')
    for (const odd of ['a.b:c', 'x'.repeat(90), '']) {
      const key = requestKeyOf(odd)
      expect(key).toMatch(REQUEST_KEY)
      expect(key).toBe(requestKeyOf(odd))
    }
    expect(requestKeyOf('a.b:c')).not.toBe(requestKeyOf('a.b:d'))
  })

  it('two Confirms that both get the review (as if the one-time take let both through) reach the server with one key: one sniper', async () => {
    const h = await autoBot()
    await reviewTimeless(h)
    const ok = h.button('Confirm sniper')
    const id = ok.split(':').at(-1) as string
    const create = vi.spyOn(h.service, 'create')
    // The bot's own guard (Store.takeCallback) disabled: both taps get the reviewed setup.
    const take = vi.spyOn(h.store, 'takeCallback').mockImplementation(((cid: string, uid: number) => h.store.getCallback(cid, uid)) as typeof h.store.takeCallback)
    h.advance(10_000)
    await Promise.all([h.pressNow(ok), h.pressNow(ok)])
    take.mockRestore()
    expect(create).toHaveBeenCalledTimes(2)
    const keys = create.mock.calls.map((c) => c[1].requestKey)
    expect(keys).toEqual([`tg-${id}`, `tg-${id}`])
    expect(keys[0]).toMatch(REQUEST_KEY)
    const list = await h.service.list(ALICE.id, ['sniper'])
    expect(list).toHaveLength(1)
    // With the guard back: the row the spy left is taken once more (the server answers with the same sniper), then it is gone.
    await h.press(ok)
    expect(h.text()).toContain('Already created')
    expect(create).toHaveBeenCalledTimes(3)
    await h.press(ok)
    expect(h.text()).toContain('used already')
    expect(create).toHaveBeenCalledTimes(3)
    expect(await h.service.list(ALICE.id, ['sniper'])).toHaveLength(1)
  })

  it('a replay after the review’s record is gone, then with that record brought back (a restore): the server answers with the first sniper, nothing new', async () => {
    const h = await autoBot()
    await reviewTimeless(h)
    const ok = h.button('Confirm sniper')
    const id = ok.split(':').at(-1) as string
    const saved = await h.store.getCallback(id, ALICE.id)
    expect(saved).not.toBeNull()
    await h.press(ok)
    expect(h.text()).toContain('Sniper: new pools created')
    // Replayed with the record gone: the bot stops it.
    await h.press(ok)
    expect(h.text()).toContain('used already')
    // The record back (a restored backup, a replayed write) a minute later: the bot lets it through, the server's key doesn't.
    h.advance(60_000)
    await h.db.run('INSERT INTO callbacks (id, user_id, chat_id, payload, expires_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      ALICE.id,
      ALICE.id,
      JSON.stringify(saved),
      h.deps.now() + 60_000,
    ])
    const create = vi.spyOn(h.service, 'create')
    await h.press(ok)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[1].requestKey).toBe(`tg-${id}`)
    expect(h.text()).toContain('Already created')
    expect(h.text()).toContain('Nothing new was made')
    expect(await h.service.list(ALICE.id, ['sniper'])).toHaveLength(1)
  })

  it('the same review confirmed again at another moment (its expiry counts from then): the server refuses the key, nothing new', async () => {
    const h = await autoBot()
    await h.say('/snipe')
    await h.tap('New sniper')
    await h.tap('One token')
    await h.say('USDT')
    await h.tap('0.5 NEAR')
    await h.tap('1%')
    await h.tap('10%')
    await h.tap('24 hours')
    await h.tap('Notify only')
    const ok = h.button('Confirm sniper')
    const id = ok.split(':').at(-1) as string
    const saved = await h.store.getCallback(id, ALICE.id)
    await h.press(ok)
    expect(h.text()).toContain('Sniper USDT created')
    h.advance(60_000)
    await h.db.run('INSERT INTO callbacks (id, user_id, chat_id, payload, expires_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      ALICE.id,
      ALICE.id,
      JSON.stringify(saved),
      h.deps.now() + 60_000,
    ])
    const create = vi.spyOn(h.service, 'create')
    await h.press(ok)
    // It reached the server, which refused the key (used for this review at another moment).
    expect(create).toHaveBeenCalledTimes(1)
    await expect(create.mock.results[0]?.value).rejects.toMatchObject({ code: 'request' })
    expect(h.text()).toContain('used already')
    expect(h.text()).not.toContain('different automation')
    expect(await h.service.list(ALICE.id, ['sniper'])).toHaveLength(1)
  })
})

describe('Copy Trade’s detail', () => {
  it('each copied leg of a swap links its transaction on the explorer; seen is only seen, and a fill is claimed only once its trade is confirmed', async () => {
    const h = await autoBot()
    const [rule] = await h.service.create(ALICE.id, {
      walletId: h.wallet.id,
      config: {
        kind: 'copy',
        copy: {
          target: 'bob.testnet',
          copy: 'both',
          sizing: { mode: 'fixed', amountNear: 1 },
          maxTradeNear: 1,
          minTradeNear: null,
          maxExposureNear: 5,
          slippagePct: 1,
          minLiquidityUsd: null,
          exclude: [],
        },
      },
    })
    const id = rule?.id as string
    const H = '7Gk2rTswapOfBob9xyz'
    // What the worker records for a token-for-token swap (runner.ts copyOne): the swap, then a sell leg and a buy leg.
    await h.autoStore.addDetection({
      strategyId: id,
      sourceKey: H,
      side: null,
      token: USDT,
      tokenRaw: '5000000',
      nearRaw: null,
      status: 'detected',
      reason: 'A swap of a.testnet for USDT: copied as NEAR trades',
    })
    h.advance(1_000)
    await h.autoStore.addDetection({
      strategyId: id,
      sourceKey: `${H}:sell`,
      side: 'sell',
      token: 'a.testnet',
      tokenRaw: '10',
      nearRaw: null,
      status: 'skipped',
      reason: 'Nothing this rule bought of A is left to sell',
    })
    h.advance(1_000)
    await h.autoStore.addDetection({ strategyId: id, sourceKey: `${H}:buy`, side: 'buy', token: USDT, tokenRaw: '5000000', nearRaw: null, status: 'eligible', reason: null })
    const e = await h.autoStore.addExecution({
      strategyId: id,
      userId: ALICE.id,
      walletId: h.wallet.id,
      idemKey: `copy:${id}:${H}:buy`,
      side: 'buy',
      token: USDT,
      expectedOutRaw: '3980000',
      source: `${H}:buy`,
    })
    await h.autoStore.updateDetection(id, `${H}:buy`, 'executing')
    await h.autoStore.updateExecution(e?.id as string, ['executing'], 'submitted', { txHashes: ['5cOurCopyTx222'] })
    await h.autoStore.updateDetection(id, `${H}:buy`, 'submitted', { executionId: e?.id as string })
    const tx = `href="${h.config.network.explorerUrl}/txns/${H}"`
    await h.press(`au:v:${id}`)
    let t = h.text()
    expect(t).toContain('Seen lately')
    expect(t).toMatch(new RegExp(`↔️ Copied buy leg of <a ${tx}>[^<]+</a> · <code>${USDT}</code> · 📨 sent, not confirmed yet`))
    expect(t).toMatch(new RegExp(`↔️ Copied sell leg of <a ${tx}>[^<]+</a> · <code>a.testnet</code> · ⏭ skipped: Nothing this rule bought of A is left to sell`))
    expect(t).toMatch(new RegExp(`🧾 <a ${tx}>[^<]+</a> · <code>${USDT}</code> · 👀 seen: A swap of a.testnet for USDT`))
    expect(t).not.toContain('confirmed on chain')
    // The chain confirms the copied buy: now, and only now, it is called bought.
    await h.autoStore.updateExecution(e?.id as string, ['submitted'], 'confirmed', { nearRaw: ONE.toString(), tokenRaw: '3975000', txHashes: ['5cOurCopyTx222'] })
    await h.autoStore.updateDetection(id, `${H}:buy`, 'confirmed', { executionId: e?.id as string })
    await h.press(`au:v:${id}`)
    t = h.text()
    expect(t).toMatch(new RegExp(`↔️ Copied buy leg of <a ${tx}>[^<]+</a> · <code>${USDT}</code> · ✅ bought, confirmed on chain`))
    expect(t).toContain('✅ Buy · 1 NEAR → ')
  })
})

describe('DCA (/dca) and /auto', () => {
  it('a DCA plan with a preview, then /auto pauses everything (asked first)', async () => {
    const h = await autoBot()
    await h.say('/dca')
    await h.tap('New DCA')
    await h.say('USDT')
    expect(h.text()).toContain('How much NEAR per buy?')
    await h.tap('0.5 NEAR')
    await h.tap('Every day')
    await h.tap('10')
    await h.tap('1%')
    const review = h.text()
    expect(review).toContain('Buys USDT with <b>0.5 NEAR</b> every day, 10 buys')
    expect(review).toMatch(/Now ≈ <b>0\.\d+ NEAR<\/b>/)
    expect(review).toContain('The first buy is now')
    await h.tap('Start DCA')
    expect(h.text()).toContain('DCA USDT created')
    const [plan] = await h.service.list(ALICE.id, ['dca'])
    expect(plan?.config).toMatchObject({ kind: 'dca', dca: { amountNear: 0.5, everySec: 86_400, maxRuns: 10, endAt: null } })
    // A limit order made on the web (the same service) shows up here too.
    await h.service.create(ALICE.id, {
      walletId: h.wallet.id,
      config: {
        kind: 'limit',
        limit: {
          type: 'limit-buy',
          token: { id: USDT, symbol: 'USDT', decimals: 6 },
          amount: { kind: 'near', value: '1' },
          triggerPriceNear: '0.1',
          slippagePct: 1,
          expiresAt: null,
        },
      },
    })
    await h.say('/auto')
    expect(h.text()).toContain('Your automations')
    expect(h.text()).toContain('DCA: 1 live')
    expect(h.text()).toContain('Limit orders: 1 live')
    expect(h.text()).toContain('Limit buy USDT')
    await h.tap('Pause all')
    expect(h.text()).toContain('Pause all your automations?')
    expect((await h.service.list(ALICE.id)).every((v) => v.status === 'active')).toBe(true)
    await h.tap('Yes, pause all')
    expect((await h.service.list(ALICE.id)).map((v) => v.status)).toEqual(['paused', 'paused'])
    expect(h.toasts().at(-1)).toBe('Paused 2')
  })

  it('/cancel in the middle of a setup leaves nothing behind, and its buttons stop working', async () => {
    const h = await autoBot()
    await h.say('/dca')
    await h.tap('New DCA')
    await h.say('USDT')
    const stale = h.button('0.5 NEAR')
    await h.say('/cancel')
    await h.press(stale)
    expect(h.toasts().at(-1)).toContain('This setup has ended')
    expect(await h.service.list(ALICE.id)).toEqual([])
  })
})

describe('/help', () => {
  it('lists the automation commands; Telegram’s private menu ends with them, after its pinned lead; groups never get them', async () => {
    const h = await autoBot()
    await h.say('/help')
    for (const c of ['/orders', '/copy', '/snipe', '/dca', '/auto']) expect(h.text()).toContain(c)
    const menu = menuCommands(h.app, 'private').map((c) => c.command)
    expect(menu[0]).toBe('start')
    expect(menu.slice(-5)).toEqual(['orders', 'copy', 'snipe', 'dca', 'auto'])
    const group = menuCommands(h.app, 'group').map((c) => c.command)
    for (const c of ['orders', 'copy', 'snipe', 'dca', 'auto']) expect(group).not.toContain(c)
  })
})
