import { describe, expect, it } from 'vitest'
import type { StrategyView } from '@/lib/automation/api'
import type { StrategyConfig, StrategyStatus } from '@/lib/automation/config'
import type { DcaPlan, LimitOrder, TokenListing } from '@/types/domain'
import { countByKind, demoRows, kindsCaption, serverRows } from './strategies'

const KITS = { id: 'kits.nearlytrade.near', symbol: 'KITS', decimals: 18 }

const view = (id: string, config: StrategyConfig, status: StrategyStatus = 'active', createdAt = 1_000): StrategyView => ({
  id,
  kind: config.kind,
  status,
  walletId: 'w1',
  walletName: 'Main',
  subject: 'x',
  config,
  statusReason: null,
  waiting: null,
  lastPriceNear: null,
  lastQuoteAt: null,
  ocoGroup: null,
  attempts: 0,
  expiresAt: null,
  createdAt,
  updatedAt: createdAt,
  closedAt: null,
})

const limit = (type: 'limit-buy' | 'take-profit' = 'limit-buy'): StrategyConfig => ({
  kind: 'limit',
  limit: {
    type,
    token: KITS,
    amount: type === 'limit-buy' ? { kind: 'near', value: '5' } : { kind: 'percent', value: 50 },
    triggerPriceNear: '0.000021',
    slippagePct: 1,
    expiresAt: null,
  },
})
const dca: StrategyConfig = { kind: 'dca', dca: { token: KITS, amountNear: 10, everySec: 86_400, startAt: 0, endAt: null, slippagePct: 1, maxRuns: null } }
const copy: StrategyConfig = {
  kind: 'copy',
  copy: {
    target: 'trader.near',
    copy: 'both',
    sizing: { mode: 'fixed', amountNear: 2 },
    maxTradeNear: 50,
    minTradeNear: null,
    maxExposureNear: 100,
    slippagePct: 1,
    minLiquidityUsd: null,
    exclude: [],
  },
}
const pools: StrategyConfig = {
  kind: 'sniper',
  sniper: {
    target: 'new-pools',
    token: null,
    sources: ['nearly'],
    minPoolNear: 5,
    maxBuys: 3,
    amountNear: 1,
    slippagePct: 3,
    maxImpactPct: 10,
    minLiquidityUsd: null,
    maxAttempts: 3,
    expiresAt: null,
    mode: 'execute',
  },
}

describe('the Dashboard’s active strategies, from NEARKITS’ server', () => {
  it('each row says its type, pair, trigger and amount from its own configuration, and where it is managed', () => {
    const [row] = serverRows([view('a', limit())])
    expect(row).toMatchObject({ type: 'Limit buy', subject: 'KITS / NEAR', tokenId: KITS.id, trigger: '≤ 0.000021 NEAR', amount: '5 NEAR', href: '/limit-orders' })
    expect(serverRows([view('b', limit('take-profit'))])[0]).toMatchObject({ type: 'Take profit', trigger: '≥ 0.000021 NEAR', amount: '50% of KITS' })
    expect(serverRows([view('c', dca)])[0]).toMatchObject({ type: 'DCA', subject: 'KITS / NEAR', trigger: 'Every day', amount: '10 NEAR', href: '/dca' })
    expect(serverRows([view('d', copy)])[0]).toMatchObject({ type: 'Copy Trade', subject: 'trader.near', tokenId: null, trigger: 'Copies buys and sells', href: '/copy-trade' })
    expect(serverRows([view('e', pools)])[0]).toMatchObject({
      type: 'Sniper',
      subject: 'New pools',
      trigger: 'Buys · Nearly launches',
      amount: '1 NEAR each · up to 3',
      href: '/sniper',
    })
  })

  it('lists what can still act (watching, paused, settling), newest first; never one that ended or a draft', () => {
    const rows = serverRows([
      view('old', dca, 'active', 1),
      view('paused', copy, 'paused', 2),
      view('settling', limit(), 'submitted', 3),
      view('done', limit(), 'filled', 4),
      view('gone', dca, 'cancelled', 5),
      view('draft', dca, 'draft', 6),
    ])
    expect(rows.map((r) => r.id)).toEqual(['settling', 'paused', 'old'])
    expect(kindsCaption(rows)).toBe('limit · dca · copy')
    expect(countByKind(rows)).toEqual({ limit: 1, dca: 1, copy: 1, sniper: 0 })
    expect(kindsCaption([])).toBeNull()
  })
})

describe('in the demo, the seeded orders and rules', () => {
  const tokens = [{ id: 'blackdragon.tkn.near', symbol: 'BLACKDRAGON' }] as TokenListing[]
  const order = (status: LimitOrder['status']): LimitOrder => ({
    id: `o-${status}`,
    tokenId: 'blackdragon.tkn.near',
    side: 'sell',
    type: 'take-profit',
    triggerPriceUsd: 0.00000123,
    amount: 1_000_000,
    walletId: 'w1',
    createdAt: 10,
    expiresAt: null,
    closedAt: null,
    status,
  })
  const plan: DcaPlan = { id: 'd1', tokenId: 'blackdragon.tkn.near', amountNear: 2, frequency: '1d', startAt: 0, endAt: null, walletId: 'w1', createdAt: 20, status: 'standby' }

  it('open orders and standby rules only, as simulated rows', () => {
    const rows = demoRows({ orders: [order('open'), order('filled')], dca: [plan], copy: [], sniper: [], tokens })
    expect(rows.map((r) => r.id)).toEqual(['d1', 'o-open'])
    expect(rows[1]).toMatchObject({ type: 'Take profit', subject: 'BLACKDRAGON / NEAR', amount: '1,000,000 BLACKDRAGON', lamp: { source: 'demo', status: 'open' } })
    expect(rows[1]?.trigger).toMatch(/^≥ \$/)
    expect(rows[0]).toMatchObject({ type: 'DCA', trigger: 'Every 1 day', amount: '2 NEAR', lamp: { source: 'demo', status: 'standby' } })
  })
})
