import { describe, expect, it } from 'vitest'
import { ALL_NAV } from '@/layouts/nav'
import { isPaused, PAUSED_ROUTES, soonLabel, TOP_WALLETS_PAUSED } from './paused'
import { discoverySoon, isComingSoon, isComingSoonFor } from './release'

/** Top Wallets is paused (2026-10-16): COMING SOON everywhere, Launch Radar untouched. */

describe('paused tools', () => {
  it('pauses Top Wallets and every page under it, nothing else', () => {
    expect(TOP_WALLETS_PAUSED).toBe(true)
    expect(PAUSED_ROUTES).toEqual(['/top-wallets'])
    for (const p of ['/top-wallets', '/top-wallets/', '/top-wallets/abc.near', '/top-wallets/a%2Eb']) expect(isPaused(p), p).toBe(true)
    for (const p of ['/launch-radar', '/launch-radar/abc.near', '/top-walletsx', '/', '/swap', '/tools']) expect(isPaused(p), p).toBe(false)
  })

  it('names only routes the sidebar has, so a typo cannot leave a tool open', () => {
    for (const route of PAUSED_ROUTES)
      expect(
        ALL_NAV.some((item) => item.to === route),
        route,
      ).toBe(true)
  })

  it('is COMING SOON whatever NEARKITS’ server runs, while Launch Radar follows the server', () => {
    expect(isComingSoon('/top-wallets')).toBe(true)
    expect(isComingSoonFor('/top-wallets', ['limit', 'dca', 'copy', 'sniper'])).toBe(true)
    expect(isComingSoonFor('/top-wallets/abc.near', null)).toBe(true)
    expect(discoverySoon('/top-wallets', true)).toBe(true)
    expect(discoverySoon('/launch-radar', true)).toBe(false)
    expect(discoverySoon('/launch-radar', null)).toBe(true)
    expect(isComingSoon('/launch-radar')).toBe(false)
  })

  it('wears a Coming soon badge where it is listed; the beta’s tools keep theirs', () => {
    expect(soonLabel('/top-wallets')).toBe('Coming soon')
    expect(soonLabel('/limit-orders')).toBe('Soon')
  })
})
