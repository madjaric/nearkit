import { describe, expect, it } from 'vitest'
import type { QuoteCosts } from '@/types/domain'
import type { Intent } from '../custody/store'
import type { SwapParams, SwapQuote } from '../custody/swap'
import { legView, tradeFacts } from './multi'

/**
 * The NEARKITS-wallet review on the web, from the server's quotes: what each wallet's route is and costs,
 * and what the whole trade shares. Nothing a route said is dropped on the way (its source, its tax).
 */

const KITS = 'kits.nearlytrade.near'
const dclCosts: QuoteCosts = { poolFeesPpm: [10000], protocolFeePpm: null, tax: { inBps: 0, outBps: 200 }, impactBasis: 'pools' }
const rheaCosts: QuoteCosts = { poolFeesPpm: null, protocolFeePpm: 1000, tax: { inBps: 0, outBps: 0 }, impactBasis: 'listed-prices' }

const params: SwapParams = { side: 'buy', token: KITS, symbol: 'KITS', decimals: 18, amountIn: '1', slippagePct: 1 }
const quote = (over: Partial<SwapQuote>): SwapQuote => ({
  router: 'dcl',
  source: 'dcl',
  amountInRaw: (10n ** 24n).toString(),
  amountOut: '1000',
  minOut: '990',
  path: ['NEAR', 'KITS'],
  tax: { inBps: 0, outBps: 200 },
  costs: dclCosts,
  priceImpactPct: 0.03,
  fee: { charged: true, bps: 50, amountRaw: '5000000000000000000000', token: 'near', routerShareBps: 0 },
  registration: '0',
  networkFeeNear: '5000000000000000000000',
  quotedAt: 1,
  expiresAt: 60_001,
  ...over,
})
const intent = (q: SwapQuote, id = 'i1', walletId = 'w1'): Intent =>
  ({
    id,
    walletId,
    userId: 1,
    chatId: 1,
    kind: 'buy',
    params,
    quote: q,
    status: 'quoted',
    expiresAt: q.expiresAt,
    result: null,
    replacedBy: null,
    groupId: 'g',
  }) as unknown as Intent
const wallet = { id: 'w1', accountId: 'a.near', slot: 1, label: 'Main' }

describe('the NEARKITS-wallet review’s facts', () => {
  it('keeps each wallet’s route source, costs (its tax with them) and impact', () => {
    const leg = legView(intent(quote({})), wallet, 0)
    expect(leg).toMatchObject({ source: 'dcl', costs: dclCosts, priceImpactPct: 0.03 })
    expect(tradeFacts([intent(quote({}))])).toMatchObject({ source: 'dcl', costs: dclCosts, priceImpactPct: 0.03 })
  })

  it('a DCL trade is said to be DCL’s, not Rhea’s, and its tax is not lost', () => {
    const facts = tradeFacts([intent(quote({}))])
    expect(facts.source).toBe('dcl')
    expect(facts.costs?.tax).toEqual({ inBps: 0, outBps: 200 })
  })

  it('wallets on different routes share no source or costs: each wallet’s own stays on its leg', () => {
    const rhea = quote({ router: 'aggregator', source: 'rhea-aggregator', tax: undefined, costs: rheaCosts, priceImpactPct: 0.2 })
    const facts = tradeFacts([intent(quote({})), intent(rhea, 'i2', 'w2')])
    expect(facts.source).toBeNull()
    expect(facts.costs).toBeNull()
    expect(facts.priceImpactPct).toBe(0.2)
  })

  it('the worst impact is unknown when any wallet’s is: never the others’ figure', () => {
    expect(tradeFacts([intent(quote({})), intent(quote({ priceImpactPct: null }), 'i2', 'w2')]).priceImpactPct).toBeNull()
  })

  it('a quote saved before costs were part of it shows none rather than a guess', () => {
    const old = quote({})
    delete (old as Partial<SwapQuote>).costs
    expect(legView(intent(old), wallet, 0).costs).toBeNull()
    expect(tradeFacts([intent(old)]).costs).toBeNull()
  })
})
