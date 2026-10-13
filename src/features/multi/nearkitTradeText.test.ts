import { describe, expect, it } from 'vitest'
import type { QuoteCosts } from '@/types/domain'
import { feeText, legRouteText, routeText } from './nearkitTradeText'

/** The NEARKITS-wallet review says the route each trade really takes, and how the fee is taken on it. */

const dcl: QuoteCosts = { poolFeesPpm: [10000], protocolFeePpm: null, tax: { inBps: 0, outBps: 200 }, impactBasis: 'pools' }

describe('the NEARKITS-wallet review', () => {
  it('a custody trade through DCL is labelled DCL, never Rhea', () => {
    expect(routeText(['NEAR', 'KITS'], 'dcl', [{ source: 'dcl' }])).toBe('NEAR → KITS · DCL')
    expect(routeText(['NEAR', 'KITS'], 'dcl', [{ source: 'dcl' }])).not.toMatch(/Rhea/)
    expect(routeText(['NEAR', 'USDT'], 'rhea-aggregator', [{ source: 'rhea-aggregator' }])).toBe('NEAR → USDT · Rhea')
  })

  it('wallets on different routes: both sources, per wallet; an unknown source is never guessed', () => {
    expect(routeText(['NEAR', 'KITS'], null, [{ source: 'dcl' }, { source: 'rhea-aggregator' }])).toBe('NEAR → KITS · DCL and Rhea, per wallet')
    expect(routeText(['NEAR', 'KITS'], null, [{ source: null }])).toBe('NEAR → KITS')
    expect(routeText([], 'dcl', [])).toBe('—')
  })

  it('the fee: sent to NEARKITS with a DCL swap, taken inside Rhea’s, never "included in the rate" for both', () => {
    expect(feeText({ charged: true }, 'dcl', 'Mainnet')).toBe('0.50%, sent to NEARKITS with the swap')
    expect(feeText({ charged: true }, 'rhea-aggregator', 'Mainnet')).toBe('0.50%, taken inside the swap by Rhea')
    expect(feeText({ charged: true }, null, 'Mainnet')).toBe('0.50%, as each wallet’s route takes it')
    expect(feeText({ charged: false }, 'dcl', 'Testnet')).toBe('Not charged on testnet')
  })

  it('a wallet’s own route on its row: source, pool fee, tax and impact, each said once', () => {
    expect(legRouteText({ source: 'dcl', costs: dcl, priceImpactPct: 0.0331 }, { in: 'NEAR', out: 'KITS' })).toBe('DCL · Pool fee 1.00% · KITS buy tax 2% · Price impact 0.03%')
    expect(legRouteText({ source: null, costs: null, priceImpactPct: null }, { in: 'NEAR', out: 'KITS' })).toBe('Price impact (est.) Unknown')
  })
})
