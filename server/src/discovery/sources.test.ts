import { describe, expect, it } from 'vitest'
import { concentration, INFRA_ACCOUNTS, sourceOf, venueOf } from './sources'

/** Where a launch comes from, and how concentrated its holders are (DISCOVERY.md, Launch Radar). */

describe('launch sources', () => {
  it('a known parent is named; a bridge is a bridge, not a launchpad', () => {
    expect(sourceOf('nearlytrade.near', { hasContract: true, launches: 300 })).toEqual({ id: 'nearlytrade.near', name: 'Nearly', kind: 'launchpad', validated: true })
    expect(sourceOf('factory.bridge.near', { hasContract: true, launches: 9 })).toMatchObject({ name: 'Rainbow Bridge', kind: 'bridge', validated: true })
  })

  it('an unknown parent with a contract and at least 3 tokens is a validated token factory, shown by its account', () => {
    expect(sourceOf('tknport.near', { hasContract: true, launches: 111 })).toEqual({ id: 'tknport.near', name: null, kind: 'factory', validated: true })
  })

  it('look-alikes are never given a known name; unvalidated parents (no contract known, too few tokens) are not a source', () => {
    expect(sourceOf('nearlydev.near', { hasContract: true, launches: 21 })).toMatchObject({ name: null, kind: 'factory' })
    expect(sourceOf('someone.near', { hasContract: false, launches: 12 }).validated).toBe(false)
    expect(sourceOf('new.near', { hasContract: true, launches: 2 }).validated).toBe(false)
    expect(sourceOf('new.near', { hasContract: null, launches: 30 }).validated).toBe(false)
  })

  it('the first liquidity venue comes from the main pool', () => {
    expect(venueOf('REFDCL-rear-3.nearlytrade.near|wrap.near|10000')).toBe('Rhea DCL')
    expect(venueOf('REF-3886')).toBe('Ref v1')
    expect(venueOf('INTEARPLACH-280')).toBe('Intear')
    expect(venueOf(null)).toBeNull()
  })
})

describe('holder concentration', () => {
  const supply = '1000'
  const rows = [
    { account: 'dclv2.ref-labs.near', balance: '500' },
    { account: 'tok.nearlytrade.near', balance: '50' },
    { account: 'nearlytrade.near', balance: '40' },
    { account: 'dev.near', balance: '120' },
    { account: 'a.near', balance: '100' },
    { account: 'b.near', balance: '80' },
  ]

  it('top 10 share leaves out pools, the token contract and its launchpad; the dev account’s share is read from the list', () => {
    const c = concentration(rows, supply, { token: 'tok.nearlytrade.near', parent: 'nearlytrade.near', dev: 'dev.near', total: 6, listed: 25 })
    expect(c.top10Share).toBeCloseTo(0.3)
    expect(c.devShare).toBeCloseTo(0.12)
    expect(c.excluded).toEqual(['dclv2.ref-labs.near', 'tok.nearlytrade.near', 'nearlytrade.near'])
    expect(c.top[0]).toEqual({ account: 'dev.near', share: 0.12 })
    expect(INFRA_ACCOUNTS).toContain('dex.intear.near')
  })

  it('no supply: no shares; the dev outside a full page of holders: unknown, not zero; all holders listed and no dev: zero', () => {
    expect(concentration(rows, null, { token: 't', parent: null, dev: null, total: 6, listed: 25 }).top10Share).toBeNull()
    expect(concentration(rows.slice(4), supply, { token: 't', parent: null, dev: 'far.near', total: 900, listed: 2 }).devShare).toBeNull()
    expect(concentration(rows.slice(4), supply, { token: 't', parent: null, dev: 'far.near', total: 2, listed: 25 }).devShare).toBe(0)
  })
})
