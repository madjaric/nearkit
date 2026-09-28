import { describe, expect, it } from 'vitest'
import { ALL_NAV } from '@/layouts/nav'
import { BETA_COMING_SOON, comingSoonRoutes, isComingSoon } from './release'

const publicBeta = { services: 'near', network: 'testnet', production: true } as const

describe('comingSoonRoutes: what the public testnet beta marks COMING SOON', () => {
  it('holds back Multi Trade, Limit Orders, DCA, Copy Trade, Sniper and PnL in the public beta build', () => {
    expect(comingSoonRoutes(publicBeta)).toEqual(['/multi-trade', '/limit-orders', '/dca', '/copy-trade', '/sniper', '/pnl'])
  })

  it('keeps Swap, Split, Consolidate, Batch Send, Wallets and Scanner live', () => {
    const soon = comingSoonRoutes(publicBeta)
    for (const route of ['/swap', '/split', '/consolidate', '/batch-send', '/wallets', '/positions', '/scanner']) expect(soon, route).not.toContain(route)
  })

  it('leaves every feature usable in development and test builds, the demo and mainnet', () => {
    expect(comingSoonRoutes({ ...publicBeta, production: false })).toEqual([])
    expect(comingSoonRoutes({ ...publicBeta, services: 'demo' })).toEqual([])
    expect(comingSoonRoutes({ ...publicBeta, network: 'mainnet' })).toEqual([])
  })

  it('names only routes the sidebar has, so a typo cannot silently un-gate a page', () => {
    for (const route of BETA_COMING_SOON)
      expect(
        ALL_NAV.some((item) => item.to === route),
        route,
      ).toBe(true)
  })

  it('does not gate this (test) build', () => {
    expect(isComingSoon('/multi-trade')).toBe(false)
  })
})
