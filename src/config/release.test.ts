import { describe, expect, it } from 'vitest'
import { ALL_NAV } from '@/layouts/nav'
import { BETA_COMING_SOON, comingSoonRoutes, isComingSoon } from './release'

const publicBeta = { services: 'near', network: 'testnet', production: true } as const

describe('comingSoonRoutes: what the public testnet beta marks COMING SOON', () => {
  it('holds back Limit Orders, DCA, Copy Trade and Sniper in the public beta build', () => {
    expect(comingSoonRoutes(publicBeta)).toEqual(['/limit-orders', '/dca', '/copy-trade', '/sniper'])
  })

  it('keeps Swap, Multi Trade, Split, Consolidate, Batch Send, Wallets, Positions, PnL and Scanner live', () => {
    const soon = comingSoonRoutes(publicBeta)
    for (const route of ['/swap', '/multi-trade', '/split', '/consolidate', '/batch-send', '/wallets', '/positions', '/pnl', '/scanner']) expect(soon, route).not.toContain(route)
  })

  it('holds back the same features in a mainnet production build', () => {
    expect(comingSoonRoutes({ ...publicBeta, network: 'mainnet' })).toEqual(comingSoonRoutes(publicBeta))
  })

  it('leaves every feature usable in development and test builds and the demo', () => {
    expect(comingSoonRoutes({ ...publicBeta, production: false })).toEqual([])
    expect(comingSoonRoutes({ ...publicBeta, network: 'mainnet', production: false })).toEqual([])
    expect(comingSoonRoutes({ ...publicBeta, services: 'demo' })).toEqual([])
  })

  it('names only routes the sidebar has, so a typo cannot silently un-gate a page', () => {
    for (const route of BETA_COMING_SOON)
      expect(
        ALL_NAV.some((item) => item.to === route),
        route,
      ).toBe(true)
  })

  it('does not gate this (test) build', () => {
    expect(isComingSoon('/dca')).toBe(false)
  })
})
