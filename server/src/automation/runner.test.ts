import { describe, expect, it } from 'vitest'
import type { LimitConfig, StrategyKind } from '@/lib/automation/config'
import swapUsdt from '@/services/near/fixtures/flows/testone-swap1-near-to-usdt.fastnear.json'
import storageDeposit from '@/services/near/fixtures/flows/storage-deposit.fastnear.json'
import { ALICE } from '../bot/testing'
import { ONE, USDT, walletBot } from '../bot/walletTesting'
import { SWAP_QUOTE_TTL_MS } from '../custody/swap'
import { silentLogger } from '../log'
import type { AutomationLimits } from './execute'
import { createAutomationRunner } from './runner'
import { createAutomationService } from './service'
import { AutomationStore } from './store'

/**
 * The automation worker over the fake chain and the fake router (USDT, 4 per NEAR unless a test moves
 * it): every trade goes through NEARKITS' real custody path (quote, intent, engine, delivery on chain).
 */

const TOKEN = { id: USDT, symbol: 'USDT', decimals: 6 }
const ALL: StrategyKind[] = ['limit', 'copy', 'sniper', 'dca']

async function setup(opts: { enabled?: StrategyKind[]; limits?: AutomationLimits; fetch?: typeof fetch } = {}) {
  const h = await walletBot()
  const w = await h.funded(20n * ONE, 40_000_000n) // 20 NEAR and 40 USDT
  const store = new AutomationStore(h.db, h.deps.now)
  const enabled = new Set(opts.enabled ?? ALL)
  const notices: string[] = []
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
    })
  const runner = make('a')
  const service = createAutomationService({ store, custody: h.custody, near: h.deps.near, network: h.config.network, enabled, limits: opts.limits, now: h.deps.now })
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

describe('Sniper', () => {
  it('notify-only by default: tells its owner the token trades, buys nothing, and ends', async () => {
    const { w, store, service, tick, notices } = await setup()
    const [s] = await service.create(ALICE.id, {
      walletId: w.id,
      config: { kind: 'sniper', sniper: { token: TOKEN, amountNear: 1, slippagePct: 2, maxImpactPct: 10, minLiquidityUsd: null, maxAttempts: 3, expiresAt: null, mode: 'notify' } },
    })
    if (!s) throw new Error('no sniper')
    await tick(1_000)
    expect((await store.get(s.id))?.status).toBe('completed')
    expect(await store.executionsOf(s.id)).toEqual([])
    expect(notices.at(-1)).toMatch(/tradable now/)
  })

  it('buying needs the owner’s explicit yes; then it buys once, confirmed on chain', async () => {
    const { w, store, service, tick } = await setup()
    const sniper = { token: TOKEN, amountNear: 1, slippagePct: 2, maxImpactPct: 10, minLiquidityUsd: null, maxAttempts: 3, expiresAt: null, mode: 'execute' as const }
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
        if (u.endsWith('/v0/account')) return new Response(JSON.stringify({ account_txs: listed }), { status: 200 })
        if (u.endsWith('/v0/transactions')) return new Response(JSON.stringify({ transactions: txs.filter((t) => body.tx_hashes?.includes(t.transaction.hash)) }), { status: 200 })
        return new Response('not found', { status: 404 })
      }) as typeof fetch,
    }
  }

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
