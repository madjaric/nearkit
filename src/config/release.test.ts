import { describe, expect, it } from 'vitest'
import { ALL_NAV } from '@/layouts/nav'
import { AUTOMATION_ROUTES, BETA_COMING_SOON, comingSoonRoutes, isComingSoon, isComingSoonFor, knownAutomation, routeComingSoon } from './release'

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

describe('routeComingSoon: an automation NEARKITS switched on is live for a signed-in user', () => {
  const soon = comingSoonRoutes(publicBeta)

  it('stays COMING SOON with nothing known: no session, no answer from the server', () => {
    for (const route of BETA_COMING_SOON) expect(routeComingSoon(route, soon, null), route).toBe(true)
  })

  it('stays COMING SOON when the server reports none of them on', () => {
    for (const route of BETA_COMING_SOON) expect(routeComingSoon(route, soon, []), route).toBe(true)
  })

  it('opens exactly the route of each kind the server switched on, and only that one', () => {
    expect(routeComingSoon('/limit-orders', soon, ['limit'])).toBe(false)
    expect(routeComingSoon('/dca', soon, ['limit'])).toBe(true)
    expect(routeComingSoon('/copy-trade', soon, ['copy'])).toBe(false)
    expect(routeComingSoon('/sniper', soon, ['copy'])).toBe(true)
    expect(routeComingSoon('/dca', soon, ['limit', 'copy', 'sniper', 'dca'])).toBe(false)
  })

  it('never opens a route that is not an automation, and never gates a live one', () => {
    expect(routeComingSoon('/volume-bot/console', ['/volume-bot/console'], ['limit', 'copy', 'sniper', 'dca'])).toBe(true)
    expect(routeComingSoon('/swap', soon, null)).toBe(false)
  })

  it('maps every held-back automation route to its kind', () => {
    expect(Object.keys(AUTOMATION_ROUTES).sort()).toEqual([...BETA_COMING_SOON].sort())
  })

  it('in this (test) build nothing is gated, whatever the server says', () => {
    expect(isComingSoonFor('/limit-orders', null)).toBe(false)
    expect(isComingSoonFor('/limit-orders', [])).toBe(false)
  })
})

describe('knownAutomation: what the server runs, known with or without a session', () => {
  const soon = comingSoonRoutes({ ...publicBeta, network: 'mainnet' })
  const ALL = ['limit', 'dca', 'sniper', 'copy'] as const

  it('without a session, the server’s public answer (/health) opens every kind it runs: no SOON for a visitor', () => {
    const known = knownAutomation(undefined, [...ALL])
    for (const route of BETA_COMING_SOON) expect(routeComingSoon(route, soon, known), route).toBe(false)
  })

  it('the server running only some: only those open; it runs none ("off"), or doesn’t answer: every one stays SOON', () => {
    const some = knownAutomation(undefined, ['limit', 'dca'])
    expect(BETA_COMING_SOON.filter((r) => routeComingSoon(r, soon, some))).toEqual(['/copy-trade', '/sniper'])
    for (const route of BETA_COMING_SOON) {
      expect(routeComingSoon(route, soon, knownAutomation(undefined, [])), route).toBe(true)
      expect(routeComingSoon(route, soon, knownAutomation(undefined, null)), route).toBe(true)
      expect(routeComingSoon(route, soon, knownAutomation(undefined, undefined)), route).toBe(true)
    }
  })

  it('with a session, the session’s own answer counts', () => {
    expect(knownAutomation(['limit'], [...ALL])).toEqual(['limit'])
    expect(knownAutomation([], [...ALL])).toEqual([])
    expect(knownAutomation(undefined, undefined)).toBeNull()
  })
})
