import { describe, expect, it } from 'vitest'
import type { LimitConfig, StrategyKind } from '@/lib/automation/config'
import swapUsdt from '@/services/near/fixtures/flows/testone-swap1-near-to-usdt.fastnear.json'
import storageDeposit from '@/services/near/fixtures/flows/storage-deposit.fastnear.json'
import aggBuy from '@/services/near/fixtures/flows/aggregator-buy-with-rhea.fastnear.json'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import directBuyRpc from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.rpc.json'
import directSell from '@/services/near/fixtures/flows/direct-sell-dcl.fastnear.json'
import { ALICE } from '../bot/testing'
import { ONE, USDT, walletBot } from '../bot/walletTesting'
import { SWAP_QUOTE_TTL_MS } from '../custody/swap'
import { silentLogger } from '../log'
import type { AutomationLimits } from './execute'
import { createPoolFeed, PoolStore } from './pools'
import { createAutomationRunner } from './runner'
import { createAutomationService } from './service'
import { AutomationStore } from './store'

/**
 * The automation worker over the fake chain and the fake router (USDT, 4 per NEAR unless a test moves
 * it): every trade goes through NEARKITS' real custody path (quote, intent, engine, delivery on chain).
 */

const TOKEN = { id: USDT, symbol: 'USDT', decimals: 6 }
const ALL: StrategyKind[] = ['limit', 'copy', 'sniper', 'dca']

async function setup(
  opts: {
    enabled?: StrategyKind[]
    limits?: AutomationLimits
    fetch?: typeof fetch
    poolView?: (contract: string, method: string, args: Record<string, unknown>) => Promise<unknown>
    quotesPerMinute?: number
    sniperBuy?: boolean
  } = {},
) {
  const h = await walletBot()
  const w = await h.funded(20n * ONE, 40_000_000n) // 20 NEAR and 40 USDT
  const store = new AutomationStore(h.db, h.deps.now)
  const enabled = new Set(opts.enabled ?? ALL)
  const notices: string[] = []
  const poolStore = new PoolStore(h.db, h.deps.now)
  const feed = opts.poolView
    ? createPoolFeed({
        store: poolStore,
        view: opts.poolView,
        network: h.config.network,
        nearly: null,
        log: silentLogger,
        now: h.deps.now,
        onReady: (token) => store.wake(h.config.network.id, 'sniper', token),
      })
    : null
  const make = (instanceId: string) =>
    createAutomationRunner({
      store,
      custody: h.custody,
      near: h.deps.near,
      network: h.config.network,
      log: silentLogger,
      instanceId,
      enabled,
      limits: opts.limits,
      fetch: opts.fetch,
      now: h.deps.now,
      notify: async (_user, html) => void notices.push(html),
      pools: { store: poolStore, feed },
      sniperBuy: opts.sniperBuy ?? true,
      ...(opts.quotesPerMinute ? { quotesPerMinute: opts.quotesPerMinute } : {}),
    })
  const runner = make('a')
  const service = createAutomationService({
    store,
    custody: h.custody,
    near: h.deps.near,
    network: h.config.network,
    enabled,
    limits: opts.limits,
    sniperBuy: opts.sniperBuy ?? true,
    now: h.deps.now,
  })
  const order = (limit: Partial<LimitConfig>, pair?: Partial<LimitConfig>) =>
    service.create(ALICE.id, {
      walletId: w.id,
      config: {
        kind: 'limit',
        limit: { type: 'limit-buy', token: TOKEN, amount: { kind: 'near', value: '1' }, triggerPriceNear: '0.24', slippagePct: 1, expiresAt: null, ...limit },
      },
      ...(pair
        ? {
            pair: {
              kind: 'limit',
              limit: { type: 'stop-loss', token: TOKEN, amount: { kind: 'percent', value: 50 }, triggerPriceNear: '0.2', slippagePct: 1, expiresAt: null, ...pair },
            },
          }
        : {}),
    })
  const tick = async (ms = 31_000, r = runner) => {
    h.advance(ms)
    await r.tick()
  }
  return { h, w, store, runner, make, service, order, tick, notices }
}

describe('limit orders', () => {
  it('a limit buy waits above its target, triggers on two readings at or below it, and fills only once the chain delivered', async () => {
    const { h, store, order, tick, notices } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    await tick() // 4 USDT per NEAR: 0.25 NEAR each, above 0.24
    expect((await store.get(o.id))?.status).toBe('active')
    expect((await store.get(o.id))?.state.lastPriceYocto).toBeTruthy()
    h.market.usdtPerNear = 4_200_000n // 0.238 NEAR each: at or below the target
    await tick()
    // The first reading only arms it: nothing is traded on one quote.
    expect(await store.executionsOf(o.id)).toEqual([])
    expect((await store.events(o.id)).map((e) => e.kind)).toContain('trigger-seen')
    await tick(6_000)
    const done = await store.get(o.id)
    expect(done?.status).toBe('filled')
    const [e] = await store.executionsOf(o.id)
    expect(e).toMatchObject({ side: 'buy', status: 'confirmed', nearRaw: ONE.toString(), tokenRaw: '4200000' })
    expect(e?.txHashes.length).toBeGreaterThan(0)
    expect(notices.some((n) => /triggered at/.test(n))).toBe(true)
    expect(notices.at(-1)).toMatch(/filled on chain/)
  })

  it('two workers on the same order make one trade at most (lease and idempotency key)', async () => {
    const { h, store, order, make, runner } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    h.market.usdtPerNear = 4_200_000n
    h.advance(31_000)
    await runner.tick() // armed
    h.advance(6_000)
    await Promise.all([runner.tick(), make('b').tick(), make('c').tick()])
    expect(await store.executionsOf(o.id)).toHaveLength(1)
    expect((await store.get(o.id))?.status).toBe('filled')
  })

  it('a cancel that lands before the trigger is confirmed wins: nothing is traded', async () => {
    const { h, store, order, tick, service } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    h.market.usdtPerNear = 4_200_000n
    await tick() // armed
    await service.cancel(ALICE.id, o.id)
    await tick(6_000)
    expect((await store.get(o.id))?.status).toBe('cancelled')
    expect(await store.executionsOf(o.id)).toEqual([])
  })

  it('a take profit and a stop loss on the same position: the first to trigger sells, the other is cancelled', async () => {
    const { h, store, order, tick, notices } = await setup()
    const [tp, sl] = await order({ type: 'take-profit', amount: { kind: 'percent', value: 50 }, triggerPriceNear: '0.27' }, { triggerPriceNear: '0.2' })
    if (!tp || !sl) throw new Error('no pair')
    expect(tp.ocoGroup).toBeTruthy()
    expect(sl.ocoGroup).toBe(tp.ocoGroup)
    h.market.usdtPerNear = 3_500_000n // USDT up: 0.2857 NEAR each, past the take profit
    await tick()
    await tick(6_000)
    expect((await store.get(tp.id))?.status).toBe('filled')
    expect((await store.get(sl.id))?.status).toBe('cancelled')
    // Half of the 40 USDT was sold.
    expect((await store.executionsOf(tp.id))[0]).toMatchObject({ side: 'sell', status: 'confirmed', tokenRaw: '20000000' })
    expect(await store.executionsOf(sl.id)).toEqual([])
    expect(notices.some((n) => /Take profit/.test(n))).toBe(true)
  })

  it('a stop loss sells when the price falls to its target', async () => {
    const { h, store, order, tick } = await setup()
    const [sl] = await order({ type: 'stop-loss', amount: { kind: 'tokens', value: '10' }, triggerPriceNear: '0.2' })
    if (!sl) throw new Error('no order')
    await tick()
    expect((await store.get(sl.id))?.status).toBe('active')
    h.market.usdtPerNear = 5_500_000n // 0.18 NEAR each
    await tick()
    await tick(6_000)
    expect((await store.get(sl.id))?.status).toBe('filled')
    expect((await store.executionsOf(sl.id))[0]).toMatchObject({ side: 'sell', status: 'confirmed', tokenRaw: '10000000' })
  })

  it('an order to sell more than the wallet holds waits (revalidated each time), it neither trades nor fails', async () => {
    const { h, store, order, tick } = await setup()
    const [o] = await order({ type: 'limit-sell', amount: { kind: 'tokens', value: '1000' }, triggerPriceNear: '0.01' })
    if (!o) throw new Error('no order')
    h.market.usdtPerNear = 4_000_000n
    await tick()
    await tick(6_000)
    const s = await store.get(o.id)
    expect(s?.status).toBe('active')
    expect(s?.state.waiting).toMatch(/holds less USDT/)
    expect(await store.executionsOf(o.id)).toEqual([])
  })

  it('expires unfilled at its expiry, and says so', async () => {
    const { h, store, order, tick, notices } = await setup()
    const [o] = await order({ expiresAt: h.deps.now() + 60_000 })
    if (!o) throw new Error('no order')
    await tick(61_000)
    expect((await store.get(o.id))?.status).toBe('expired')
    expect(notices.at(-1)).toMatch(/expired unfilled/)
  })

  it('NEARKITS’ daily limit on automated buys refuses the trade before anything is signed: the order keeps watching', async () => {
    const { h, store, order, tick } = await setup({ limits: { maxTradeNear: 50, maxDailyNearPerUser: 0.5, maxDailyNearGlobal: 1_000 } })
    const [o] = await order({})
    if (!o) throw new Error('no order')
    h.market.usdtPerNear = 4_200_000n
    await tick()
    await tick(6_000)
    expect(await store.executionsOf(o.id)).toEqual([])
    const s = await store.get(o.id)
    expect(s?.status).toBe('active')
    expect((await store.events(o.id))[0]?.message).toMatch(/24 hours/)
  })

  it('an uncertain outcome (sent, the chain’s answer late) is “submitted”, never filled, never sent twice; it fills once the chain confirms', async () => {
    const { h, store, order, tick, notices } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    h.market.usdtPerNear = 4_200_000n
    await tick() // armed
    h.chain.onSend((tx) => (tx.receiverId === 'wrap.testnet' ? 'hidden' : 'apply'))
    await tick(6_000)
    expect((await store.get(o.id))?.status).toBe('submitted')
    expect(await store.executionsOf(o.id)).toMatchObject([{ status: 'submitted' }])
    expect(notices.some((n) => /filled/.test(n))).toBe(false)
    await tick(31_000)
    await tick(31_000)
    expect(await store.executionsOf(o.id)).toHaveLength(1)
    // The chain answers; the resolver settles the intent, the worker the order.
    h.chain.reveal()
    await h.custody.engine.resolvePending()
    await tick(3_000)
    expect((await store.get(o.id))?.status).toBe('filled')
    expect(await store.executionsOf(o.id)).toMatchObject([{ status: 'confirmed', tokenRaw: '4200000' }])
    expect(notices.at(-1)).toMatch(/filled on chain/)
  })

  it('a trade sent before a restart is settled from its intent: the order fills once the chain says so', async () => {
    const { h, w, store, order } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    // As if a worker triggered it, saved the trade and the intent went through, then the process stopped.
    await store.transition(o.id, ['active'], 'triggered', { attempts: 1 })
    await store.transition(o.id, ['triggered'], 'executing')
    const wallet = await h.custody.store.wallet(w.id)
    if (!wallet) throw new Error('no wallet')
    const params = { side: 'buy' as const, token: USDT, symbol: 'USDT', decimals: 6, amountIn: '1', slippagePct: 1 }
    const quote = await h.custody.swaps.quote(params, wallet)
    const intent = await h.custody.store.createIntent({
      walletId: w.id,
      userId: ALICE.id,
      chatId: 0,
      kind: 'buy',
      params,
      quote,
      ttlMs: SWAP_QUOTE_TTL_MS,
      groupId: `auto-${o.id}`,
    })
    const e = await store.addExecution({ strategyId: o.id, userId: ALICE.id, walletId: w.id, idemKey: `limit:${o.id}:1`, side: 'buy', token: USDT, nearInRaw: ONE.toString() })
    if (!e) throw new Error('no execution')
    await store.updateExecution(e.id, ['executing'], 'executing', { intentId: intent.id })
    await h.custody.engine.execute(intent.id, ALICE.id)
    // A fresh worker (after the restart) settles it.
    const { runner } = {
      runner: createAutomationRunner({
        store,
        custody: h.custody,
        near: h.deps.near,
        network: h.config.network,
        log: silentLogger,
        instanceId: 'after-restart',
        enabled: new Set(ALL),
        now: h.deps.now,
      }),
    }
    h.advance(1_000)
    await runner.tick()
    expect((await store.execution(e.id))?.status).toBe('confirmed')
    expect((await store.get(o.id))?.status).toBe('filled')
  })

  it('cancelling either order of a take profit / stop loss pair cancels the other; nothing of the pair trades afterwards', async () => {
    const { h, store, order, tick, service } = await setup()
    const [tp, sl] = await order({ type: 'take-profit', amount: { kind: 'percent', value: 50 }, triggerPriceNear: '0.27' }, { triggerPriceNear: '0.2' })
    if (!tp || !sl) throw new Error('no pair')
    expect((await service.cancel(ALICE.id, sl.id)).status).toBe('cancelled')
    expect((await store.get(tp.id))?.status).toBe('cancelled')
    expect((await store.events(tp.id))[0]?.message).toMatch(/other order of its pair/)
    // Cancelling either again changes nothing.
    expect((await service.cancel(ALICE.id, tp.id)).status).toBe('cancelled')
    h.market.usdtPerNear = 3_500_000n // past the take profit
    await tick()
    await tick(6_000)
    expect([...(await store.executionsOf(tp.id)), ...(await store.executionsOf(sl.id))]).toEqual([])
  })

  it('a pair whose other order is trading already: cancelling this one leaves that trade alone', async () => {
    const { store, order, service } = await setup()
    const [tp, sl] = await order({ type: 'take-profit', amount: { kind: 'percent', value: 50 }, triggerPriceNear: '0.27' }, { triggerPriceNear: '0.2' })
    if (!tp || !sl) throw new Error('no pair')
    // The take profit triggered (the worker's compare-and-set) a moment before the click on the stop loss.
    await store.transition(tp.id, ['active'], 'triggered', { attempts: 1 })
    expect((await service.cancel(ALICE.id, sl.id)).status).toBe('cancelled')
    expect((await store.get(tp.id))?.status).toBe('triggered')
    // And the triggered one itself can't be cancelled while it trades.
    await expect(service.cancel(ALICE.id, tp.id)).rejects.toMatchObject({ code: 'busy' })
  })

  it('a take profit whose trade isn’t sent keeps its stop loss (the protection stays); the stop loss is cancelled only once a trade fills', async () => {
    const { h, w, store, order, tick } = await setup()
    const [tp, sl] = await order({ type: 'take-profit', amount: { kind: 'percent', value: 50 }, triggerPriceNear: '0.27' }, { triggerPriceNear: '0.2' })
    if (!tp || !sl) throw new Error('no pair')
    h.market.usdtPerNear = 3_500_000n
    await tick() // armed
    await h.custody.store.setFrozen(w.id, 'test') // the trade is refused before anything is signed
    await tick(6_000)
    expect(await store.executionsOf(tp.id)).toEqual([])
    expect((await store.get(tp.id))?.status).toBe('active')
    expect((await store.get(sl.id))?.status).toBe('active')
    await h.custody.store.setFrozen(w.id, null)
    await tick()
    await tick(6_000)
    expect((await store.get(tp.id))?.status).toBe('filled')
    expect((await store.get(sl.id))?.status).toBe('cancelled')
  })

  it('while one order of a pair trades (its outcome still unknown), the other waits even past its own trigger', async () => {
    const { h, store, order, tick } = await setup()
    const [tp, sl] = await order({ type: 'take-profit', amount: { kind: 'percent', value: 50 }, triggerPriceNear: '0.27' }, { triggerPriceNear: '0.2' })
    if (!tp || !sl) throw new Error('no pair')
    h.market.usdtPerNear = 3_500_000n
    await tick() // armed
    h.chain.onSend((tx) => (tx.receiverId === USDT ? 'hidden' : 'apply'))
    await tick(6_000)
    expect((await store.get(tp.id))?.status).toBe('submitted')
    h.market.usdtPerNear = 6_000_000n // 0.1667 NEAR each: past the stop loss too
    await tick()
    await tick(6_000)
    await tick(31_000)
    expect(await store.executionsOf(sl.id)).toEqual([])
    expect((await store.get(sl.id))?.state.waiting).toMatch(/other order of its pair is trading/)
    h.chain.reveal()
    await h.custody.engine.resolvePending()
    await tick(3_000)
    expect((await store.get(tp.id))?.status).toBe('filled')
    expect((await store.get(sl.id))?.status).toBe('cancelled')
  })

  it('the other order of a pair cancelled while this one trades: if this one’s trade isn’t made, it ends cancelled (never watching again)', async () => {
    const { h, store, order, service, tick } = await setup()
    const [tp, sl] = await order({ type: 'take-profit', amount: { kind: 'percent', value: 50 }, triggerPriceNear: '0.27' }, { triggerPriceNear: '0.2' })
    if (!tp || !sl) throw new Error('no pair')
    // The take profit triggered; then its owner cancels the pair from the stop loss.
    await store.transition(tp.id, ['active'], 'triggered', { attempts: 1 })
    expect((await service.cancel(ALICE.id, sl.id)).status).toBe('cancelled')
    expect((await store.get(tp.id))?.cancelRequestedAt).not.toBeNull()
    // Its trade never happened (interrupted): recovered, it is cancelled, not back to watching.
    h.market.usdtPerNear = 3_500_000n
    await tick(130_000)
    await tick(31_000)
    expect((await store.get(tp.id))?.status).toBe('cancelled')
    expect(await store.executionsOf(tp.id)).toEqual([])
  })

  it('a trade refused again and again (a frozen wallet) backs off and is announced once, not every 35 s', async () => {
    const { h, w, store, order, tick, notices } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    h.market.usdtPerNear = 4_200_000n
    await tick() // armed
    await h.custody.store.setFrozen(w.id, 'test')
    for (let i = 0; i < 6; i++) {
      await tick(16 * 60_000)
      await tick(6_000)
    }
    expect(await store.executionsOf(o.id)).toEqual([])
    expect(notices.filter((n) => /triggered at/.test(n))).toHaveLength(1)
    expect(notices.filter((n) => /wasn’t traded/.test(n))).toHaveLength(1)
    expect(Number((await store.get(o.id))?.state.skips)).toBeGreaterThan(1)
  })

  it('a resend whose first answer was lost gets its strategy back, even when a check would refuse it now (the kind switched off)', async () => {
    const { h, w, store } = await setup()
    const enabled = new Set<StrategyKind>(['limit'])
    const service = createAutomationService({ store, custody: h.custody, near: h.deps.near, network: h.config.network, enabled, now: h.deps.now })
    const input = {
      walletId: w.id,
      config: {
        kind: 'limit' as const,
        limit: { type: 'limit-buy' as const, token: TOKEN, amount: { kind: 'near' as const, value: '1' }, triggerPriceNear: '0.24', slippagePct: 1, expiresAt: null },
      },
      requestKey: 'review-lost-answer',
    }
    const [first] = await service.create(ALICE.id, input)
    enabled.delete('limit')
    expect((await service.create(ALICE.id, input)).map((s) => s.id)).toEqual([first?.id])
    await expect(service.create(ALICE.id, { ...input, requestKey: 'review-new-one' })).rejects.toMatchObject({ code: 'off' })
  })

  it('a pair is made both or neither: a second half over the live limit leaves no first half behind', async () => {
    const { store, order } = await setup()
    for (let i = 0; i < 19; i++) await order({ triggerPriceNear: '0.1' })
    await expect(order({ type: 'take-profit', amount: { kind: 'percent', value: 50 }, triggerPriceNear: '0.27' }, { triggerPriceNear: '0.2' })).rejects.toMatchObject({
      code: 'limit',
    })
    const mine = await store.forUser(ALICE.id, 'testnet')
    expect(mine).toHaveLength(19)
    expect(mine.some((s) => s.ocoGroup !== null)).toBe(false)
  })

  it('a request key makes the strategy once: a retry, concurrent repeats and a replay answer with it; the key with another request is refused', async () => {
    const { w, service } = await setup()
    const config = {
      kind: 'limit' as const,
      limit: { type: 'limit-buy' as const, token: TOKEN, amount: { kind: 'near' as const, value: '1' }, triggerPriceNear: '0.24', slippagePct: 1, expiresAt: null },
    }
    const first = await service.create(ALICE.id, { walletId: w.id, config, requestKey: 'review-0001' })
    const repeats = await Promise.all([1, 2, 3].map(() => service.create(ALICE.id, { walletId: w.id, config, requestKey: 'review-0001' })))
    for (const r of repeats) expect(r.map((s) => s.id)).toEqual(first.map((s) => s.id))
    // Two first requests at once (a double tap): one strategy, both answered with it.
    const [a, b] = await Promise.all([1, 2].map(() => service.create(ALICE.id, { walletId: w.id, config, requestKey: 'review-0002' })))
    expect(a?.[0]?.id).toBe(b?.[0]?.id)
    expect(await service.list(ALICE.id)).toHaveLength(2)
    // The same key for a different request.
    await expect(
      service.create(ALICE.id, { walletId: w.id, config: { ...config, limit: { ...config.limit, triggerPriceNear: '0.2' } }, requestKey: 'review-0001' }),
    ).rejects.toMatchObject({ code: 'request' })
    await expect(service.create(ALICE.id, { walletId: w.id, config, requestKey: 'bad key!' })).rejects.toMatchObject({ code: 'request' })
    expect(await service.list(ALICE.id)).toHaveLength(2)
  })

  it('an order whose expiry passes while paused expires; a DCA whose end passes while paused completes', async () => {
    const { h, w, store, order, service, tick, notices } = await setup()
    const [o] = await order({ expiresAt: h.deps.now() + 60_000 })
    const [plan] = await service.create(ALICE.id, {
      walletId: w.id,
      config: {
        kind: 'dca',
        dca: { token: TOKEN, amountNear: 0.5, everySec: 3_600, startAt: h.deps.now() + 600_000, endAt: h.deps.now() + 7_200_000, slippagePct: 1, maxRuns: null },
      },
    })
    if (!o || !plan) throw new Error('no strategies')
    await service.pause(ALICE.id, o.id)
    await service.pause(ALICE.id, plan.id)
    await tick(61_000)
    expect((await store.get(o.id))?.status).toBe('expired')
    expect(notices.at(-1)).toMatch(/expired unfilled while paused/)
    await tick(7_200_000)
    expect((await store.get(plan.id))?.status).toBe('completed')
    expect(notices.at(-1)).toMatch(/completed after 0 buys/)
    expect(await store.executionsOf(plan.id)).toEqual([])
  })

  it('orders far from their trigger share one reference quote per token instead of each quoting; near the trigger they read their own price and trade', async () => {
    const { h, store, order, tick } = await setup()
    const ids: string[] = []
    for (const t of ['0.3', '0.31', '0.32', '0.33'])
      ids.push(((await order({ type: 'take-profit', amount: { kind: 'percent', value: 10 }, triggerPriceNear: t }))[0] as { id: string }).id)
    const real = h.custody.swaps.quote
    let calls = 0
    h.custody.swaps.quote = async (...a) => {
      calls++
      return real(...a)
    }
    await tick() // the first look: each reads its own price
    expect(calls).toBe(4)
    calls = 0
    await tick()
    await tick()
    await tick()
    expect(calls).toBe(3) // one reference quote per look, for the four orders
    for (const id of ids) expect((await store.get(id))?.status).toBe('active')
    h.market.usdtPerNear = 3_200_000n // 0.3125 NEAR per USDT: past 0.3 and 0.31
    await tick()
    await tick(6_000)
    // One wallet trades one at a time: the order that found it busy trades on its next look.
    await tick()
    await tick(6_000)
    expect((await store.get(ids[0] as string))?.status).toBe('filled')
    expect((await store.get(ids[1] as string))?.status).toBe('filled')
    expect((await store.get(ids[2] as string))?.status).toBe('active')
    expect((await store.get(ids[3] as string))?.status).toBe('active')
  })

  it('a frozen wallet trades nothing: the order keeps watching', async () => {
    const { h, w, store, order, tick } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    h.market.usdtPerNear = 4_200_000n
    await tick() // armed
    await h.custody.store.setFrozen(w.id, 'test')
    await tick(6_000)
    expect(await store.executionsOf(o.id)).toEqual([])
    expect((await store.get(o.id))?.status).toBe('active')
  })
})

describe('the kill switch and feature flags', () => {
  it('NEARKITS’ automation switch holds every strategy (nothing is traded) and the engine refuses automated intents', async () => {
    const { h, w, store, order, tick } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    await h.custody.ops.set('automation', true, 'maintenance', 'test')
    h.market.usdtPerNear = 4_200_000n
    await tick()
    await tick(6_000)
    await tick(31_000)
    expect(await store.executionsOf(o.id)).toEqual([])
    expect((await store.get(o.id))?.status).toBe('active')
    expect((await store.events(o.id)).map((e) => e.kind)).toContain('held')
    // The engine's own gate: an automated intent made outside the worker is refused too.
    const wallet = await h.custody.store.wallet(w.id)
    if (!wallet) throw new Error('no wallet')
    const params = { side: 'buy' as const, token: USDT, symbol: 'USDT', decimals: 6, amountIn: '1', slippagePct: 1 }
    const intent = await h.custody.store.createIntent({
      walletId: w.id,
      userId: ALICE.id,
      chatId: 0,
      kind: 'buy',
      params,
      quote: await h.custody.swaps.quote(params, wallet),
      ttlMs: SWAP_QUOTE_TTL_MS,
      groupId: `auto-${o.id}`,
    })
    const refused = await h.custody.engine.execute(intent.id, ALICE.id)
    // The engine ends it before signing: failed, nothing sent, with the switch's reason.
    expect(refused).toMatchObject({ kind: 'finished', intent: { status: 'failed', result: { ok: false, hashes: [], message: expect.stringMatching(/paused automated trading/) } } })
    // Lifted: the order trades again.
    await h.custody.ops.set('automation', false, 'done', 'test')
    await tick()
    await tick(6_000)
    expect((await store.get(o.id))?.status).toBe('filled')
  })

  it('a kind NEARKITS hasn’t switched on is never stepped, and can’t be created', async () => {
    const { h, store, w } = await setup({ enabled: ['copy'] })
    const service = createAutomationService({ store, custody: h.custody, near: h.deps.near, network: h.config.network, enabled: new Set(['copy']), now: h.deps.now })
    await expect(
      service.create(ALICE.id, {
        walletId: w.id,
        config: { kind: 'limit', limit: { type: 'limit-buy', token: TOKEN, amount: { kind: 'near', value: '1' }, triggerPriceNear: '0.3', slippagePct: 1, expiresAt: null } },
      }),
    ).rejects.toMatchObject({ code: 'off' })
  })
})

describe('DCA', () => {
  it('buys on schedule, each buy once, and completes after its runs', async () => {
    const { h, w, store, service, tick } = await setup()
    const [plan] = await service.create(ALICE.id, {
      walletId: w.id,
      config: { kind: 'dca', dca: { token: TOKEN, amountNear: 0.5, everySec: 3_600, startAt: h.deps.now(), endAt: null, slippagePct: 1, maxRuns: 2 } },
    })
    if (!plan) throw new Error('no plan')
    await tick(1_000)
    expect((await store.executionsOf(plan.id)).filter((e) => e.status === 'confirmed')).toHaveLength(1)
    await tick(60_000) // not due yet
    expect(await store.executionsOf(plan.id)).toHaveLength(1)
    await tick(3_600_000)
    expect((await store.executionsOf(plan.id)).filter((e) => e.status === 'confirmed')).toHaveLength(2)
    await tick(3_600_000)
    expect((await store.get(plan.id))?.status).toBe('completed')
    expect(await store.executionsOf(plan.id)).toHaveLength(2)
  })
})

describe('NEARKITS’ daily limits under concurrency', () => {
  it('two buys stepped at the same moment can’t together pass a user’s daily limit: the limit and the record are taken under one lock', async () => {
    const { h, w, store, service, tick } = await setup({ limits: { maxTradeNear: 50, maxDailyNearPerUser: 1.5, maxDailyNearGlobal: 1_000 } })
    // Two wallets of the same user (one wallet trades one at a time anyway).
    const w2 = await h.funded(20n * ONE)
    const plans = []
    for (const wallet of [w, w2])
      plans.push(
        (
          await service.create(ALICE.id, {
            walletId: wallet.id,
            config: { kind: 'dca', dca: { token: TOKEN, amountNear: 1, everySec: 3_600, startAt: h.deps.now(), endAt: null, slippagePct: 1, maxRuns: 1 } },
          })
        )[0] as { id: string },
      )
    await tick(1_000)
    // One trade recorded at all: the other was stopped by the limit before anything was saved for it.
    const all = (await Promise.all(plans.map((p) => store.executionsOf(p.id)))).flat()
    expect(all).toHaveLength(1)
    const events = (await Promise.all(plans.map((p) => store.events(p.id)))).flat().map((e) => e.message)
    expect(events.some((m) => /24 hours/.test(m))).toBe(true)
  })
})

describe('pausing while a trade is on its way', () => {
  it('a DCA buy that settles while its plan is paused still counts; resumed, the next buy is the next run (no wedge, no repeat)', async () => {
    const { h, w, store, service, tick } = await setup()
    const [plan] = await service.create(ALICE.id, {
      walletId: w.id,
      config: { kind: 'dca', dca: { token: TOKEN, amountNear: 0.5, everySec: 3_600, startAt: h.deps.now(), endAt: null, slippagePct: 1, maxRuns: 3 } },
    })
    if (!plan) throw new Error('no plan')
    h.chain.onSend((tx) => (tx.receiverId === 'wrap.testnet' ? 'hidden' : 'apply'))
    await tick(1_000)
    expect(await store.executionsOf(plan.id)).toMatchObject([{ status: 'submitted' }])
    await service.pause(ALICE.id, plan.id)
    h.chain.onSend(() => 'apply')
    h.chain.reveal()
    await h.custody.engine.resolvePending()
    await tick(3_000)
    expect((await store.get(plan.id))?.state).toMatchObject({ runs: 1 })
    expect((await store.get(plan.id))?.status).toBe('paused')
    await service.resume(ALICE.id, plan.id)
    await tick(3_600_000)
    const done = (await store.executionsOf(plan.id)).filter((e) => e.status === 'confirmed').map((e) => e.idemKey)
    expect(done.sort()).toEqual([`dca:${plan.id}:1:0`, `dca:${plan.id}:2:0`])
  })

  it('a DCA try not sent never blocks its run: the next try is its own trade', async () => {
    const { h, w, store, service, tick } = await setup()
    const [plan] = await service.create(ALICE.id, {
      walletId: w.id,
      config: { kind: 'dca', dca: { token: TOKEN, amountNear: 0.5, everySec: 3_600, startAt: h.deps.now() + 3_600_000, endAt: null, slippagePct: 1, maxRuns: 1 } },
    })
    if (!plan) throw new Error('no plan')
    // As if a first try of run 1 was saved and then not sent (before a restart).
    const e = await store.addExecution({ strategyId: plan.id, userId: ALICE.id, walletId: w.id, idemKey: `dca:${plan.id}:1:0`, side: 'buy', token: USDT, nearInRaw: '1' })
    if (!e) throw new Error('no execution')
    await store.updateExecution(e.id, ['executing'], 'cancelled', { message: 'Not sent' })
    await tick(3_600_000)
    await tick(61_000)
    expect((await store.executionsOf(plan.id)).find((x) => x.status === 'confirmed')?.idemKey).toBe(`dca:${plan.id}:1:1`)
  })

  it('a sniper whose buy confirms while it is paused ends completed: it never buys twice', async () => {
    const { h, w, store, service, tick } = await setup()
    const sniper = {
      target: 'token' as const,
      token: TOKEN,
      sources: [],
      minPoolNear: null,
      maxBuys: 1,
      amountNear: 1,
      slippagePct: 2,
      maxImpactPct: 10,
      minLiquidityUsd: null,
      maxAttempts: 3,
      expiresAt: null,
      mode: 'execute' as const,
    }
    const [s] = await service.create(ALICE.id, { walletId: w.id, config: { kind: 'sniper', sniper }, confirmExecute: true })
    if (!s) throw new Error('no sniper')
    h.chain.onSend((tx) => (tx.receiverId === 'wrap.testnet' ? 'hidden' : 'apply'))
    await tick(1_000)
    await service.pause(ALICE.id, s.id)
    h.chain.reveal()
    await h.custody.engine.resolvePending()
    await tick(3_000)
    expect((await store.get(s.id))?.status).toBe('completed')
    await tick(30_000)
    expect(await store.executionsOf(s.id)).toHaveLength(1)
  })
})

describe('Sniper', () => {
  it('notify-only by default: tells its owner the token trades, buys nothing, and ends', async () => {
    const { w, store, service, tick, notices } = await setup()
    const [s] = await service.create(ALICE.id, {
      walletId: w.id,
      config: {
        kind: 'sniper',
        sniper: {
          target: 'token',
          token: TOKEN,
          sources: [],
          minPoolNear: null,
          maxBuys: 1,
          amountNear: 1,
          slippagePct: 2,
          maxImpactPct: 10,
          minLiquidityUsd: null,
          maxAttempts: 3,
          expiresAt: null,
          mode: 'notify',
        },
      },
    })
    if (!s) throw new Error('no sniper')
    await tick(1_000)
    expect((await store.get(s.id))?.status).toBe('completed')
    expect(await store.executionsOf(s.id)).toEqual([])
    expect(notices.at(-1)).toMatch(/tradable now/)
  })

  it('buying needs the owner’s explicit yes; then it buys once, confirmed on chain', async () => {
    const { w, store, service, tick } = await setup()
    const sniper = {
      target: 'token' as const,
      token: TOKEN,
      sources: [],
      minPoolNear: null,
      maxBuys: 1,
      amountNear: 1,
      slippagePct: 2,
      maxImpactPct: 10,
      minLiquidityUsd: null,
      maxAttempts: 3,
      expiresAt: null,
      mode: 'execute' as const,
    }
    await expect(service.create(ALICE.id, { walletId: w.id, config: { kind: 'sniper', sniper } })).rejects.toMatchObject({ code: 'confirm' })
    const [s] = await service.create(ALICE.id, { walletId: w.id, config: { kind: 'sniper', sniper }, confirmExecute: true })
    if (!s) throw new Error('no sniper')
    await tick(1_000)
    expect((await store.get(s.id))?.status).toBe('completed')
    expect(await store.executionsOf(s.id)).toMatchObject([{ side: 'buy', status: 'confirmed' }])
    await tick(30_000)
    expect(await store.executionsOf(s.id)).toHaveLength(1)
  })
})

describe('buying snipers switched off by NEARKITS (NEARKIT_AUTOMATION_SNIPER_BUY off: production’s start)', () => {
  it('a sniper that buys is refused (at the review and at create); one notify-only is made; one set to buy before the switch went off is held, nothing bought', async () => {
    const off = await setup({ sniperBuy: false })
    const sniper = {
      target: 'token' as const,
      token: TOKEN,
      sources: [],
      minPoolNear: null,
      maxBuys: 1,
      amountNear: 1,
      slippagePct: 2,
      maxImpactPct: 10,
      minLiquidityUsd: null,
      maxAttempts: 3,
      expiresAt: null,
    }
    expect((await off.service.features()).sniperBuy).toBe(false)
    await expect(off.service.preview(ALICE.id, off.w.id, { kind: 'sniper', sniper: { ...sniper, mode: 'execute' } })).rejects.toMatchObject({ code: 'off' })
    await expect(
      off.service.create(ALICE.id, { walletId: off.w.id, config: { kind: 'sniper', sniper: { ...sniper, mode: 'execute' } }, confirmExecute: true }),
    ).rejects.toMatchObject({
      code: 'off',
    })
    const [notify] = await off.service.create(ALICE.id, { walletId: off.w.id, config: { kind: 'sniper', sniper: { ...sniper, mode: 'notify' } } })
    expect(notify?.status).toBe('active')
    // A buying sniper made while buying was on, then the switch went off: the worker holds it.
    const on = createAutomationService({
      store: off.store,
      custody: off.h.custody,
      near: off.h.deps.near,
      network: off.h.config.network,
      enabled: new Set(ALL),
      sniperBuy: true,
      now: off.h.deps.now,
    })
    await off.service.cancel(ALICE.id, notify?.id as string)
    const [buyer] = await on.create(ALICE.id, { walletId: off.w.id, config: { kind: 'sniper', sniper: { ...sniper, mode: 'execute' } }, confirmExecute: true })
    if (!buyer) throw new Error('no sniper')
    await off.tick(1_000)
    await off.tick(61_000)
    expect(await off.store.executionsOf(buyer.id)).toEqual([])
    expect((await off.store.get(buyer.id))?.state.waiting).toMatch(/hasn’t switched buying snipers on/)
  })
})

describe('Sniper on new pools', () => {
  /** Ref DCL and Ref v2 as the fake chain names them, with pools the test adds (empty) and funds. */
  function newPools(network: { wrapContract: string; dex: { dcl: { contract: string } }; rhea: { classic: { exchange: string } } }) {
    const wrap = network.wrapContract
    const dcl: Record<string, unknown>[] = []
    const view = async (contract: string, method: string, args: Record<string, unknown>): Promise<unknown> => {
      if (contract === network.dex.dcl.contract && method === 'get_metadata') return { pool_count: String(dcl.length) }
      if (contract === network.dex.dcl.contract && method === 'list_pools') return dcl.slice(Number(args.from_index), Number(args.from_index) + Number(args.limit))
      if (contract === network.dex.dcl.contract && method === 'get_pool') return dcl.find((p) => p.pool_id === args.pool_id) ?? null
      if (contract === network.rhea.classic.exchange && method === 'get_number_of_pools') return 0
      throw new Error(`unexpected view ${contract}.${method}`)
    }
    return {
      view,
      /** A new DCL pool of `token` and wNEAR, holding `near` NEAR (0: empty, as created). */
      add(token: string, near = 0n) {
        const [x, y] = token < wrap ? [token, wrap] : [wrap, token]
        const pool = { pool_id: `${x}|${y}|10000`, token_x: x, token_y: y, fee: 10000, liquidity: near ? '1000' : '0', total_x: '0', total_y: '0', state: 'Running' }
        if (y === wrap) pool.total_y = near.toString()
        else pool.total_x = near.toString()
        dcl.push(pool)
        return pool
      },
      fund(pool: Record<string, unknown>, near: bigint) {
        pool.liquidity = '1000'
        if (pool.token_y === wrap) pool.total_y = near.toString()
        else pool.total_x = near.toString()
      },
    }
  }

  const sniperOnPools = (patch: Record<string, unknown> = {}) => ({
    kind: 'sniper' as const,
    sniper: {
      target: 'new-pools' as const,
      token: null,
      sources: ['other' as const],
      minPoolNear: 1,
      maxBuys: 1,
      amountNear: 1,
      slippagePct: 2,
      maxImpactPct: 10,
      minLiquidityUsd: null,
      maxAttempts: 3,
      expiresAt: null,
      mode: 'notify' as const,
      ...patch,
    },
  })

  it('notify-only: tells its owner of each new pool once it holds NEAR (each once), checked on an executable quote and a round trip; nothing bought', async () => {
    let pools: ReturnType<typeof newPools> | null = null
    const { h, w, store, service, tick, notices } = await setup({ poolView: (c, m, a) => (pools as ReturnType<typeof newPools>).view(c, m, a) })
    pools = newPools(h.config.network)
    const [s] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools() })
    if (!s) throw new Error('no sniper')
    expect(s.subject).toBe('new-pools')
    await tick(5_000) // the feed starts at the counters
    const pool = pools.add(USDT)
    await tick(5_000)
    expect(notices).toEqual([])
    pools.fund(pool, 50n * ONE)
    await tick(5_000) // ready
    await tick(5_000) // the sniper's look
    expect(notices.filter((n) => /Notify-only/.test(n))).toHaveLength(1)
    expect(notices.at(-1)).toMatch(/USDT/)
    expect((await store.detectionsOf(s.id))[0]).toMatchObject({ status: 'eligible', token: USDT, side: 'buy' })
    await tick(5_000)
    await tick(30_000)
    expect(notices.filter((n) => /Notify-only/.test(n))).toHaveLength(1)
    expect(await store.executionsOf(s.id)).toEqual([])
    expect((await store.get(s.id))?.status).toBe('active')
  })

  it('a pool below the sniper’s NEAR minimum, or from a source it doesn’t watch, is not acted on', async () => {
    let pools: ReturnType<typeof newPools> | null = null
    const { h, w, store, service, tick, notices } = await setup({ poolView: (c, m, a) => (pools as ReturnType<typeof newPools>).view(c, m, a) })
    pools = newPools(h.config.network)
    const [thin] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools({ minPoolNear: 100 }) })
    const [nearlyOnly] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools({ sources: ['nearly'] }) })
    if (!thin || !nearlyOnly) throw new Error('no snipers')
    await tick(5_000)
    pools.add(USDT, 50n * ONE)
    for (let i = 0; i < 4; i++) await tick(5_000)
    expect((await store.detectionsOf(thin.id))[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/below this sniper’s 100 NEAR/) })
    expect(await store.detectionsOf(nearlyOnly.id)).toEqual([])
    expect(notices).toEqual([])
  })

  it('buying needs the explicit yes; then it buys a new pool’s token once, confirmed on chain, and completes after its number of tokens', async () => {
    let pools: ReturnType<typeof newPools> | null = null
    const { h, w, store, service, tick, notices } = await setup({ poolView: (c, m, a) => (pools as ReturnType<typeof newPools>).view(c, m, a) })
    pools = newPools(h.config.network)
    await expect(service.create(ALICE.id, { walletId: w.id, config: sniperOnPools({ mode: 'execute' }) })).rejects.toMatchObject({ code: 'confirm' })
    const [s] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools({ mode: 'execute' }), confirmExecute: true })
    if (!s) throw new Error('no sniper')
    await tick(5_000)
    pools.add(USDT, 50n * ONE)
    await tick(5_000)
    await tick(5_000)
    expect(await store.executionsOf(s.id)).toMatchObject([{ side: 'buy', status: 'confirmed', nearRaw: ONE.toString(), source: expect.stringMatching(/^pool:dcl:/) }])
    expect((await store.get(s.id))?.status).toBe('completed')
    expect(notices.at(-1)).toMatch(/new-pools sniper bought/)
    await tick(30_000)
    expect(await store.executionsOf(s.id)).toHaveLength(1)
  })

  it('more pools ready at the same moment than one look takes are all reached (the cursor is the ready time and the pool)', async () => {
    let pools: ReturnType<typeof newPools> | null = null
    const { h, w, store, service, tick, notices } = await setup({ poolView: (c, m, a) => (pools as ReturnType<typeof newPools>).view(c, m, a) })
    pools = newPools(h.config.network)
    const [s] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools() })
    if (!s) throw new Error('no sniper')
    await tick(5_000)
    // Eleven tokens nobody can read, then USDT: all funded in one go (the same ready time).
    for (let i = 0; i < 11; i++) pools.add(`tok${String(i).padStart(2, '0')}.testnet`, 50n * ONE)
    pools.add(USDT, 50n * ONE)
    for (let i = 0; i < 6; i++) await tick(5_000)
    expect(await store.detectionsOf(s.id)).toHaveLength(12)
    expect(notices.filter((n) => /Notify-only/.test(n) && /USDT/.test(n))).toHaveLength(1)
  })

  it('a pool not looked at for lack of quote budget is looked at once the budget refills (never passed over)', async () => {
    let pools: ReturnType<typeof newPools> | null = null
    const { h, w, store, service, tick, notices, order } = await setup({ poolView: (c, m, a) => (pools as ReturnType<typeof newPools>).view(c, m, a), quotesPerMinute: 3 })
    pools = newPools(h.config.network)
    // An order spends one of the three quotes a minute, then rests (paused).
    const [o] = await order({ triggerPriceNear: '0.1' })
    if (!o) throw new Error('no order')
    await tick(5_000)
    await service.pause(ALICE.id, o.id)
    const [s] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools() })
    if (!s) throw new Error('no sniper')
    await tick(5_000)
    pools.add(USDT, 50n * ONE)
    await tick(5_000)
    await tick(5_000)
    // The three quotes it needs (buy, probe, round trip) aren't all there yet: nothing is decided about the pool.
    expect(await store.detectionsOf(s.id)).toEqual([])
    await tick(60_000)
    await tick(5_000)
    expect((await store.detectionsOf(s.id))[0]).toMatchObject({ status: 'eligible', token: USDT })
    expect(notices.filter((n) => /Notify-only/.test(n))).toHaveLength(1)
  })

  it('a pool that became ready while a sniper was paused is no longer new when it resumes: not acted on (another live sniper saw it in time)', async () => {
    let pools: ReturnType<typeof newPools> | null = null
    const { h, w, store, service, tick, notices } = await setup({ poolView: (c, m, a) => (pools as ReturnType<typeof newPools>).view(c, m, a) })
    pools = newPools(h.config.network)
    const [live] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools() })
    const [paused] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools() })
    if (!live || !paused) throw new Error('no snipers')
    await tick(5_000)
    await service.pause(ALICE.id, paused.id)
    pools.add(USDT, 50n * ONE)
    await tick(5_000)
    await tick(5_000)
    expect((await store.detectionsOf(live.id))[0]).toMatchObject({ status: 'eligible' })
    h.advance(6 * 60_000)
    await service.resume(ALICE.id, paused.id)
    await tick(5_000)
    await tick(5_000)
    expect(await store.detectionsOf(paused.id)).toEqual([])
    expect(notices.filter((n) => /Notify-only/.test(n))).toHaveLength(1)
  })

  it('the pool feed runs only while a new-pools sniper is live', async () => {
    const seen: string[] = []
    const { h, w, service, tick } = await setup({
      poolView: async (_contract, method) => {
        seen.push(method)
        return method === 'get_metadata' ? { pool_count: '0' } : 0
      },
    })
    await tick(5_000)
    expect(seen).toEqual([])
    const [s] = await service.create(ALICE.id, { walletId: w.id, config: sniperOnPools() })
    await tick(5_000)
    expect(seen.length).toBeGreaterThan(0)
    if (!s) throw new Error('no sniper')
    await service.cancel(ALICE.id, s.id)
    seen.length = 0
    await tick(5_000)
    expect(seen).toEqual([])
    void h
  })
})

describe('Copy Trade', () => {
  /** FastNEAR's transaction index, faked: the followed account's swap (a real one, moved to the fake chain's contracts) and a storage deposit. */
  function index(now: () => number) {
    const onTestnet = (raw: unknown) =>
      JSON.parse(
        JSON.stringify(raw)
          .replaceAll('usdt.tether-token.near', USDT)
          .replaceAll('wrap.near', 'wrap.testnet')
          .replaceAll('v2.ref-finance.near', 'ref-finance-101.testnet')
          .replaceAll('dclv2.ref-labs.near', 'dclv2.ref-dev.testnet'),
      ) as { transaction: { hash: string; signer_id: string } }
    const swap = onTestnet(swapUsdt)
    const other = onTestnet(storageDeposit)
    other.transaction.signer_id = 'testone.near'
    const txs = [swap, other]
    let listed: { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string }[] = []
    const calls: string[] = []
    return {
      calls,
      /** The two transactions appear in the index now (as if just made). */
      publish() {
        const ns = BigInt(now() - 20_000) * 1_000_000n
        listed = txs.map((t, i) => ({ transaction_hash: t.transaction.hash, tx_block_height: 100 + i, tx_block_timestamp: (ns + BigInt(i)).toString() }))
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        calls.push(u)
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { tx_hashes?: string[] }) : {}
        if (u.endsWith('/status')) return new Response(JSON.stringify({ status: 'ok', lag_seconds: 2 }), { status: 200 })
        if (u.endsWith('/v0/account')) return new Response(JSON.stringify({ account_txs: listed }), { status: 200 })
        if (u.endsWith('/v0/transactions')) return new Response(JSON.stringify({ transactions: txs.filter((t) => body.tx_hashes?.includes(t.transaction.hash)) }), { status: 200 })
        return new Response('not found', { status: 404 })
      }) as typeof fetch,
    }
  }

  /** Mainnet contracts as the fake chain names them (and a real token as the fake chain's USDT). */
  const toTestnet = (raw: unknown, token?: string) => {
    let text = JSON.stringify(raw)
      .replaceAll('usdt.tether-token.near', USDT)
      .replaceAll('wrap.near', 'wrap.testnet')
      .replaceAll('v2.ref-finance.near', 'ref-finance-101.testnet')
      .replaceAll('dclv2.ref-labs.near', 'dclv2.ref-dev.testnet')
    if (token) text = text.replaceAll(token, USDT)
    return JSON.parse(text) as { transaction: { hash: string; signer_id: string } }
  }

  /**
   * A FastNEAR index the test drives: the transactions it lists (each with its age, and whether the
   * account signed it), whether /status answers (and its lag), and which full transactions it serves.
   */
  function drivenIndex(now: () => number) {
    const full = new Map<string, unknown>()
    let listed: { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string; is_signer?: boolean; is_success?: boolean }[] = []
    const state = { up: true, lag: 2, serveFull: true }
    return {
      state,
      add(raw: { transaction: { hash: string } }, opts: { ageMs?: number; signer?: boolean; success?: boolean } = {}) {
        full.set(raw.transaction.hash, raw)
        const ns = BigInt(now() - (opts.ageMs ?? 20_000)) * 1_000_000n
        listed = [
          {
            transaction_hash: raw.transaction.hash,
            tx_block_height: 100 + listed.length,
            tx_block_timestamp: ns.toString(),
            is_signer: opts.signer ?? true,
            is_success: opts.success ?? true,
          },
          ...listed,
        ]
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        if (!state.up) throw new Error('connect ECONNREFUSED')
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { tx_hashes?: string[] }) : {}
        if (u.endsWith('/status')) return new Response(JSON.stringify({ status: 'ok', lag_seconds: state.lag }), { status: 200 })
        if (u.endsWith('/v0/account')) return new Response(JSON.stringify({ account_txs: listed }), { status: 200 })
        if (u.endsWith('/v0/transactions'))
          return new Response(JSON.stringify({ transactions: state.serveFull ? (body.tx_hashes ?? []).map((h) => full.get(h)).filter(Boolean) : [] }), { status: 200 })
        return new Response('not found', { status: 404 })
      }) as typeof fetch,
    }
  }

  const copyRule = (target: string, patch: Record<string, unknown> = {}) => ({
    kind: 'copy' as const,
    copy: {
      target,
      copy: 'both' as const,
      sizing: { mode: 'fixed' as const, amountNear: 1 },
      maxTradeNear: 2,
      minTradeNear: null,
      maxExposureNear: 10,
      slippagePct: 2,
      minLiquidityUsd: null,
      exclude: [],
      ...patch,
    },
  })

  it('a token-for-token swap is copied as NEAR trades: the sell of what the rule holds (nothing yet: recorded), the buy with NEAR', async () => {
    let clock = { now: () => 0 }
    const idx = drivenIndex(() => clock.now())
    const { h, w, store, service, tick } = await setup({ fetch: idx.fetch })
    clock = { now: h.deps.now }
    const [rule] = await service.create(ALICE.id, { walletId: w.id, config: copyRule('alijay3637.tg') })
    if (!rule) throw new Error('no rule')
    h.advance(30_000)
    // RHEA for SINGULARTY on mainnet; SINGULARTY played by the fake chain's USDT.
    const swap = toTestnet(aggBuy, 'singularty.nearlytrade.near')
    idx.add(swap)
    await tick(1_000)
    const d = await store.detectionsOf(rule.id)
    expect(d.find((x) => x.sourceKey === swap.transaction.hash)).toMatchObject({ status: 'detected', token: USDT })
    expect(d.find((x) => x.sourceKey === `${swap.transaction.hash}:sell`)).toMatchObject({ side: 'sell', status: 'skipped' })
    expect(d.find((x) => x.sourceKey === `${swap.transaction.hash}:buy`)).toMatchObject({ side: 'buy', token: USDT, status: 'confirmed' })
    expect(await store.executionsOf(rule.id)).toMatchObject([{ side: 'buy', status: 'confirmed', nearRaw: ONE.toString(), source: `${swap.transaction.hash}:buy` }])
  })

  it('a trade seen too long after it happened (the index behind) is recorded, not copied; the lag is said on the rule', async () => {
    let clock = { now: () => 0 }
    const idx = drivenIndex(() => clock.now())
    const { h, w, store, service, tick } = await setup({ fetch: idx.fetch })
    clock = { now: h.deps.now }
    const [rule] = await service.create(ALICE.id, { walletId: w.id, config: copyRule('testone.near') })
    if (!rule) throw new Error('no rule')
    h.advance(600_000)
    idx.state.lag = 240
    idx.add(toTestnet(swapUsdt), { ageMs: 240_000 })
    await tick(1_000)
    expect(await store.executionsOf(rule.id)).toEqual([])
    expect((await store.detectionsOf(rule.id))[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/after it happened/) })
    expect((await service.list(ALICE.id))[0]?.waiting).toMatch(/240 s behind/)
  })

  it('the index down: the rule waits and says so, its owner is told once after 10 minutes; back up, it copies what is still fresh', async () => {
    let clock = { now: () => 0 }
    const idx = drivenIndex(() => clock.now())
    const { h, w, store, service, tick, notices } = await setup({ fetch: idx.fetch })
    clock = { now: h.deps.now }
    const [rule] = await service.create(ALICE.id, { walletId: w.id, config: copyRule('testone.near') })
    if (!rule) throw new Error('no rule')
    idx.state.up = false
    for (let i = 0; i < 12; i++) await tick(61_000)
    expect((await service.list(ALICE.id))[0]?.waiting).toMatch(/isn’t answering/)
    expect(notices.filter((n) => /hasn’t answered/.test(n))).toHaveLength(1)
    idx.state.up = true
    idx.add(toTestnet(swapUsdt))
    await tick(61_000)
    expect(await store.executionsOf(rule.id)).toMatchObject([{ side: 'buy', status: 'confirmed' }])
    expect((await store.events(rule.id)).map((e) => e.message).join(' ')).toMatch(/answers again/)
  })

  it('a transaction the index lists but can’t serve is read from NEAR RPC (the account signed it) and copied', async () => {
    let clock = { now: () => 0 }
    const idx = drivenIndex(() => clock.now())
    const { h, w, store, service, tick } = await setup({ fetch: idx.fetch })
    clock = { now: h.deps.now }
    const [rule] = await service.create(ALICE.id, { walletId: w.id, config: copyRule('mort1705.tg') })
    if (!rule) throw new Error('no rule')
    h.advance(30_000)
    const viaRpc = toTestnet(directBuyRpc, 'singularty.nearlytrade.near')
    idx.state.serveFull = false
    idx.add(viaRpc)
    const rpc = h.deps.near.ctx.rpc
    const real = rpc.txStatus.bind(rpc)
    rpc.txStatus = (async (hash: string, sender: string, wait?: never) => (hash === viaRpc.transaction.hash ? viaRpc : real(hash, sender, wait))) as typeof rpc.txStatus
    await tick(1_000)
    expect(await store.executionsOf(rule.id)).toMatchObject([{ side: 'buy', status: 'confirmed', source: viaRpc.transaction.hash }])
  })

  it('a transaction neither the index nor RPC can serve is tried again a few times, then recorded as skipped (never silently lost)', async () => {
    let clock = { now: () => 0 }
    const idx = drivenIndex(() => clock.now())
    const { h, w, store, service, tick } = await setup({ fetch: idx.fetch })
    clock = { now: h.deps.now }
    const [rule] = await service.create(ALICE.id, { walletId: w.id, config: copyRule('testone.near') })
    if (!rule) throw new Error('no rule')
    h.advance(30_000)
    idx.state.serveFull = false
    const swap = toTestnet(swapUsdt)
    idx.add(swap)
    const rpc = h.deps.near.ctx.rpc
    rpc.txStatus = (async () => {
      throw new Error('UNKNOWN_TRANSACTION')
    }) as typeof rpc.txStatus
    await tick(1_000)
    for (let i = 0; i < 3; i++) await tick(10_000)
    expect(await store.detectionsOf(rule.id)).toEqual([])
    await tick(10_000)
    await tick(10_000)
    expect((await store.detectionsOf(rule.id))[0]).toMatchObject({ sourceKey: swap.transaction.hash, status: 'skipped', reason: expect.stringMatching(/couldn’t be read/) })
    expect(await store.executionsOf(rule.id)).toEqual([])
  })

  it('a sell of the followed account while this rule’s own buy is still on its way waits for it, then sells: never left holding', async () => {
    let clock = { now: () => 0 }
    const idx = drivenIndex(() => clock.now())
    const { h, w, store, service, tick } = await setup({ fetch: idx.fetch })
    clock = { now: h.deps.now }
    const [rule] = await service.create(ALICE.id, { walletId: w.id, config: copyRule('testone.near') })
    if (!rule) throw new Error('no rule')
    h.advance(30_000)
    idx.add(toTestnet(swapUsdt), { ageMs: 25_000 })
    h.chain.onSend((tx) => (tx.receiverId === 'wrap.testnet' ? 'hidden' : 'apply'))
    await tick(1_000)
    expect(await store.executionsOf(rule.id)).toMatchObject([{ side: 'buy', status: 'submitted' }])
    // The account sells USDT (a real DCL sell, its token played by USDT) before our buy has settled.
    const sell = JSON.parse(JSON.stringify(toTestnet(directSell, 'singularty.nearlytrade.near')).replaceAll('iwillwin.user.intear.near', 'testone.near')) as {
      transaction: { hash: string }
    }
    idx.add(sell)
    await tick(21_000)
    expect((await store.detectionsOf(rule.id)).find((d) => d.sourceKey === sell.transaction.hash)).toMatchObject({
      status: 'detected',
      reason: expect.stringMatching(/still on its way/),
    })
    h.chain.reveal()
    await h.custody.engine.resolvePending()
    await tick(3_000)
    await tick(16_000)
    const trades = await store.executionsOf(rule.id)
    expect(trades.find((e) => e.side === 'buy')).toMatchObject({ status: 'confirmed' })
    expect(trades.find((e) => e.side === 'sell')).toMatchObject({ status: 'confirmed', source: sell.transaction.hash })
  })

  it('exposure counts buys still under way: a second copy that would pass the limit is skipped before anything is signed', async () => {
    let clock = { now: () => 0 }
    const idx = drivenIndex(() => clock.now())
    const { h, w, store, service, tick } = await setup({ fetch: idx.fetch })
    clock = { now: h.deps.now }
    const [rule] = await service.create(ALICE.id, { walletId: w.id, config: copyRule('testone.near', { maxTradeNear: 1, maxExposureNear: 1 }) })
    if (!rule) throw new Error('no rule')
    h.advance(30_000)
    idx.add(toTestnet(swapUsdt))
    h.chain.onSend((tx) => (tx.receiverId === 'wrap.testnet' ? 'hidden' : 'apply'))
    await tick(1_000)
    expect(await store.executionsOf(rule.id)).toMatchObject([{ side: 'buy', status: 'submitted' }])
    // A second buy of the same account, while the first is still on its way.
    const second = toTestnet(directBuy, 'singularty.nearlytrade.near')
    second.transaction.signer_id = 'testone.near'
    idx.add(JSON.parse(JSON.stringify(second).replaceAll('mort1705.tg', 'testone.near')) as typeof second)
    await tick(31_000)
    expect(await store.executionsOf(rule.id)).toHaveLength(1)
    expect((await store.detectionsOf(rule.id)).find((d) => d.sourceKey === second.transaction.hash)).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/exposure/) })
  })

  it('copies a NEAR swap of the followed account once, within its limits; other transactions are skipped with their reason', async () => {
    let clock = { now: () => 0 }
    const idx = index(() => clock.now())
    const { h, w, store, service, tick, notices } = await setup({ fetch: idx.fetch })
    clock = { now: h.deps.now }
    const [rule] = await service.create(ALICE.id, {
      walletId: w.id,
      config: {
        kind: 'copy',
        copy: {
          target: 'testone.near',
          copy: 'both',
          sizing: { mode: 'fixed', amountNear: 1 },
          maxTradeNear: 2,
          minTradeNear: null,
          maxExposureNear: 10,
          slippagePct: 2,
          minLiquidityUsd: null,
          exclude: [],
        },
      },
    })
    if (!rule) throw new Error('no rule')
    await tick(1_000) // nothing yet: history before the rule is never copied
    expect(await store.detectionsOf(rule.id)).toEqual([])
    h.advance(30_000)
    idx.publish()
    await tick(1_000)
    const detections = await store.detectionsOf(rule.id)
    expect(detections).toHaveLength(2)
    const copied = detections.find((d) => d.side === 'buy')
    expect(copied).toMatchObject({ token: USDT, status: 'confirmed' })
    expect(detections.find((d) => d.side === null)).toMatchObject({ status: 'skipped' })
    const [e] = await store.executionsOf(rule.id)
    expect(e).toMatchObject({ side: 'buy', status: 'confirmed', nearRaw: ONE.toString(), source: copied?.sourceKey })
    expect(notices.at(-1)).toMatch(/Copied/)
    // Read again: each source transaction is copied once.
    await tick(30_000)
    await tick(30_000)
    expect(await store.executionsOf(rule.id)).toHaveLength(1)
  })

  it('never follows a NEARKITS wallet (copies of copies would loop)', async () => {
    const { h, w, service } = await setup()
    const other = await h.funded(2n * ONE)
    await expect(
      service.create(ALICE.id, {
        walletId: w.id,
        config: {
          kind: 'copy',
          copy: {
            target: other.accountId,
            copy: 'both',
            sizing: { mode: 'fixed', amountNear: 1 },
            maxTradeNear: 2,
            minTradeNear: null,
            maxExposureNear: 10,
            slippagePct: 2,
            minLiquidityUsd: null,
            exclude: [],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'target' })
  })
})

describe('who may touch what', () => {
  it('another user can’t see, pause, resume or cancel someone’s automation, nor trade from their wallet', async () => {
    const { w, order, service } = await setup()
    const [o] = await order({})
    if (!o) throw new Error('no order')
    const BOB = 202
    await expect(service.detail(BOB, o.id)).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.pause(BOB, o.id)).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.cancel(BOB, o.id)).rejects.toMatchObject({ code: 'not-found' })
    expect(await service.list(BOB)).toEqual([])
    await expect(
      service.create(BOB, {
        walletId: w.id,
        config: { kind: 'limit', limit: { type: 'limit-buy', token: TOKEN, amount: { kind: 'near', value: '1' }, triggerPriceNear: '0.3', slippagePct: 1, expiresAt: null } },
      }),
    ).rejects.toMatchObject({ code: 'wallet' })
  })

  it('pause, resume and pause all: a paused strategy is never stepped', async () => {
    const { h, store, order, service, tick } = await setup()
    const [a] = await order({})
    const [b] = await order({ triggerPriceNear: '0.1' })
    if (!a || !b) throw new Error('no orders')
    await service.pause(ALICE.id, a.id)
    h.market.usdtPerNear = 4_200_000n
    await tick()
    await tick(6_000)
    expect(await store.executionsOf(a.id)).toEqual([])
    expect((await store.get(a.id))?.status).toBe('paused')
    await service.resume(ALICE.id, a.id)
    expect(await service.pauseAll(ALICE.id)).toBe(2)
    expect((await service.list(ALICE.id)).map((s) => s.status)).toEqual(['paused', 'paused'])
  })
})
