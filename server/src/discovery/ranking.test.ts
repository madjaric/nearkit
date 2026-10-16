import { describe, expect, it } from 'vitest'
import { assess, maxDrawdown, rank, smartMoney, windowCoverage, type WalletWindow } from './ranking'

/** Top Wallets' ranking rules (DISCOVERY.md, "Top Wallets: ranking integrity"). */

const DAY = 86_400_000
const NOW = 100 * DAY
const ctx = { now: NOW, indexStart: NOW - 60 * DAY }

const w = (o: Partial<WalletWindow> = {}): WalletWindow => ({
  trader: 'alice.near',
  realized: 1_000,
  costClosed: 4_000,
  closed: 30,
  wins: 20,
  gains: 1_600,
  losses: 600,
  buyUsd: 9_000,
  sellUsd: 5_000,
  unmatchedUsd: 0,
  unpriced: 0,
  legs: 120,
  peakDayLegs: 20,
  activeDays: 12,
  tokensSold: 6,
  profitableTokens: 4,
  earlyTokens: 0,
  firstTs: NOW - 40 * DAY,
  lastTs: NOW - DAY,
  ...o,
})

describe('qualification for a PnL ranking', () => {
  it('a wallet with enough closed trades, tokens, coverage and history qualifies, with its derived figures', () => {
    const r = assess(w(), '30d', ctx)
    expect(r).toMatchObject({ qualified: true, reasons: [], automated: false, winRate: 20 / 30, returnPct: 25, avgGain: 80, avgLoss: 60, coverage: 1 })
  })

  it('too few closed trades for the window, a single token, low coverage or under two days of history: not qualified, with the reasons', () => {
    expect(assess(w({ closed: 9, wins: 6 }), '30d', ctx).reasons).toEqual(['closed-trades'])
    expect(assess(w({ closed: 5, wins: 3 }), '7d', ctx).qualified).toBe(true)
    expect(assess(w({ closed: 14 }), '90d', ctx).reasons).toEqual(['closed-trades'])
    expect(assess(w({ tokensSold: 1 }), '30d', ctx).reasons).toEqual(['one-token'])
    expect(assess(w({ unmatchedUsd: 1_500 }), '30d', ctx)).toMatchObject({ qualified: false, coverage: 0.7, reasons: ['coverage'] })
    expect(assess(w({ firstTs: NOW - DAY, lastTs: NOW - DAY / 2 }), '30d', ctx).reasons).toEqual(['history'])
  })

  it('no sales means no coverage figure and no return; a profit from one lucky trade never qualifies', () => {
    expect(assess(w({ sellUsd: 0, unmatchedUsd: 0, closed: 0, wins: 0, costClosed: 0, realized: 0 }), '30d', ctx)).toMatchObject({
      coverage: null,
      returnPct: null,
      winRate: null,
      qualified: false,
    })
    expect(assess(w({ closed: 1, wins: 1, realized: 50_000, tokensSold: 1 }), '30d', ctx).qualified).toBe(false)
  })

  it('over 300 swap legs on one day is automated: flagged, kept out of the curated categories', () => {
    const bot = assess(w({ peakDayLegs: 301 }), '30d', ctx)
    expect(bot.automated).toBe(true)
    expect(bot.categories).toEqual(['all'])
  })
})

describe('categories', () => {
  it('Smart Money: 30D qualified, ≥ 20 closed, win rate ≥ 55%, ≥ $250, profit in ≥ 3 tokens, not automated', () => {
    const rows = [
      assess(w({ trader: 'smart.near' }), '30d', ctx),
      assess(w({ trader: 'lowwin.near', wins: 15 }), '30d', ctx),
      assess(w({ trader: 'small.near', realized: 200 }), '30d', ctx),
      assess(w({ trader: 'twotokens.near', profitableTokens: 2 }), '30d', ctx),
      assess(w({ trader: 'few.near', closed: 19, wins: 15 }), '30d', ctx),
      assess(w({ trader: 'bot.near', peakDayLegs: 900 }), '30d', ctx),
    ]
    expect([...smartMoney(rows)]).toEqual(['smart.near'])
    const r = assess(w({ trader: 'smart.near' }), '7d', { ...ctx, smart: new Set(['smart.near']) })
    expect(r.categories).toContain('smart')
  })

  it('Traders: qualified, not automated, ≥ 10 closed; Early Buyers: ≥ 3 tokens bought within an hour of launch', () => {
    expect(assess(w(), '30d', ctx).categories).toEqual(['all', 'traders'])
    expect(assess(w({ earlyTokens: 3 }), '30d', ctx).categories).toEqual(['all', 'traders', 'early'])
    expect(assess(w({ earlyTokens: 2 }), '30d', ctx).categories).not.toContain('early')
  })

  it('Fresh Wallets: first trade within 14 days, only once the index covers 28 days', () => {
    const fresh = w({ firstTs: NOW - 10 * DAY })
    expect(assess(fresh, '30d', ctx).categories).toContain('fresh')
    expect(assess(fresh, '30d', { ...ctx, indexStart: NOW - 20 * DAY }).categories).not.toContain('fresh')
    expect(assess(w(), '30d', ctx).categories).not.toContain('fresh')
  })
})

describe('ranking', () => {
  const rows = [
    assess(w({ trader: 'a.near', realized: 500, costClosed: 1_000 }), '30d', ctx),
    assess(w({ trader: 'b.near', realized: 2_000, costClosed: 20_000 }), '30d', ctx),
    assess(w({ trader: 'c.near', realized: 9_999, closed: 3, wins: 3 }), '30d', ctx), // not qualified
    assess(w({ trader: 'd.near', realized: -100, buyUsd: 90_000, sellUsd: 80_000 }), '30d', ctx),
  ]

  it('by PnL: qualified wallets only, highest realized first', () => {
    expect(rank(rows, { metric: 'pnl', category: 'all', limit: 100 }).map((r) => r.trader)).toEqual(['b.near', 'a.near', 'd.near'])
  })

  it('by return: realized ÷ cost of the units sold', () => {
    expect(rank(rows, { metric: 'return', category: 'all', limit: 100 }).map((r) => r.trader)).toEqual(['a.near', 'b.near', 'd.near'])
  })

  it('by activity: every wallet, by volume traded; PnL is not what ranks it', () => {
    expect(rank(rows, { metric: 'activity', category: 'all', limit: 100 }).map((r) => r.trader)).toEqual(['d.near', 'a.near', 'b.near', 'c.near'])
  })

  it('a category narrows the list; the limit caps it', () => {
    expect(rank(rows, { metric: 'pnl', category: 'all', limit: 1 }).map((r) => r.trader)).toEqual(['b.near'])
    expect(rank(rows, { metric: 'pnl', category: 'early', limit: 100 })).toEqual([])
  })
})

describe('figures', () => {
  it('max drawdown: the largest fall of cumulative realized PnL from a previous peak', () => {
    expect(maxDrawdown([0, 100, 40, 120, 30, 200])).toBe(90)
    expect(maxDrawdown([10, 20, 30])).toBe(0)
    expect(maxDrawdown([])).toBe(0)
    // Cumulative PnL starts at zero: a slide straight into loss is drawn down from zero.
    expect(maxDrawdown([-10, -50])).toBe(50)
  })

  it('a window longer than the index says how many of its days are covered', () => {
    expect(windowCoverage('90d', ctx)).toEqual({ days: 90, covered: 60 })
    expect(windowCoverage('7d', ctx)).toEqual({ days: 7, covered: 7 })
    expect(windowCoverage('all', ctx)).toEqual({ days: null, covered: 60 })
  })
})
