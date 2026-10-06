import { describe, expect, it } from 'vitest'
import { defaultBotConfig } from './config'
import { guardBalances, guardFill, guardHealth, guardLoss, guardMarket, spreadCheck } from './risk'
import type { MarketSnapshot } from './types'

const T = Date.UTC(2026, 9, 6, 12)
const risk = defaultBotConfig('market-maker', { id: 't.near', symbol: 'T', decimals: 18 }, ['a']).risk
const snap = (mid: number, patch: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  at: T,
  midNear: mid,
  askNear: mid * 1.005,
  bidNear: mid * 0.995,
  liquidityUsd: 50_000,
  nearUsd: 5,
  source: 't',
  ...patch,
})

describe('the guardian, on the market', () => {
  const guard = (patch: Partial<Parameters<typeof guardMarket>[0]> = {}) =>
    guardMarket({ market: snap(0.01), prev: null, fair: { value: 0.01, at: T, samples: 10 }, risk, now: T, baselineLiquidityUsd: 50_000, ...patch })

  it('lets a calm, fresh, liquid market through', () => {
    expect(guard()).toBeNull()
  })

  it('pauses on stale market data, naming its age', () => {
    expect(guard({ market: snap(0.01, { at: T - (risk.maxDataAgeSec + 5) * 1000 }) })).toMatchObject({ code: 'stale-market-data' })
  })

  it('pauses when no provider answered at all', () => {
    expect(guard({ market: null })).toMatchObject({ code: 'provider-failure' })
  })

  it('pauses under the liquidity floor, and when liquidity collapses from where the run began', () => {
    expect(guard({ market: snap(0.01, { liquidityUsd: risk.minLiquidityUsd - 1 }) })).toMatchObject({ code: 'low-liquidity' })
    expect(guard({ market: snap(0.01, { liquidityUsd: 20_000 }) })).toMatchObject({ code: 'liquidity-collapse' })
  })

  it('pauses on an abnormal move: far from fair value, or a jump since the last reading', () => {
    expect(guard({ market: snap(0.013) })).toMatchObject({ code: 'abnormal-price' })
    expect(guard({ prev: snap(0.0075, { at: T - 60_000 }), fair: null })).toMatchObject({ code: 'abnormal-price' })
  })

  it('a wide spread skips the tick (it is a cost, not a danger)', () => {
    expect(spreadCheck(snap(0.01), risk)).toBeNull()
    expect(spreadCheck(snap(0.01, { askNear: 0.0106, bidNear: 0.0094 }), risk)).toMatch(/Spread 12\.00% is over its limit/)
  })
})

describe('the guardian, on the bot’s own health', () => {
  it('pauses after its limit of failures in a row, on a degraded RPC or a provider that keeps failing', () => {
    expect(guardHealth({ consecutiveFailures: risk.maxConsecutiveFailures, rpcErrors: 0, providerErrors: 0 }, risk)).toMatchObject({ code: 'consecutive-failures' })
    expect(guardHealth({ consecutiveFailures: 0, rpcErrors: 3, providerErrors: 0 }, risk)).toMatchObject({ code: 'rpc-degraded' })
    expect(guardHealth({ consecutiveFailures: 0, rpcErrors: 0, providerErrors: 3 }, risk)).toMatchObject({ code: 'provider-failure' })
    expect(guardHealth({ consecutiveFailures: 1, rpcErrors: 1, providerErrors: 1 }, risk)).toBeNull()
  })

  it('pauses at the day’s loss limit and at its drawdown limit', () => {
    expect(guardLoss({ pnlTodayNear: -risk.maxDailyLossNear, peakEquityNear: 100, equityNear: 99 }, risk)).toMatchObject({ code: 'daily-loss' })
    expect(guardLoss({ pnlTodayNear: 0, peakEquityNear: 100, equityNear: 100 - risk.maxDrawdownPct }, risk)).toMatchObject({ code: 'drawdown' })
    expect(guardLoss({ pnlTodayNear: -1, peakEquityNear: 100, equityNear: 95 }, risk)).toBeNull()
  })

  it('pauses when a fill came in worse than its quote by more than the slippage allowed', () => {
    const quote = { side: 'buy' as const, near: 1, tokens: 100, priceNear: 0.01, priceImpactBps: 10, at: T }
    expect(guardFill({ quote, filled: { near: 1, tokens: 99.5 }, risk })).toBeNull()
    expect(guardFill({ quote, filled: { near: 1, tokens: 95 }, risk })).toMatchObject({ code: 'excessive-slippage' })
    const sell = { ...quote, side: 'sell' as const }
    expect(guardFill({ quote: sell, filled: { near: 0.9, tokens: 100 }, risk })).toMatchObject({ code: 'excessive-slippage' })
  })

  it('pauses when a wallet’s balance changed in a way its own trades don’t explain', () => {
    const expected = [{ walletId: 'a', near: 10, tokens: 1_000 }]
    expect(guardBalances({ expected, actual: [{ walletId: 'a', near: 10.2, tokens: 1_000 }] })).toBeNull()
    expect(guardBalances({ expected, actual: [{ walletId: 'a', near: 9.99, tokens: 1_000 }] })).toBeNull()
    expect(guardBalances({ expected, actual: [{ walletId: 'a', near: 8, tokens: 1_000 }] })).toMatchObject({ code: 'unexpected-balance', detail: expect.stringMatching(/NEAR/) })
    expect(guardBalances({ expected, actual: [{ walletId: 'a', near: 10, tokens: 900 }] })).toMatchObject({ code: 'unexpected-balance' })
    expect(guardBalances({ expected, actual: [] })).toMatchObject({ code: 'unexpected-balance' })
  })
})
