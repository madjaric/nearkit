import { describe, expect, it } from 'vitest'
import { computePnl, type LedgerEvent, type Sale } from '@/lib/pnl'
import type { TokenListing } from '@/types/domain'
import { buildPnlReport, type TokenInput } from './pnlReport'
import { combinePnl } from './pnlTracker'

const base = {
  range: 'all' as const,
  now: Date.UTC(2026, 8, 29),
  currency: 'NEAR' as const,
  tokens: [],
  gas: [{ at: Date.UTC(2026, 8, 20), near: 0.47 }],
  walletOf: (a: string) => a,
}

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

const N = 10n ** 24n
const token = (id: string): TokenListing => ({ id, symbol: id.toUpperCase(), name: id, decimals: 24, contract: id, market: null }) as unknown as TokenListing
const buyEvent = (at: number, amount: bigint, near: bigint): LedgerEvent => ({ kind: 'buy', at, tx: `b${at}`, amount, value: { near, usd: null } })
function input(id: string, events: LedgerEvent[], price: { near: number | null } | null): TokenInput {
  const result = computePnl(events, price ? { near: price.near, usd: null, decimals: 24 } : null)
  const combined = combinePnl([{ result, balance: result.quantity, ledgerComplete: true }], 24)
  return { token: token(id), combined, sales: [], trades: events.map((e) => ({ at: e.at, value: 1 })) }
}

describe('PnL report: unknown is never zero', () => {
  const at = Date.UTC(2026, 8, 28)

  it('an open position without a current price has unknown unrealized PnL, at token and report level', () => {
    const r = buildPnlReport({ ...base, tokens: [input('usdt', [buyEvent(at, 5n * N, N)], null)], history: { complete: true, txs: 3 } })
    expect(r.byToken[0]?.unrealizedUsd).toBeNull()
    expect(r.unrealizedUsd).toBeNull()
    expect(r.limitations).toContain('no-current-price')
  })

  it('a known and an unknown open position: the known part is shown and the report says it is partial', () => {
    const r = buildPnlReport({
      ...base,
      tokens: [input('aaa', [buyEvent(at, 5n * N, N)], { near: 0.4 }), input('bbb', [buyEvent(at, 5n * N, N)], null)],
      history: { complete: true, txs: 3 },
    })
    // aaa: 5 × 0.4 − 1 = +1 NEAR; bbb unknown.
    expect(r.unrealizedUsd).toBeCloseTo(1, 9)
    expect(r.complete).toBe(false)
    expect(r.byToken.find((t) => t.token.id === 'bbb')?.unrealizedUsd).toBeNull()
  })

  it('no open positions at all: unrealized is a computed zero', () => {
    const r = buildPnlReport({ ...base, history: { complete: true, txs: 0 } })
    expect(r.unrealizedUsd).toBe(0)
    expect(r.realizedUsd).toBe(0)
  })
})

describe('PnL report: the selected period (24H)', () => {
  const now = Date.UTC(2026, 9, 8, 14, 37)
  const H = 3_600_000
  const sale = (at: number, realized: number): { accountId: string; sale: Sale } => ({
    accountId: 'alice.near',
    sale: { at, tx: `s${at}`, amount: 10n * N, proceedsNear: null, costNear: 0n, realizedNear: null, proceedsUsd: 50 + realized, costUsd: 50, realizedUsd: realized },
  })
  const tokens = (): TokenInput[] => {
    const t = input('aaa', [buyEvent(now - 3 * 24 * H, 10n * N, N)], { near: 0.1 })
    return [
      {
        ...t,
        sales: [sale(now - 2 * H, 12), sale(now - 2 * 24 * H, -30)],
        trades: [
          { at: now - 2 * H, value: 62 },
          { at: now - 2 * 24 * H, value: 20 },
        ],
      },
    ]
  }
  const gas = [
    { at: now - H, near: 0.002 },
    { at: now - 5 * 24 * H, near: 0.4 },
  ]

  it('counts only the last 24 hours: its trades, its realized PnL, its volume and its gas; hourly points', () => {
    const r = buildPnlReport({ ...base, range: '24h', now, currency: 'USD', tokens: tokens(), gas, history: { complete: true, txs: 4 } })
    expect(r.range).toBe('24h')
    expect(r.bucketMs).toBe(H)
    expect(r.trades).toBe(1)
    expect(r.realizedUsd).toBe(12)
    expect(r.volumeUsd).toBe(62)
    expect(r.gasNear).toBeCloseTo(0.002)
    expect(r.wins).toBe(1)
    expect(r.recentTrades.map((t) => t.pnlUsd)).toEqual([12])
    expect(r.points.at(-1)?.cumulative).toBe(12)
    expect(r.points.at(-1)?.end).toBe(now)
    expect(r.points[1]?.end ?? 0 - (r.points[1]?.t ?? 0)).toBeGreaterThan(0)
  })

  it('switching to 7D takes in the older trade and gas', () => {
    const r = buildPnlReport({ ...base, range: '7d', now, currency: 'USD', tokens: tokens(), gas, history: { complete: true, txs: 4 } })
    expect(r.trades).toBe(2)
    expect(r.realizedUsd).toBe(-18)
    expect(r.gasNear).toBeCloseTo(0.402)
    expect(r.bucketMs).toBe(6 * H)
    expect(r.recentTrades.map((t) => t.pnlUsd)).toEqual([12, -30])
  })
})
