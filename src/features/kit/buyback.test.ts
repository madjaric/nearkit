import { describe, expect, it } from 'vitest'
import type { KitsBurnView } from '@/services/kitsBurns'
import { burnFigures, burnTrackerState } from './buyback'

/**
 * The Buyback & Burn tracker on the $KITS page: what it says in each state, and the figures it
 * prints from NEARKITS' server's reading. Every figure comes from the reading (or, for the value,
 * today's market price, said as such); none is made up, and a missing one is never a zero.
 */

const VIEW: KitsBurnView = {
  network: 'mainnet',
  token: 'kits.nearlytrade.near',
  launchpad: 'nearlytrade.near',
  launchId: '2699',
  decimals: 18,
  launchSupply: '1000000000000000000000000000',
  supply: '996766484385607587716865419',
  burnedTotal: '3233515614392412283134581',
  burnedByTax: '3233515614392412283134581',
  burns: [
    { tx: '8SzmYJDy4fnKkrZmuYPYkBtzPBZYrFt9frofsWVDjcg6', at: 1791418038627, amount: '78155059288019410500855', kind: 'tax' },
    { tx: 'DNSYUXwwwynxkmjJHKqdKxEfcGyjQEgrLRhtp8qjrmji', at: 1791414898867, amount: '197224380625149214516409', kind: 'tax' },
  ],
  burnCount: 6,
  historyComplete: true,
  readAt: 1791421447361,
  historyReadAt: 1791421446913,
}

const query = (over: Partial<{ data: KitsBurnView; isPending: boolean; isError: boolean }> = {}) => ({ data: undefined, isPending: false, isError: false, ...over })
const base = { contract: 'kits.nearlytrade.near', mode: 'near' as const, network: 'mainnet' as const, apiUrl: 'https://api.nearkits.test' }

describe('the tracker’s state', () => {
  it('is mainnet-only on a network without $KITS, whatever else there is', () => {
    expect(burnTrackerState({ ...base, contract: null, network: 'testnet', query: query({ data: VIEW }) })).toEqual({ state: 'not-on-network' })
  })

  it('has no source in the demo, or in a build not connected to NEARKITS’ server', () => {
    expect(burnTrackerState({ ...base, mode: 'demo', network: null, query: query() })).toEqual({ state: 'no-source', reason: 'demo' })
    expect(burnTrackerState({ ...base, apiUrl: null, query: query() })).toEqual({ state: 'no-source', reason: 'no-server' })
  })

  it('reads, then is live with the reading; a failed refresh keeps the last reading and says so; never read is unavailable', () => {
    expect(burnTrackerState({ ...base, query: query({ isPending: true }) })).toEqual({ state: 'loading' })
    expect(burnTrackerState({ ...base, query: query({ data: VIEW }) })).toEqual({ state: 'live', view: VIEW, refreshFailed: false })
    expect(burnTrackerState({ ...base, query: query({ data: VIEW, isError: true }) })).toEqual({ state: 'live', view: VIEW, refreshFailed: true })
    expect(burnTrackerState({ ...base, query: query({ isError: true }) })).toEqual({ state: 'unavailable' })
  })
})

describe('the figures, from the reading', () => {
  it('prints the KITS burned, its share of the launch supply, the supply now, the burns and the last one', () => {
    const f = burnFigures(VIEW, null)
    expect(f.burned).toBe('3,233,515.61')
    expect(f.burnedPct).toBe('0.32%')
    expect(f.launchSupply).toBe('1,000,000,000')
    expect(f.supply).toBe('996,766,484')
    expect(f.burnCount).toBe(6)
    expect(f.lastBurn).toEqual({ at: 1791418038627, amount: '78,155.05', tx: '8SzmYJDy4fnKkrZmuYPYkBtzPBZYrFt9frofsWVDjcg6' })
    expect(f.allByTax).toBe(true)
  })

  it('values the burned KITS only at a known price, as today’s value, and never makes one up', () => {
    expect(burnFigures(VIEW, null).valueUsd).toBeNull()
    expect(burnFigures(VIEW, 0.00000886).valueUsd).toBeCloseTo(28.65, 2)
  })

  it('says when not every burn came through the tax, and has no last burn without one', () => {
    const mixed = { ...VIEW, burnedByTax: '3000000000000000000000000' }
    expect(burnFigures(mixed, null).allByTax).toBe(false)
    expect(burnFigures({ ...VIEW, burns: [], burnCount: 0 }, null).lastBurn).toBeNull()
  })

  it('reads a share below 0.01% as such, not as zero', () => {
    const tiny = { ...VIEW, supply: '999999999000000000000000000', burnedTotal: '1000000000000000000', burnedByTax: '1000000000000000000' }
    expect(burnFigures(tiny, null).burnedPct).toBe('< 0.01%')
  })
})
