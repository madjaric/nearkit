import { describe, expect, it } from 'vitest'
import { cumulativeVolume, summarize, type TradeRecord } from './metrics'

const T = Date.UTC(2026, 9, 6, 12)
const trade = (patch: Partial<TradeRecord>): TradeRecord => ({
  at: T,
  side: 'buy',
  walletId: 'a',
  status: 'confirmed',
  near: 1,
  tokens: 100,
  feeNear: 0.005,
  gasNear: 0.001,
  nearUsd: 5,
  ...patch,
})

describe('Volume Bot analytics', () => {
  it('counts only confirmed trades as volume: a failed one is a failure, never volume', () => {
    const m = summarize([trade({ at: T - 7_200_000 }), trade({ at: T - 3_600_000, side: 'sell', near: 2, walletId: 'b' }), trade({ at: T - 60_000, status: 'failed', near: 5 })], T)
    expect(m).toMatchObject({
      trades: 3,
      confirmed: 2,
      failed: 1,
      volumeNear: 3,
      buyVolumeNear: 1,
      sellVolumeNear: 2,
      avgTradeNear: 1.5,
      feesNear: 0.01,
      gasNear: 0.002,
      volumeUsd: 15,
    })
    expect(m.successRate).toBeCloseTo(2 / 3)
    expect(m.avgIntervalSec).toBe(3600)
    expect(m.perWallet).toEqual([
      { walletId: 'a', trades: 1, volumeNear: 1 },
      { walletId: 'b', trades: 1, volumeNear: 2 },
    ])
  })

  it('the 24h volume is the last day’s only', () => {
    expect(summarize([trade({ at: T - 25 * 3_600_000, near: 4 }), trade({ at: T - 3_600_000 })], T).volume24hNear).toBe(1)
  })

  it('nothing yet: zeros, and no rate or interval made up', () => {
    expect(summarize([], T)).toMatchObject({ trades: 0, volumeNear: 0, successRate: null, avgIntervalSec: null, avgTradeNear: null, volumeUsd: null })
  })

  it('a USD figure only when every trade had a NEAR price', () => {
    expect(summarize([trade({}), trade({ nearUsd: null })], T).volumeUsd).toBeNull()
  })

  it('the cumulative volume series runs over confirmed trades, oldest first', () => {
    expect(cumulativeVolume([trade({ at: T, near: 2 }), trade({ at: T - 1000, near: 1 }), trade({ at: T + 1000, status: 'failed' })])).toEqual([
      { t: T - 1000, v: 1 },
      { t: T, v: 3 },
    ])
  })
})
