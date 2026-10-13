import { describe, expect, it } from 'vitest'
import type { QuoteCosts } from '@/types/domain'
import { costLines, impactEstimated, impactLabel, impactValue } from './quoteCosts'

/** Every surface says a quote's costs with the same words: each cost its own line, impact labelled by how it is known. */

const dcl: QuoteCosts = { poolFeesPpm: [10000], protocolFeePpm: null, tax: { inBps: 0, outBps: 200 }, impactBasis: 'pools' }
const rhea: QuoteCosts = { poolFeesPpm: null, protocolFeePpm: 1000, tax: { inBps: 0, outBps: 0 }, impactBasis: 'listed-prices' }

describe('cost lines', () => {
  it('a DCL buy of a taxed token: the pool’s tier and the token’s buy tax, nothing else', () => {
    expect(costLines(dcl, { in: 'NEAR', out: 'KITS' }).map((l) => [l.label, l.value])).toEqual([
      ['Pool fee', '1.00%'],
      ['KITS buy tax', '2%'],
    ])
  })

  it('two pools are two tiers; a sell names the input’s sell tax', () => {
    const lines = costLines({ ...dcl, poolFeesPpm: [400, 2000], tax: { inBps: 250, outBps: 0 } }, { in: 'KITS', out: 'NEAR' })
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ['Pool fees', '0.04% + 0.20%'],
      ['KITS sell tax', '2.5%'],
    ])
  })

  it('a Rhea route: its pools in the rate (not itemised) and Rhea’s protocol fee', () => {
    expect(costLines(rhea, { in: 'NEAR', out: 'USDC' }).map((l) => [l.label, l.value])).toEqual([
      ['Pool fees', 'In the rate'],
      ['Rhea protocol fee', '0.10%'],
    ])
  })
})

describe('price impact', () => {
  it('measured on the pools: two decimals, no "est."', () => {
    expect(impactEstimated(dcl, true)).toBe(false)
    expect(impactLabel(false)).toBe('Price impact')
    expect(impactValue(0.0331, false)).toBe('0.03%')
  })

  it('estimated from listed prices: labelled so, one decimal, never more precise than its source', () => {
    expect(impactEstimated(rhea, false)).toBe(true)
    expect(impactLabel(true)).toBe('Price impact (est.)')
    expect(impactValue(0.3456, true)).toBe('≈ 0.3%')
  })

  it('without a route’s costs the caller says how it is known (Multi Trade wallets on different routes: an estimate)', () => {
    expect(impactEstimated(undefined, true)).toBe(true)
    expect(impactEstimated(null, false)).toBe(false)
  })

  it('unknown is said, never a zero', () => {
    expect(impactValue(null, false)).toBe('Unknown')
    expect(impactValue(null, true, '—')).toBe('—')
  })
})
