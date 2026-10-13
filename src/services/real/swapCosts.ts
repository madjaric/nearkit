import { formatUnits } from '@/lib/amounts'
import { dclPoolTokens } from '@/services/dcl/pools'
import { grossOf } from '@/services/rhea/fees'
import type { QuoteCosts } from '@/types/domain'
import type { TokenRef } from '@/types/operations'
import type { RoutedSwap } from './swapRouting'

/**
 * A swap's costs besides NEARKITS' fee, worked out once from the route, for every place a quote is
 * shown: the web's quote and review, the NEARKITS-wallet review, Telegram. Each is its own line:
 *
 * - the exchange's fee: a DCL route's pool fee tiers (from its pool ids), or Rhea's protocol fee on
 *   its aggregator's routes (the pools inside a Rhea route are in its rate, not itemised);
 * - a launch token's own transfer tax, already in the amounts (swapRouting.ts);
 * - price impact: measured on the pools for a DCL route, an estimate from listed USD prices for
 *   others. Impact never counts a fee or the tax: the pools' figures exclude them, and the estimate
 *   takes NEARKITS' fee, Rhea's protocol fee and the tax off before it compares.
 *
 * For a DCL route the figures multiply back to the output: amountIn × (1 − NEARKITS' fee) × (1 − sell
 * tax) × the pools' price × (1 − pool fees) × (1 − impact) × (1 − buy tax) = amountOut.
 */

/** The pool fee tiers of a DCL route, one per pool, in ppm; null when any pool id can't be read. */
function poolFeesOf(r: RoutedSwap): number[] | null {
  if (r.router !== 'dcl' || !r.pools?.length) return null
  const fees = r.pools.map((id) => dclPoolTokens(id)?.fee ?? null)
  return fees.every((f): f is number => f !== null) ? fees : null
}

export function swapCosts(r: RoutedSwap): QuoteCosts {
  return {
    poolFeesPpm: poolFeesOf(r),
    protocolFeePpm: r.router === 'aggregator' && r.fee && !r.fee.transfer && r.fee.protocolPpm > 0 ? r.fee.protocolPpm : null,
    tax: { inBps: r.tax?.inBps ?? 0, outBps: r.tax?.outBps ?? 0 },
    impactBasis: r.router === 'dcl' ? 'pools' : 'listed-prices',
  }
}

/** What `amount` was before the route's own tax took its part (both sides): the inverse of swapRouting's deductions. */
export function beforeTax(amount: bigint, tax: { inBps: number; outBps: number } | undefined): bigint {
  const keep = (10_000n - BigInt(tax?.inBps ?? 0)) * (10_000n - BigInt(tax?.outBps ?? 0))
  return keep > 0n ? (amount * 100_000_000n) / keep : amount
}

/**
 * Price impact (%) of a route; null when it can't be known. A DCL route's is its pools' own
 * (dcl/impact.ts, already on the route). Other routes compare listed USD prices of what goes in
 * with what would come out before NEARKITS' fee, Rhea's protocol fee and the tokens' tax; the
 * pools' own fees stay in it, so it is shown as an estimate. A negative estimate means the listed
 * prices are off from the pools: unknown, never a reassuring zero. `price`: null where there are
 * no USD prices (testnet).
 */
export async function swapImpactPct(r: RoutedSwap, price: ((token: TokenRef) => Promise<number | null>) | null): Promise<number | null> {
  if (r.router === 'dcl') return r.impactPct ?? null
  if (!price) return null
  const [pIn, pOut] = await Promise.all([price(r.tokenIn), price(r.tokenOut)])
  if (!pIn || !pOut) return null
  const untaxed = beforeTax(r.amountOut, r.tax)
  const gross = r.fee && !r.fee.transfer ? grossOf(untaxed, r.fee.appPpm, r.fee.protocolPpm) : untaxed
  const valueIn = Number(formatUnits(r.amountIn, r.tokenIn.decimals)) * pIn
  const valueOut = Number(formatUnits(gross, r.tokenOut.decimals)) * pOut
  if (!(valueIn > 0) || !Number.isFinite(valueOut)) return null
  const pct = (1 - valueOut / valueIn) * 100
  return pct < 0 ? null : pct
}

/** Two routes' costs are the same (Multi Trade: one set of lines for every wallet, else each wallet's own). */
export function sameCosts(a: QuoteCosts, b: QuoteCosts): boolean {
  return (
    a.impactBasis === b.impactBasis &&
    a.protocolFeePpm === b.protocolFeePpm &&
    a.tax.inBps === b.tax.inBps &&
    a.tax.outBps === b.tax.outBps &&
    (a.poolFeesPpm ?? []).join(',') === (b.poolFeesPpm ?? []).join(',') &&
    (a.poolFeesPpm === null) === (b.poolFeesPpm === null)
  )
}

/** One set of costs when every route has the same, else null (each route shows its own). */
export function commonCosts(list: readonly QuoteCosts[]): QuoteCosts | null {
  const [first] = list
  return first && list.every((c) => sameCosts(first, c)) ? first : null
}
