import { describe, expect, it } from 'vitest'
import { isKitToken, KIT_LAUNCH, KIT_POOL_FEE_NOTE, KIT_TAX_NOTE, kitConfig, KITS_CONTRACT } from './kit'

describe('$KITS, configured once', () => {
  it('is Near Kits, ticker $KITS, at its one contract: kits.nearlytrade.near', () => {
    expect(KITS_CONTRACT).toBe('kits.nearlytrade.near')
    const kits = kitConfig(KITS_CONTRACT)
    expect(kits).toMatchObject({ name: 'Near Kits', symbol: 'KITS', ticker: '$KITS', contract: 'kits.nearlytrade.near', status: 'live', tradable: true, launchVenue: 'Nearly' })
  })

  it('is live where the build has its contract: its token page, and its explorer page on mainnet (where it lives)', () => {
    expect(kitConfig(KITS_CONTRACT).links).toEqual({
      page: '/kit',
      token: '/token/kits.nearlytrade.near',
      explorer: 'https://nearblocks.io/tokens/kits.nearlytrade.near',
    })
  })

  it('on a network without it (testnet) it is mainnet-only: nothing trades it, its page and its contract still say what it is', () => {
    const kits = kitConfig(null)
    expect(kits).toMatchObject({ name: 'Near Kits', ticker: '$KITS', contract: null, status: 'mainnet-only', tradable: false })
    expect(kits.links).toEqual({ page: '/kit', token: null, explorer: 'https://nearblocks.io/tokens/kits.nearlytrade.near' })
  })

  it('knows its own token by the build’s contract, and nothing else', () => {
    const live = kitConfig(KITS_CONTRACT)
    expect(isKitToken('kits.nearlytrade.near', live)).toBe(true)
    expect(isKitToken('kit', live)).toBe(false)
    expect(isKitToken('usdt.tether-token.near', live)).toBe(false)
    expect(isKitToken(null, live)).toBe(false)
    expect(isKitToken('kits.nearlytrade.near', kitConfig(null))).toBe(false)
  })
})

describe('$KITS as its Nearly launch configuration sets it', () => {
  it('a 2% tax on buys and on sells, all of it split: 50% Buyback & Burn, 50% holders, 0% creator', () => {
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
