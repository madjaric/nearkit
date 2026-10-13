import { describe, expect, it } from 'vitest'
import type { TokenRef } from '@/types/operations'
import { beforeTax, commonCosts, swapCosts, swapImpactPct } from './swapCosts'
import type { RoutedSwap } from './swapRouting'

/**
 * A quote's costs besides NEARKITS' fee, from the route itself: each its own line, none of them
 * counted as price impact, and impact counting none of them.
 */

const NEAR: TokenRef = { id: 'near', symbol: 'NEAR', decimals: 24, contract: null }
const KITS: TokenRef = { id: 'kits.nearlytrade.near', symbol: 'KITS', decimals: 18, contract: 'kits.nearlytrade.near' }
const ONE = 10n ** 24n

const aggregatorBuy = (amountOut: bigint, tax = { inBps: 0, outBps: 0 }): RoutedSwap => ({
  router: 'aggregator',
  source: 'rhea-aggregator',
  tokenIn: NEAR,
  tokenOut: KITS,
  routeIn: 'wrap.near',
  routeOut: KITS.id,
  amountIn: ONE,
  swapAmount: ONE,
  amountOut,
  signedMin: amountOut,
  minOut: amountOut,
  tax,
  slippagePct: 1,
  routeTokens: ['wrap.near', KITS.id],
  stepContracts: ['wrap.near'],
  multiDex: false,
  receiver: 'aggregatedex.near',
  msg: '{}',
  deadline: null,
  fee: { stage: 'input', token: 'wrap.near', appPpm: 5000, protocolPpm: 1000, routerShareBps: 2000, recipient: 'nearkitfee.near' },
  quotedAt: 0,
})

const dclBuy = (pools: string[], impactPct: number | null): RoutedSwap => ({
  ...aggregatorBuy(10n ** 18n, { inBps: 0, outBps: 200 }),
  router: 'dcl',
  source: 'dcl',
  receiver: 'dclv2.ref-labs.near',
  pools,
  impactPct,
  fee: { stage: 'input', token: 'wrap.near', appPpm: 5000, protocolPpm: 0, routerShareBps: 0, recipient: 'nearkitfee.near', transfer: { amount: 5n * 10n ** 21n } },
})

/** 1 NEAR = $5; KITS priced so that `perNear` KITS are worth exactly 1 NEAR. */
const prices = (perNear: number) => async (t: TokenRef) => (t.contract === null ? 5 : 5 / perNear)

describe('the lines a quote shows besides NEARKITS’ fee', () => {
  it('a DCL route: each pool’s own fee tier, no protocol fee, the token’s tax, and impact measured on the pools', () => {
    expect(swapCosts(dclBuy(['kits.nearlytrade.near|wrap.near|10000'], 0.03))).toEqual({
      poolFeesPpm: [10000],
      protocolFeePpm: null,
      tax: { inBps: 0, outBps: 200 },
      impactBasis: 'pools',
    })
    expect(
      swapCosts(
        dclBuy(
          [
            `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|400`,
            '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|kits.nearlytrade.near|2000',
          ],
          null,
        ),
      ).poolFeesPpm,
    ).toEqual([400, 2000])
  })

  it('a Rhea route: Rhea’s protocol fee, its pools in the rate (not itemised), and impact estimated from listed prices', () => {
    expect(swapCosts(aggregatorBuy(588_000n * 10n ** 18n))).toEqual({ poolFeesPpm: null, protocolFeePpm: 1000, tax: { inBps: 0, outBps: 0 }, impactBasis: 'listed-prices' })
  })

  it('undoes the route’s own tax exactly enough to compare: what came out before it', () => {
    expect(beforeTax(9_800n, { inBps: 0, outBps: 200 })).toBe(10_000n)
    expect(beforeTax(9_702n, { inBps: 100, outBps: 200 })).toBe(10_000n)
    expect(beforeTax(1234n, undefined)).toBe(1234n)
  })

  it('lines are shared by Multi Trade wallets only when every wallet’s route has the same', () => {
    const a = swapCosts(dclBuy(['kits.nearlytrade.near|wrap.near|10000'], 0.1))
    const b = swapCosts(aggregatorBuy(1n))
    expect(commonCosts([a, a])).toEqual(a)
    expect(commonCosts([a, b])).toBeNull()
  })
})

describe('price impact never counts a fee or a tax', () => {
  it('a DCL route’s impact is its pools’ own; unknown stays unknown', async () => {
    expect(await swapImpactPct(dclBuy(['kits.nearlytrade.near|wrap.near|10000'], 0.42), prices(1))).toBe(0.42)
    expect(await swapImpactPct(dclBuy(['kits.nearlytrade.near|wrap.near|10000'], null), prices(1))).toBeNull()
  })

  it('a Rhea route’s estimate takes NEARKITS’ fee, Rhea’s protocol fee and the token’s tax off before comparing', async () => {
    // 1 NEAR worth 1,000,000 KITS at listed prices; 0.5% short of that before fees, then the 0.60% of fees.
    const beforeFees = 995_000n * 10n ** 18n
    const quoted = (beforeFees * 994n) / 1000n
    const untaxed = await swapImpactPct(aggregatorBuy(quoted), prices(1_000_000))
    expect(untaxed as number).toBeCloseTo(0.5, 6)
    // The same route through a pool that takes KITS' 2% buy tax: the output is 2% lower, the impact is not.
    const taxed = await swapImpactPct(aggregatorBuy(quoted - (quoted * 200n) / 10_000n, { inBps: 0, outBps: 200 }), prices(1_000_000))
    expect(taxed as number).toBeCloseTo(0.5, 4)
  })

  it('no prices (testnet), a token without a price, or an estimate below zero (the list is off from the pool): unknown, never a reassuring 0', async () => {
    expect(await swapImpactPct(aggregatorBuy(10n ** 18n), null)).toBeNull()
    expect(await swapImpactPct(aggregatorBuy(10n ** 18n), async (t) => (t.contract === null ? 5 : null))).toBeNull()
    expect(await swapImpactPct(aggregatorBuy(1_100_000n * 10n ** 18n), prices(1_000_000))).toBeNull()
  })
})
