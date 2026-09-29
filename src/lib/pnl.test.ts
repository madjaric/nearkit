import { describe, expect, it } from 'vitest'
import { computePnl, type LedgerEvent } from './pnl'

const T = 10n ** 18n // one token (18 decimals)
const N = 10n ** 24n // one NEAR
let at = 0
const buy = (tokens: bigint, near: bigint | null, usd: number | null = null): LedgerEvent => ({ kind: 'buy', at: (at += 1), tx: `b${at}`, amount: tokens, value: { near, usd } })
const sell = (tokens: bigint, near: bigint | null, usd: number | null = null): LedgerEvent => ({ kind: 'sell', at: (at += 1), tx: `s${at}`, amount: tokens, value: { near, usd } })
const tin = (tokens: bigint): LedgerEvent => ({ kind: 'transfer-in', at: (at += 1), tx: `i${at}`, amount: tokens, counterparty: 'friend.near' })
const tout = (tokens: bigint): LedgerEvent => ({ kind: 'transfer-out', at: (at += 1), tx: `o${at}`, amount: tokens, counterparty: 'friend.near' })

/** 1 token = 10^18 raw; prices are NEAR per whole token. */
const price = (nearPerToken: number, usdPerToken: number | null = null) => ({ near: nearPerToken, usd: usdPerToken, decimals: 18 })

describe('PnL engine (weighted average cost)', () => {
  it('a single buy: cost basis is what was paid, unrealized follows the price', () => {
    const r = computePnl([buy(100n * T, 10n * N)], price(0.15))
    expect(r.quantity).toBe(100n * T)
    expect(r.near.costBasis).toBe(10n * N)
    expect(r.near.avgEntry).toBeCloseTo(0.1)
    expect(r.near.realized).toBe(0n)
    // 100 tokens × 0.15 = 15 NEAR value; 15 − 10 = 5 NEAR up; 50%.
    expect(r.near.unrealized).toBe(5n * N)
    expect(r.near.total).toBe(5n * N)
    expect(r.near.pnlPct).toBeCloseTo(50)
    expect(r.complete).toBe(true)
  })

  it('multiple buys average their cost', () => {
    const r = computePnl([buy(100n * T, 10n * N), buy(100n * T, 30n * N)], price(0.2))
    expect(r.near.costBasis).toBe(40n * N)
    expect(r.near.avgEntry).toBeCloseTo(0.2)
    expect(r.near.unrealized).toBe(0n)
    expect(r.bought).toEqual({ quantity: 200n * T, near: 40n * N, usd: null })
  })

  it('a partial sell realizes against the average cost and keeps the rest at that cost', () => {
    const r = computePnl([buy(100n * T, 10n * N), buy(100n * T, 30n * N), sell(50n * T, 15n * N)], price(0.2))
    // Average 0.2 NEAR/token; 50 sold cost 10, fetched 15: +5 realized.
    expect(r.near.realized).toBe(5n * N)
    expect(r.quantity).toBe(150n * T)
    expect(r.near.costBasis).toBe(30n * N)
    expect(r.near.avgEntry).toBeCloseTo(0.2)
    expect(r.sold).toEqual({ quantity: 50n * T, near: 15n * N, usd: null })
    // Total return over everything invested (40): (5 + 0) / 40.
    expect(r.near.pnlPct).toBeCloseTo(12.5)
  })

  it('a full exit leaves nothing unrealized and no cost basis', () => {
    const r = computePnl([buy(100n * T, 10n * N), sell(100n * T, 8n * N)], price(0.5))
    expect(r.quantity).toBe(0n)
    expect(r.near.costBasis).toBe(0n)
    expect(r.near.realized).toBe(-2n * N)
    expect(r.near.unrealized).toBe(0n)
    expect(r.near.total).toBe(-2n * N)
    expect(r.near.pnlPct).toBeCloseTo(-20)
    expect(r.closed).toBe(true)
  })

  it('a buy after a full exit starts a fresh average', () => {
    const r = computePnl([buy(100n * T, 10n * N), sell(100n * T, 20n * N), buy(50n * T, 25n * N)], price(0.5))
    expect(r.near.realized).toBe(10n * N)
    expect(r.near.costBasis).toBe(25n * N)
    expect(r.near.avgEntry).toBeCloseTo(0.5)
    expect(r.near.unrealized).toBe(0n)
  })

  it('fees paid are part of the cost and the proceeds, because values are what actually moved', () => {
    // Paid 10 NEAR + 0.01 gas for the buy; received 12 NEAR − 0.01 gas for the sell.
    const r = computePnl([buy(100n * T, 10n * N + N / 100n), sell(100n * T, 12n * N - N / 100n)], price(0.1))
    expect(r.near.realized).toBe(2n * N - (2n * N) / 100n)
  })

  it('tokens received by transfer have unknown cost: tracked apart, never guessed', () => {
    const r = computePnl([buy(100n * T, 10n * N), tin(100n * T)], price(0.2))
    expect(r.quantity).toBe(200n * T)
    expect(r.unknownCostQuantity).toBe(100n * T)
    expect(r.near.costBasis).toBe(10n * N)
    // Unrealized only on the units with a known cost: 100 × 0.2 − 10 = 10.
    expect(r.near.unrealized).toBe(10n * N)
    expect(r.complete).toBe(false)
    expect(r.limitations).toContain('unknown-cost-units')
  })

  it('selling from a mix sells known and unknown units in proportion', () => {
    const r = computePnl([buy(100n * T, 10n * N), tin(100n * T), sell(100n * T, 30n * N)], price(0.2))
    // Half the sold units had a known cost (0.1 each): 50 units cost 5, proceeds share 15 → +10.
    expect(r.near.realized).toBe(10n * N)
    expect(r.quantity).toBe(100n * T)
    expect(r.unknownCostQuantity).toBe(50n * T)
    expect(r.near.costBasis).toBe(5n * N)
    expect(r.near.unmatchedProceeds).toBe(15n * N)
    expect(r.complete).toBe(false)
  })

  it('a transfer out removes units at average cost without realizing anything', () => {
    const r = computePnl([buy(100n * T, 10n * N), tout(40n * T)], price(0.1))
    expect(r.quantity).toBe(60n * T)
    expect(r.near.costBasis).toBe(6n * N)
    expect(r.near.realized).toBe(0n)
    expect(r.transferredOut).toBe(40n * T)
  })

  it('zero balance and no history is an empty, complete position', () => {
    const r = computePnl([], price(0.1))
    expect(r.quantity).toBe(0n)
    expect(r.near.total).toBe(0n)
    expect(r.near.pnlPct).toBeNull()
    expect(r.complete).toBe(true)
  })

  it('without a current price, unrealized PnL is unknown, not zero', () => {
    const r = computePnl([buy(100n * T, 10n * N)], null)
    expect(r.near.unrealized).toBeNull()
    expect(r.near.total).toBeNull()
    expect(r.near.realized).toBe(0n)
    expect(r.limitations).toContain('no-current-price')
  })

  it('a sale with no known proceeds leaves realized PnL incomplete', () => {
    const r = computePnl([buy(100n * T, 10n * N), sell(50n * T, null)], price(0.1))
    expect(r.near.realized).toBe(0n)
    expect(r.complete).toBe(false)
    expect(r.limitations).toContain('unknown-proceeds')
    // The sold units still leave the cost basis at average cost.
    expect(r.near.costBasis).toBe(5n * N)
  })

  it('selling more than the history shows means history is missing: flagged, never negative quantity', () => {
    const r = computePnl([buy(10n * T, N), sell(30n * T, 6n * N)], price(0.1))
    expect(r.quantity).toBe(0n)
    expect(r.limitations).toContain('history-incomplete')
    expect(r.complete).toBe(false)
  })

  it('keeps extreme decimals exact: 24-decimal tokens and dust amounts', () => {
    const one = 10n ** 24n
    const r = computePnl(
      [
        { kind: 'buy', at: 1, tx: 'a', amount: 3n, value: { near: 1n, usd: null } },
        { kind: 'buy', at: 2, tx: 'b', amount: 123456789012345678901234567890n, value: { near: 7n * N, usd: null } },
        { kind: 'sell', at: 3, tx: 'c', amount: 1n, value: { near: 1n, usd: null } },
      ],
      { near: 1e-6, usd: null, decimals: 24 },
    )
    expect(r.quantity).toBe(123456789012345678901234567892n)
    expect(r.near.costBasis + r.near.realized).toBeGreaterThan(0n)
    expect(typeof r.near.costBasis).toBe('bigint')
    expect(r.quantity * one > 0n).toBe(true)
  })

  it('tracks USD beside NEAR with the same method, and leaves it unknown if any trade lacks it', () => {
    const known = computePnl([buy(100n * T, 10n * N, 50), sell(50n * T, 6n * N, 40)], price(0.12, 0.6))
    expect(known.usd.realized).toBeCloseTo(15) // proceeds 40 − half of 50
    expect(known.usd.costBasis).toBeCloseTo(25)
    expect(known.usd.unrealized).toBeCloseTo(50 * 0.6 - 25)
    const partial = computePnl([buy(100n * T, 10n * N, null), sell(50n * T, 6n * N, 40)], price(0.12, 0.6))
    expect(partial.usd.complete).toBe(false)
    expect(partial.near.complete).toBe(true)
  })

  it('lists every sale with its own realized PnL, for charts and closed-trade lists', () => {
    const r = computePnl([buy(100n * T, 10n * N, 50), sell(50n * T, 8n * N, 40), tin(50n * T), sell(50n * T, null, null)], price(0.1))
    expect(r.sales).toHaveLength(2)
    expect(r.sales[0]).toMatchObject({ amount: 50n * T, proceedsNear: 8n * N, costNear: 5n * N, realizedNear: 3n * N, realizedUsd: 15 })
    // The second sale has no known proceeds: its realized PnL is unknown, not zero.
    expect(r.sales[1]).toMatchObject({ amount: 50n * T, proceedsNear: null, realizedNear: null, realizedUsd: null })
  })

  it('is deterministic: the same events always give the same result', () => {
    const events = [buy(100n * T, 10n * N, 50), tin(7n * T), sell(33n * T, 4n * N, 21), buy(5n * T, N, 5)]
    expect(computePnl(events, price(0.1, 0.5))).toEqual(computePnl(events, price(0.1, 0.5)))
  })
})
