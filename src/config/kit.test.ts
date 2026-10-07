import { describe, expect, it } from 'vitest'
import { isKitToken, KIT_LAUNCH, KIT_POOL_FEE_NOTE, KIT_TAX_NOTE, kitConfig } from './kit'

describe('$KIT, configured once', () => {
  it('is Coming Soon, untradable and without a contract until the build names its contract', () => {
    const kit = kitConfig(null, 'https://nearblocks.io')
    expect(kit).toMatchObject({ symbol: 'KIT', ticker: '$KIT', name: 'NEARKITS Token', contract: null, status: 'coming-soon', tradable: false, launchVenue: 'Nearly' })
    expect(kit.links).toEqual({ page: '/kit', token: null, explorer: null })
  })

  it('goes live with its contract: tradable, with its token page and explorer links', () => {
    const kit = kitConfig('kit.nearlytrade.near', 'https://nearblocks.io')
    expect(kit).toMatchObject({ contract: 'kit.nearlytrade.near', status: 'live', tradable: true })
    expect(kit.links).toEqual({ page: '/kit', token: '/token/kit.nearlytrade.near', explorer: 'https://nearblocks.io/tokens/kit.nearlytrade.near' })
  })

  it('knows its own token: the demo’s preview token, or the configured contract', () => {
    const live = kitConfig('kit.nearlytrade.near', 'https://nearblocks.io')
    expect(isKitToken('kit.nearlytrade.near', live)).toBe(true)
    expect(isKitToken('kit', live)).toBe(true)
    expect(isKitToken('usdt.tether-token.near', live)).toBe(false)
    expect(isKitToken(null, live)).toBe(false)
    const soon = kitConfig(null, 'https://nearblocks.io')
    expect(isKitToken('kit', soon)).toBe(true)
    expect(isKitToken('kit.nearlytrade.near', soon)).toBe(false)
  })
})

describe('$KIT as its Nearly launch configuration sets it', () => {
  it('a 2% tax on buys and on sells, all of it split: 50% Buyback & Burn, 50% holders, 0% creator', () => {
    expect(KIT_LAUNCH.name).toBe('NEAR KITS')
    expect(KIT_LAUNCH.tax).toEqual({ buyPct: 2, sellPct: 2 })
    expect(KIT_LAUNCH.taxSplit).toEqual({ buybackBurnPct: 50, holdersPct: 50, creatorPct: 0 })
    const { buybackBurnPct, holdersPct, creatorPct } = KIT_LAUNCH.taxSplit
    expect(buybackBurnPct + holdersPct + creatorPct).toBe(100)
  })

  it('the pool fee stands apart from the tax: 1%, of which 70% is allocated to NEARKITS', () => {
    expect(KIT_LAUNCH.poolFee).toEqual({ pct: 1, nearkitsSharePct: 70 })
    expect(KIT_TAX_NOTE).toBe('2% tax applies to buys and sells. Tax revenue is split 50/50 between Buyback & Burn and Holder rewards.')
    expect(KIT_POOL_FEE_NOTE).toBe('70% of the 1% pool fee is allocated to NEARKITS.')
    // Neither sentence borrows from the other: the 70% is a share of the pool fee, never of the tax.
    expect(KIT_TAX_NOTE).not.toMatch(/70|pool/i)
    expect(KIT_POOL_FEE_NOTE).not.toMatch(/tax/i)
  })
})
