import { describe, expect, it } from 'vitest'
import { defaultBotConfig, MIN_EDGE_BPS } from './config'
import { acceptQuote, decide, edgesFor, MIN_FAIR_SAMPLES, MIN_TRADE_NEAR, updateFairValue } from './strategy'
import type { BotConfig, BotWallet, FairValue, MarketSnapshot, RunProgress, TradeQuote } from './types'

const T = Date.UTC(2026, 9, 6, 12)
const TOKEN = { id: 'tkn.example.near', symbol: 'TKN', decimals: 18 }
const wallet = (id: string, near: number, tokens: number, patch: Partial<BotWallet> = {}): BotWallet => ({
  walletId: id,
  label: id,
  accountId: `${id}.near`,
  near,
  tokens,
  frozen: false,
  busy: false,
  ...patch,
})
const market = (mid: number, patch: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  at: T,
  midNear: mid,
  askNear: mid * 1.008,
  bidNear: mid * 0.992,
  liquidityUsd: 100_000,
  nearUsd: 5,
  source: 'test',
  ...patch,
})
const fair = (value: number, samples = 20): FairValue => ({ value, at: T, samples })
const run = (patch: Partial<RunProgress> = {}): RunProgress => ({ startedAt: T - 3_600_000, trades: 0, boughtNear: 0, soldTokens: 0, lastTradeAt: null, inFlight: 0, ...patch })
const mm = (patch: (c: BotConfig) => void = () => {}) => {
  const c = defaultBotConfig('market-maker', TOKEN, ['a', 'b'])
  c.sizing = { ...c.sizing, mode: 'fixed', fixedNear: 1 }
  c.risk.maxTradeNear = 10
  c.inventory = { targetTokenPct: 50, minTokenPct: 20, maxTokenPct: 80, maxNearDeployed: 1_000 }
  c.marketMaker = { minEdgeBps: 50, skew: 0.5, fairValueWindowSec: 3600 }
  patch(c)
  return c
}
const at50 = [wallet('a', 10, 1_000), wallet('b', 10, 1_000)] // 20 NEAR + 2,000 TKN at 0.01 = 50 % token

describe('fair value', () => {
  it('is a time-weighted average of the mid price: recent prices count more, a long gap resets toward the latest', () => {
    let f = updateFairValue(null, 1, T, 3600)
    expect(f).toEqual({ value: 1, at: T, samples: 1 })
    f = updateFairValue(f, 2, T + 60_000, 3600)
    expect(f.value).toBeGreaterThan(1)
    expect(f.value).toBeLessThan(1.05)
    const later = updateFairValue(f, 2, T + 100 * 3_600_000, 3600)
    expect(later.value).toBeCloseTo(2, 5)
  })
})

describe('the market maker’s edges', () => {
  it('are symmetric at the target inventory', () => {
    const e = edgesFor(mm(), 50)
    expect(e.buyEdgeBps).toBeCloseTo(50)
    expect(e.sellEdgeBps).toBeCloseTo(50)
  })

  it('lean toward rebalancing: holding too much makes selling easier and buying harder, never below the floor', () => {
    const high = edgesFor(mm(), 80)
    expect(high.sellEdgeBps).toBeLessThan(50)
    expect(high.buyEdgeBps).toBeGreaterThan(50)
    expect(high.sellEdgeBps).toBeGreaterThanOrEqual(MIN_EDGE_BPS)
    const low = edgesFor(mm(), 20)
    expect(low.buyEdgeBps).toBeLessThan(50)
    expect(low.sellEdgeBps).toBeGreaterThan(50)
    expect(
      edgesFor(
        mm((c) => (c.marketMaker.skew = 1)),
        80,
      ).sellEdgeBps,
    ).toBe(MIN_EDGE_BPS)
  })
})

describe('the market maker decides', () => {
  const input = (patch: Partial<Parameters<typeof decide>[0]> = {}) => ({
    config: mm(),
    market: market(0.01),
    fair: fair(0.01),
    wallets: at50,
    progress: run(),
    now: T,
    random: () => 0.5,
    ...patch,
  })

  it('waits while it learns fair value', () => {
    expect(decide(input({ fair: fair(0.01, MIN_FAIR_SAMPLES - 1) }))).toMatchObject({ kind: 'wait', reason: expect.stringMatching(/Learning fair value/) })
  })

  it('never trades while the price sits at fair value: costs alone would lose', () => {
    expect(decide(input())).toMatchObject({ kind: 'wait', reason: expect.stringMatching(/within the band/) })
  })

  it('buys when the executable price is below fair value by more than the edge, from the wallet with the most spendable NEAR', () => {
    const d = decide(input({ market: market(0.0095, { askNear: 0.0096 }), wallets: [wallet('a', 4, 1_000), wallet('b', 16, 1_000)] }))
    expect(d).toMatchObject({ kind: 'trade', side: 'buy', walletId: 'b', sizeNear: 1 })
    if (d.kind === 'trade') expect(d.maxPriceNear).toBeCloseTo(0.01 * (1 - 50 / 10_000))
  })

  it('sells when the executable price is above fair value by more than the edge, from the wallet holding the most', () => {
    const d = decide(input({ market: market(0.0106, { bidNear: 0.0105 }), wallets: [wallet('a', 10, 1_500), wallet('b', 10, 500)] }))
    expect(d).toMatchObject({ kind: 'trade', side: 'sell', walletId: 'a' })
    if (d.kind === 'trade') expect(d.minPriceNear).toBeCloseTo(0.01 * (1 + 50 / 10_000))
  })

  it('never buys past its maximum exposure, and never sells below its minimum', () => {
    const heavy = [wallet('a', 2, 4_000), wallet('b', 2, 4_000)] // 80 % token
    expect(decide(input({ market: market(0.009, { askNear: 0.009 }), wallets: heavy }))).toMatchObject({ kind: 'wait' })
    const light = [wallet('a', 40, 250), wallet('b', 40, 250)] // ~6 % token
    expect(decide(input({ market: market(0.011, { bidNear: 0.011 }), wallets: light }))).toMatchObject({ kind: 'wait' })
  })

  it('sizes no larger than the wallet can spend above its gas reserve, nor the exposure room', () => {
    const d = decide(input({ config: mm((c) => (c.sizing.fixedNear = 50)), market: market(0.0095, { askNear: 0.0096 }), wallets: [wallet('a', 3, 1_000), wallet('b', 2, 1_000)] }))
    expect(d.kind).toBe('trade')
    if (d.kind === 'trade') expect(d.sizeNear).toBeLessThanOrEqual(3 - mm().risk.gasReserveNear)
  })

  it('skips frozen and busy wallets', () => {
    const d = decide(
      input({ market: market(0.0095, { askNear: 0.0096 }), wallets: [wallet('a', 30, 1_000, { busy: true }), wallet('b', 10, 1_000, { frozen: true }), wallet('c', 5, 0)] }),
    )
    expect(d).toMatchObject({ kind: 'trade', walletId: 'c' })
  })

  it('waits when every possible trade is dust', () => {
    const d = decide(input({ config: mm((c) => (c.sizing.fixedNear = MIN_TRADE_NEAR / 2)), market: market(0.0095, { askNear: 0.0096 }) }))
    expect(d).toMatchObject({ kind: 'wait' })
  })
})

describe('accumulate (TWAP buy)', () => {
  const acc = (patch: (c: BotConfig) => void = () => {}) => {
    const c = defaultBotConfig('accumulate', TOKEN, ['a'])
    c.twap = { totalNear: 10, totalTokens: 0, durationSec: 10 * 3600, limitPriceNear: null }
    c.schedule.minIntervalSec = 600
    c.schedule.maxIntervalSec = 600
    c.inventory = { targetTokenPct: 100, minTokenPct: 0, maxTokenPct: 100, maxNearDeployed: 1_000 }
    c.risk.maxAggregateExposurePct = 100
    c.risk.maxWalletExposurePct = 100
    patch(c)
    return c
  }
  const input = (patch: Partial<Parameters<typeof decide>[0]> = {}) => ({
    config: acc(),
    market: market(0.01),
    fair: null,
    wallets: [wallet('a', 20, 0)],
    progress: run({ startedAt: T }),
    now: T,
    random: () => 0.5,
    ...patch,
  })

  it('spreads what remains over the time that remains, slice by slice', () => {
    // 10 NEAR over 10 hours, a slice every 10 minutes: 60 slices of 1/6 NEAR.
    const d = decide(input())
    expect(d).toMatchObject({ kind: 'trade', side: 'buy', walletId: 'a' })
    if (d.kind === 'trade') expect(d.sizeNear).toBeCloseTo(10 / 60, 5)
  })

  it('waits while the price is above its cap', () => {
    expect(decide(input({ config: acc((c) => (c.twap.limitPriceNear = 0.009)) }))).toMatchObject({ kind: 'wait', reason: expect.stringMatching(/above your limit/) })
  })

  it('completes once its budget is spent, or its period is over', () => {
    expect(decide(input({ progress: run({ startedAt: T, boughtNear: 10 }) }))).toMatchObject({ kind: 'complete' })
    expect(decide(input({ now: T + 11 * 3600_000 }))).toMatchObject({ kind: 'complete' })
  })
})

describe('distribute (TWAP sell)', () => {
  it('sells its amount in slices, above its floor only', () => {
    const c = defaultBotConfig('distribute', TOKEN, ['a'])
    c.twap = { totalNear: 0, totalTokens: 6_000, durationSec: 3600, limitPriceNear: 0.009 }
    c.schedule.minIntervalSec = 600
    c.schedule.maxIntervalSec = 600
    c.inventory = { targetTokenPct: 0, minTokenPct: 0, maxTokenPct: 100, maxNearDeployed: 1_000 }
    c.risk.maxTradeNear = 100
    const base = { config: c, market: market(0.01), fair: null, wallets: [wallet('a', 5, 10_000)], progress: run({ startedAt: T }), now: T, random: () => 0.5 }
    const d = decide(base)
    expect(d).toMatchObject({ kind: 'trade', side: 'sell' })
    // 6,000 tokens over 6 slices: 1,000 tokens, worth 10 NEAR at the bid.
    if (d.kind === 'trade') expect(d.sizeNear).toBeCloseTo(1_000 * 0.01 * 0.992, 3)
    expect(decide({ ...base, market: market(0.008, { bidNear: 0.0079 }) })).toMatchObject({ kind: 'wait', reason: expect.stringMatching(/below your floor/) })
    expect(decide({ ...base, progress: run({ startedAt: T, soldTokens: 6_000 }) })).toMatchObject({ kind: 'complete' })
  })
})

describe('a quote before it is executed', () => {
  const intent = { kind: 'trade' as const, side: 'buy' as const, walletId: 'a', sizeNear: 1, reason: '', maxPriceNear: 0.00995, minPriceNear: null }
  const quote = (patch: Partial<TradeQuote> = {}): TradeQuote => ({ side: 'buy', near: 1, tokens: 101, priceNear: 1 / 101, priceImpactBps: 40, at: T, ...patch })
  const risk = mm().risk
  const sizing = mm().sizing

  it('is accepted when it beats the strategy’s price, is fresh and within the impact limit', () => {
    expect(acceptQuote(intent, quote(), risk, sizing, T)).toEqual({ ok: true })
  })

  it('is refused when its own price misses the strategy’s (after fees and impact)', () => {
    expect(acceptQuote(intent, quote({ tokens: 99, priceNear: 1 / 99 }), risk, sizing, T)).toMatchObject({ ok: false, action: 'skip' })
  })

  it('is too old to execute after its time', () => {
    expect(acceptQuote(intent, quote({ at: T - (risk.maxQuoteAgeSec + 1) * 1000 }), risk, sizing, T)).toMatchObject({
      ok: false,
      action: 'skip',
      reason: expect.stringMatching(/stale/i),
    })
  })

  it('over the impact limit: a smaller trade when adaptive sizing is on, else skipped', () => {
    expect(acceptQuote(intent, quote({ priceImpactBps: risk.maxPriceImpactBps + 50 }), risk, sizing, T)).toMatchObject({ ok: false, action: 'shrink' })
    expect(acceptQuote(intent, quote({ priceImpactBps: risk.maxPriceImpactBps + 50 }), risk, { ...sizing, adaptiveImpact: false }, T)).toMatchObject({ ok: false, action: 'skip' })
  })
})
