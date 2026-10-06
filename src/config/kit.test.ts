import { describe, expect, it } from 'vitest'
import { isKitToken, kitConfig } from './kit'

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
