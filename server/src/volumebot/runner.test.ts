import { describe, expect, it } from 'vitest'
import { defaultBotConfig } from '@/lib/volumeBot/config'
import type { BotConfig } from '@/lib/volumeBot/types'
import { ALICE } from '../bot/testing'
import { ONE, USDT, walletBot } from '../bot/walletTesting'
import { silentLogger } from '../log'
import { createVolumeBotRunner, freshRunState } from './runner'
import { VolumeBotStore } from './store'

/**
 * The Volume Bot's worker over the fake chain and a fake Rhea router (USDT at 4 per NEAR, rate set by
 * the test): its trades go through the same custody path as any NEARKITS trade, and it pauses itself
 * on the guardian's conditions with the exact reason.
 */

const TOKEN = { id: USDT, symbol: 'USDT', decimals: 6 }

async function setup(strategy: BotConfig['strategy'] = 'market-maker', patch: (c: BotConfig) => void = () => {}) {
  const h = await walletBot()
  const w = await h.funded(20n * ONE, 40_000_000n) // 20 NEAR and 40 USDT (10 NEAR's worth)
  const bots = new VolumeBotStore(h.db, h.deps.now)
  const notices: string[] = []
  const runner = createVolumeBotRunner({
    store: bots,
    custody: h.custody,
    near: h.deps.near,
    network: h.config.network,
    log: silentLogger,
    instanceId: 'test',
    notify: async (_user, text) => void notices.push(text),
    now: h.deps.now,
    random: () => 0.5,
  })
  const config = defaultBotConfig(strategy, TOKEN, [w.id])
  config.sizing = { ...config.sizing, mode: strategy === 'market-maker' ? 'fixed' : 'auto', fixedNear: 1 }
  config.schedule = { ...config.schedule, minIntervalSec: 10, maxIntervalSec: 10, cooldownSec: 0 }
  config.risk = { ...config.risk, maxTradeNear: 2, minLiquidityUsd: 0, maxSpreadBps: 2_000 }
  config.inventory = { targetTokenPct: 50, minTokenPct: 5, maxTokenPct: 95, maxNearDeployed: 1_000 }
  patch(config)
  const bot = await bots.create({ userId: ALICE.id, network: 'testnet', config })
  const started = await bots.start(bot.id, freshRunState(h.deps.now()))
  if (!started.ok) throw new Error('not started')
  const step = async (advanceMs = 25_000) => {
    h.advance(advanceMs)
    const b = await bots.get(bot.id)
    if (b && (b.status === 'running' || b.status === 'stopping')) await runner.step(b)
    return bots.get(bot.id)
  }
  return { h, w, bots, bot, runner, step, notices }
}

describe('the market maker on chain', () => {
  it('learns fair value without trading, trades only once the price is off it by its edge, and records what really moved', async () => {
    const { h, bots, bot, step } = await setup()
    for (let i = 0; i < 5; i++) await step()
    expect(await bots.trades(bot.id)).toEqual([])
    expect((await bots.currentRun(bot.id))?.state.fair?.samples).toBe(5)
    // USDT gets cheaper in NEAR (4.2 per NEAR): about 4.8% under fair value, past the 0.5% edge.
    h.market.usdtPerNear = 4_200_000n
    await step()
    const trades = await bots.trades(bot.id)
    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ side: 'buy', status: 'confirmed', nearRaw: ONE.toString() })
    expect(BigInt(trades[0]?.tokenRaw ?? '0')).toBe(4_200_000n)
    const st = (await bots.currentRun(bot.id))?.state
    expect(st?.progress).toMatchObject({ trades: 1, boughtNear: 1, inFlight: 0 })
    expect((await bots.get(bot.id))?.status).toBe('running')
  })

  it('never trades inside the band: at fair value it only waits, and says why', async () => {
    const { bots, bot, step } = await setup()
    for (let i = 0; i < 8; i++) await step()
    expect(await bots.trades(bot.id)).toEqual([])
    expect((await bots.currentRun(bot.id))?.state.waiting).toMatch(/within the band/)
  })
})

describe('the guardian on chain', () => {
  it('pauses on an abnormal price move with the exact reason, and tells the owner', async () => {
    const { h, bots, bot, step, notices } = await setup()
    for (let i = 0; i < 5; i++) await step()
    h.market.usdtPerNear = 2_000_000n // USDT doubles in NEAR
    const after = await step()
    expect(after).toMatchObject({ status: 'paused', pauseCode: 'abnormal-price', pauseReason: expect.stringMatching(/^Abnormal price movement: /) })
    expect(await bots.trades(bot.id)).toEqual([])
    expect((await bots.events(bot.id))[0]).toMatchObject({ kind: 'guardian', code: 'abnormal-price' })
    expect(notices.at(-1)).toMatch(/paused itself/)
  })

  it('pauses every bot when NEARKITS pauses the Volume Bot (its kill switch), and when a balance moves outside its trades', async () => {
    const a = await setup()
    await a.step()
    await a.h.custody.ops.set('volumebot', true, 'maintenance', 'test')
    expect(await a.step()).toMatchObject({ status: 'paused', pauseCode: 'operator' })

    const b = await setup()
    await b.step()
    // Someone withdraws 5 NEAR from the wallet behind the bot's back.
    const acct = b.h.chain.accounts.get(b.w.accountId)
    if (acct) acct.amount -= 5n * ONE
    expect(await b.step()).toMatchObject({ status: 'paused', pauseCode: 'unexpected-balance' })
  })
})

describe('many bots on one worker', () => {
  it('a step that hangs (a confirmation that never comes) holds only its own bot: the tick moves on and the next bot steps', async () => {
    const a = await setup()
    // A second bot of the same user, on its own wallet and token, due at the same time.
    const w2 = await a.h.funded(20n * ONE)
    const cfg = defaultBotConfig('accumulate', { id: 'wrap.testnet', symbol: 'wNEAR', decimals: 24 }, [w2.id])
    cfg.risk.minLiquidityUsd = 0
    const other = await a.bots.create({ userId: ALICE.id, network: 'testnet', config: cfg })
    expect((await a.bots.start(other.id, freshRunState(a.h.deps.now()))).ok).toBe(true)
    const hung = createVolumeBotRunner({
      store: a.bots,
      custody: {
        ...a.h.custody,
        swaps: { ...a.h.custody.swaps, quote: (params, wallet) => (params.token === USDT ? new Promise(() => {}) : a.h.custody.swaps.quote(params, wallet)) },
      },
      near: a.h.deps.near,
      network: a.h.config.network,
      log: silentLogger,
      instanceId: 'test-2',
      notify: async () => undefined,
      now: a.h.deps.now,
      random: () => 0.5,
      stepWaitMs: 50,
    })
    await hung.tick()
    // The USDT bot is still mid-step (its lease held); the other one stepped and asked for its next turn.
    expect((await a.bots.get(other.id))?.nextTickAt).toBeGreaterThan(a.h.deps.now())
    expect((await a.bots.due(10)).map((b) => b.id)).not.toContain(a.bot.id)
  })
})

describe('accumulate, stop and restarts', () => {
  it('accumulates its budget in slices, then completes on its own', async () => {
    const { bots, bot, step } = await setup('accumulate', (c) => {
      c.twap = { totalNear: 1, totalTokens: 0, durationSec: 600, limitPriceNear: null }
      c.schedule = { ...c.schedule, minIntervalSec: 100, maxIntervalSec: 100 }
    })
    let b = await bots.get(bot.id)
    for (let i = 0; i < 12 && b?.status === 'running'; i++) b = await step(100_000)
    expect(b?.status).toBe('completed')
    const trades = await bots.trades(bot.id)
    expect(trades.length).toBeGreaterThan(2)
    expect(trades.every((t) => t.side === 'buy' && t.status === 'confirmed')).toBe(true)
    const spent = trades.reduce((s, t) => s + BigInt(t.nearRaw ?? '0'), 0n)
    expect(spent).toBeLessThanOrEqual(ONE)
  })

  it('a stop pressed while a step is under way sends nothing from that step', async () => {
    const { h, bots, bot, step } = await setup()
    for (let i = 0; i < 5; i++) await step()
    h.market.usdtPerNear = 4_200_000n // away from fair value: this step would buy
    const quote = h.custody.swaps.quote.bind(h.custody.swaps)
    let stopped = false
    h.custody.swaps.quote = async (params, wallet) => {
      const q = await quote(params, wallet)
      // The trade's own quote (1 NEAR; the market probes are smaller): Emergency stop arrives just now.
      if (!stopped && params.side === 'buy' && params.amountIn === '1') {
        stopped = true
        await bots.stop(bot.id, 'Emergency stop by its owner')
      }
      return q
    }
    const sent = h.chain.sent.length
    await step()
    expect(stopped).toBe(true)
    expect(await bots.trades(bot.id)).toEqual([])
    expect(h.chain.sent.length).toBe(sent)
  })

  it('Stop, Emergency stop or Pause pressed after the runner’s last check, while the trade is prepared: nothing is signed or sent', async () => {
    for (const press of ['stop', 'pause'] as const) {
      const { h, bots, bot, step } = await setup()
      for (let i = 0; i < 5; i++) await step()
      h.market.usdtPerNear = 4_200_000n // away from fair value: this step would buy
      const handler = h.custody.swaps.handler
      const plan = handler.plan.bind(handler)
      let pressed = false
      handler.plan = async (intent, wallet) => {
        // The intent is confirmed and the engine is planning its route: the owner presses now.
        if (!pressed) {
          pressed = true
          if (press === 'stop') await bots.stop(bot.id, 'Emergency stop by its owner')
          else await bots.pause(bot.id, 'owner', 'Paused by its owner')
        }
        return plan(intent, wallet)
      }
      const sent = h.chain.sent.length
      await step()
      expect(pressed).toBe(true)
      expect(h.chain.sent.length).toBe(sent)
      if (press === 'stop') {
        // The next step finds nothing was sent and ends the run: no trade recorded.
        expect(await step()).toMatchObject({ status: 'stopped' })
        expect(await bots.trades(bot.id)).toEqual([])
      }
    }
  })

  it('a stop landing just as the runner creates the trade’s intent sends nothing', async () => {
    const { h, bots, bot, step } = await setup()
    for (let i = 0; i < 5; i++) await step()
    h.market.usdtPerNear = 4_200_000n
    const create = h.custody.store.createIntent.bind(h.custody.store)
    let pressed = false
    h.custody.store.createIntent = async (input) => {
      if (!pressed && input.groupId === `vb-${bot.id}`) {
        pressed = true
        await bots.stop(bot.id, 'Emergency stop by its owner')
      }
      return create(input)
    }
    const sent = h.chain.sent.length
    await step()
    expect(pressed).toBe(true)
    expect(h.chain.sent.length).toBe(sent)
  })

  it('NEARKITS pausing every bot (its kill switch) stops a trade already past the runner’s check', async () => {
    const { h, bots, bot, step } = await setup()
    for (let i = 0; i < 5; i++) await step()
    h.market.usdtPerNear = 4_200_000n
    const handler = h.custody.swaps.handler
    const plan = handler.plan.bind(handler)
    let flipped = false
    handler.plan = async (intent, wallet) => {
      if (!flipped) {
        flipped = true
        await h.custody.ops.set('volumebot', true, 'incident', 'test')
      }
      return plan(intent, wallet)
    }
    const sent = h.chain.sent.length
    await step()
    expect(flipped).toBe(true)
    expect(h.chain.sent.length).toBe(sent)
    void bots
    void bot
  })

  it('stop: nothing new is sent, and it ends stopped', async () => {
    const { bots, bot, step } = await setup()
    await step()
    expect(await bots.stop(bot.id, 'Stopped by its owner')).toBe(true)
    expect(await step()).toMatchObject({ status: 'stopped' })
    expect((await bots.events(bot.id))[0]).toMatchObject({ kind: 'stopped' })
  })

  it('after a restart, a trade that was in flight is settled from its intent, never sent again', async () => {
    const { h, w, bots, bot, step } = await setup()
    await step()
    const run = await bots.currentRun(bot.id)
    // A buy the worker had sent when it went down: its intent ran to the end meanwhile.
    const quote = await h.custody.swaps.quote({ side: 'buy', token: USDT, symbol: 'USDT', decimals: 6, amountIn: '1', slippagePct: 1 }, w)
    const intent = await h.custody.store.createIntent({
      walletId: w.id,
      userId: ALICE.id,
      chatId: 0,
      kind: 'buy',
      params: { side: 'buy', token: USDT, symbol: 'USDT', decimals: 6, amountIn: '1', slippagePct: 1 },
      quote,
      ttlMs: 60_000,
    })
    await h.custody.engine.execute(intent.id, ALICE.id)
    await bots.addTrade({
      botId: bot.id,
      runId: run?.id ?? '',
      walletId: w.id,
      intentId: intent.id,
      side: 'buy',
      status: 'submitted',
      nearRaw: ONE.toString(),
      tokenRaw: '4000000',
      priceNear: 0.25,
      impactBps: null,
      feeNear: null,
      gasNear: null,
      nearUsd: null,
      txHash: null,
      message: null,
    })
    const sent = h.chain.sent.length
    await step()
    expect((await bots.trades(bot.id))[0]).toMatchObject({ status: 'confirmed', intentId: intent.id })
    expect(h.chain.sent.length).toBe(sent)
  })
})
