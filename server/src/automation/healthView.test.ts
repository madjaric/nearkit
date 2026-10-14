import { describe, expect, it } from 'vitest'
import { automationHealth } from './healthView'

describe('what /health says about trading automation', () => {
  it('the kinds the worker runs, and snipers buying only when the worker runs Sniper and NEARKITS switched buying on', () => {
    const all = new Set(['limit', 'dca', 'sniper', 'copy'] as const)
    expect(automationHealth(true, all, true)).toEqual({ automation: 'limit,dca,sniper,copy', sniperBuy: 'on' })
    expect(automationHealth(true, all, false)).toEqual({ automation: 'limit,dca,sniper,copy', sniperBuy: 'off' })
    // The switch alone buys nothing: no Sniper kind, or no worker, is off.
    expect(automationHealth(true, new Set(['limit'] as const), true)).toEqual({ automation: 'limit', sniperBuy: 'off' })
    expect(automationHealth(false, all, true)).toEqual({ automation: 'off', sniperBuy: 'off' })
    expect(automationHealth(true, new Set(), true)).toEqual({ automation: 'off', sniperBuy: 'off' })
  })
})
