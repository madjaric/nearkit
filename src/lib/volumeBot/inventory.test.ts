import { describe, expect, it } from 'vitest'
import { applyFill, avgCostNear, emptyBook, inventoryOf, openBook, pnlNear, unrealizedNear, walletTokenPct } from './inventory'

describe('the bot’s book (average cost, in NEAR)', () => {
  it('buys raise the position at their full cost; a sell realizes against the average cost', () => {
    let b = emptyBook()
    b = applyFill(b, { side: 'buy', tokens: 100, near: 10, feeNear: 0.05, gasNear: 0.002 })
    b = applyFill(b, { side: 'buy', tokens: 100, near: 12, feeNear: 0.06, gasNear: 0.002 })
    expect(b.tokens).toBe(200)
    expect(avgCostNear(b)).toBeCloseTo(0.11)
    b = applyFill(b, { side: 'sell', tokens: 50, near: 7, feeNear: 0.035, gasNear: 0.002 })
    expect(b.tokens).toBe(150)
    // Cost of what was sold: 50 × 0.11 = 5.5; proceeds 7 (already net of the fee).
    expect(b.realizedNear).toBeCloseTo(1.5)
    expect(b.costNear).toBeCloseTo(16.5)
    expect(b.volumeNear).toBeCloseTo(29)
    expect(b.feesNear).toBeCloseTo(0.145)
    expect(b.gasNear).toBeCloseTo(0.006)
    expect([b.buys, b.sells]).toEqual([2, 1])
  })

  it('marks the inventory the bot starts with at the start price, so its PnL starts at zero', () => {
    const b = openBook(1_000, 0.02)
    expect(b.costNear).toBeCloseTo(20)
    expect(pnlNear(b, 0.02)).toBeCloseTo(0)
    expect(unrealizedNear(b, 0.03)).toBeCloseTo(10)
  })

  it('counts gas against PnL, and fees only once (they are inside each fill’s amounts)', () => {
    let b = emptyBook()
    b = applyFill(b, { side: 'buy', tokens: 100, near: 10, feeNear: 0.05, gasNear: 0.01 })
    b = applyFill(b, { side: 'sell', tokens: 100, near: 10, feeNear: 0.05, gasNear: 0.01 })
    expect(pnlNear(b, 0.1)).toBeCloseTo(-0.02)
  })

  it('never sells more than it holds: a sell beyond the book clears it', () => {
    let b = applyFill(emptyBook(), { side: 'buy', tokens: 10, near: 1, feeNear: 0, gasNear: 0 })
    b = applyFill(b, { side: 'sell', tokens: 12, near: 1.3, feeNear: 0, gasNear: 0 })
    expect(b.tokens).toBe(0)
    expect(b.costNear).toBe(0)
    expect(avgCostNear(b)).toBeNull()
  })
})

describe('inventory across the bot’s wallets', () => {
  it('values the token in NEAR and gives its share of the total', () => {
    const inv = inventoryOf(
      [
        { near: 6, tokens: 100 },
        { near: 4, tokens: 300 },
      ],
      0.025,
    )
    expect(inv).toEqual({ near: 10, tokens: 400, tokenValueNear: 10, totalNear: 20, tokenPct: 50 })
    expect(inventoryOf([], 1)).toEqual({ near: 0, tokens: 0, tokenValueNear: 0, totalNear: 0, tokenPct: 0 })
  })

  it('gives one wallet’s token share of its own value', () => {
    expect(walletTokenPct({ near: 3, tokens: 100 }, 0.01)).toBeCloseTo(25)
    expect(walletTokenPct({ near: 0, tokens: 0 }, 0.01)).toBe(0)
  })
})
