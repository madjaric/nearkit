import { describe, expect, it } from 'vitest'
import type { KitsBurn } from '@/services/kitsBurns'
import { burnSeries } from './burnSeries'

/** The Buyback & Burn chart's series: the verified burns, oldest first, each a step up; nothing in between. */

const burn = (tx: string, at: number, amount: string): KitsBurn => ({ tx: tx.padEnd(44, '1'), at, amount, kind: 'tax' })

describe('the burn series', () => {
  it('orders the burns oldest first and carries an exact running total', () => {
    const s = burnSeries([burn('C', 3_000, '78155059288019410500855'), burn('A', 1_000, '1137239934150297615790361'), burn('B', 2_000, '197224380625149214516409')], 18, 9_000)
    expect(s?.steps.map((x) => [x.at, x.amountText, x.cumulativeText])).toEqual([
      [1_000, '1,137,239.93', '1,137,239.93'],
      [2_000, '197,224.38', '1,334,464.31'],
      [3_000, '78,155.05', '1,412,619.37'],
    ])
    expect(s?.max).toBeCloseTo(1_412_619.37, 1)
  })

  it('has one point per verified burn and none in between; it runs to now from the last one', () => {
    const s = burnSeries([burn('A', 1_000, '1000000000000000000'), burn('B', 5_000, '2000000000000000000')], 18, 9_000)
    expect(s?.steps).toHaveLength(2)
    expect(s?.start).toBe(1_000)
    expect(s?.end).toBe(9_000)
  })

  it('draws nothing without a burn', () => {
    expect(burnSeries([], 18, 9_000)).toBeNull()
  })
})
