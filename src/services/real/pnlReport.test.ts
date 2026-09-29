import { describe, expect, it } from 'vitest'
import { buildPnlReport } from './pnlReport'

const base = { range: 'all' as const, now: Date.UTC(2026, 8, 29), currency: 'NEAR' as const, tokens: [], gasNear: 0.47, walletOf: (a: string) => a }

describe('PnL report', () => {
  it('says so when the history it read was capped: older trades are not in it', () => {
    const r = buildPnlReport({ ...base, history: { complete: false, txs: 600 } })
    expect(r.complete).toBe(false)
    expect(r.limitations).toContain('history-incomplete')
    expect(r.history).toEqual({ complete: false, txs: 600 })
  })

  it('a whole history with nothing traded is complete and empty', () => {
    const r = buildPnlReport({ ...base, history: { complete: true, txs: 12 } })
    expect(r.complete).toBe(true)
    expect(r.limitations).toEqual([])
    expect(r.trades).toBe(0)
    expect(r.realizedUsd).toBe(0)
  })
})
