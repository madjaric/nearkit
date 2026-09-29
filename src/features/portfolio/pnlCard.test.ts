import { describe, expect, it } from 'vitest'
import type { PnlFiguresView, PnlLimitation, PnlReport, Position } from '@/types/domain'
import { cardFromPosition, cardFromReport } from './pnlCard'

const AT = Date.UTC(2026, 8, 29, 9, 0)

const figures = (f: Partial<PnlFiguresView>): PnlFiguresView => ({
  costBasis: 0,
  avgEntry: null,
  realized: 0,
  unrealized: null,
  total: null,
  invested: 0,
  pnlPct: null,
  unmatchedProceeds: 0,
  complete: true,
  ...f,
})

function position(near: Partial<PnlFiguresView>, usd: Partial<PnlFiguresView>, limitations: PnlLimitation[] = []) {
  return {
    token: { id: 'singularty.nearlytrade.near', symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18, contract: 'singularty.nearlytrade.near' },
    pnl: {
      method: 'average-cost',
      near: figures(near),
      usd: figures(usd),
      unknownCostAmount: 0,
      bought: { amount: 69099.4, near: 1.0024, usd: 4.81 },
      sold: { amount: 0, near: 0, usd: 0 },
      trades: 1,
      complete: limitations.length === 0,
      limitations,
      history: [],
    },
  } as unknown as Position
}

describe('PnL card: a position', () => {
  it('leads with total PnL and return in USD where USD is known, from the engine’s figures', () => {
    const card = cardFromPosition(
      position(
        { costBasis: 1.0024, avgEntry: 0.0000145, realized: 0, unrealized: 0.38, total: 0.38, invested: 1.0024, pnlPct: 37.9 },
        { costBasis: 4.81, avgEntry: 0.0000696, realized: 0, unrealized: 2.1, total: 2.1, invested: 4.81, pnlPct: 43.66 },
      ),
      { usd: true, network: 'mainnet', demo: false, at: AT },
    )
    expect(card).toMatchObject({
      title: 'SINGULARTY',
      scope: 'Position',
      headline: { label: 'Total PnL', value: '+$2.10', tone: 'pos' },
      pct: { value: '+43.66%', tone: 'pos' },
      partial: null,
      network: 'NEAR mainnet',
      demo: false,
    })
    expect(card?.rows.map((r) => [r.label, r.value])).toEqual([
      ['Cost basis', '$4.81'],
      ['Realized', '$0.00'],
      ['Unrealized', '+$2.10'],
      ['Avg entry', '$0.0000696'],
    ])
  })

  it('speaks NEAR where there are no USD prices, and says when it is partial', () => {
    const card = cardFromPosition(position({ costBasis: 2, realized: -0.5, unrealized: 0.1, total: -0.4, invested: 2.5, pnlPct: -16 }, {}, ['unknown-cost-units']), {
      usd: false,
      network: 'testnet',
      demo: false,
      at: AT,
    })
    expect(card?.headline).toEqual({ label: 'Total PnL', value: '−0.4 NEAR', tone: 'neg' })
    expect(card?.partial).toBe('Partial: some tokens have no known cost')
    expect(card?.network).toBe('NEAR testnet')
  })

  it('makes no card when there is no total to show', () => {
    expect(cardFromPosition(position({ costBasis: 1, invested: 1 }, {}), { usd: true, network: 'mainnet', demo: false, at: AT })).toBeNull()
  })
})

describe('PnL card: the report', () => {
  const report = (r: Partial<PnlReport>): PnlReport => ({
    range: '30d',
    points: [],
    realizedUsd: 12.5,
    unrealizedUsd: -2.5,
    volumeUsd: 100,
    feesUsd: 0,
    trades: 4,
    wins: 3,
    losses: 1,
    winRatePct: 75,
    byToken: [],
    recentTrades: [],
    source: 'chain',
    currency: 'USD',
    complete: true,
    limitations: [],
    ...r,
  })

  it('totals realized and unrealized for the range, with the win rate of closed trades', () => {
    const card = cardFromReport(report({}), { network: 'mainnet', at: AT })
    expect(card).toMatchObject({ title: 'Portfolio', scope: 'Last 30 days', headline: { value: '+$10.00', tone: 'pos' }, pct: null, demo: false })
    expect(card.rows.map((r) => [r.label, r.value])).toEqual([
      ['Realized', '+$12.50'],
      ['Unrealized', '−$2.50'],
      ['Closed trades', '4'],
      ['Win rate', '75%'],
    ])
  })

  it('marks demo data as demo, and a capped history as partial', () => {
    expect(cardFromReport(report({ source: 'demo' }), { network: null, at: AT })).toMatchObject({ demo: true, network: null })
    const capped = cardFromReport(report({ complete: false, limitations: ['history-incomplete'], wins: 0, losses: 0, trades: 0 }), { network: 'mainnet', at: AT })
    expect(capped.partial).toBe('Partial: history incomplete')
    expect(capped.rows.find((r) => r.label === 'Win rate')?.value).toBe('—')
  })
})
