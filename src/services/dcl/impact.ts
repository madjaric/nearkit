import type { DclPool } from './pools'

/**
 * Price impact on DCL v2 pools: "how far your own order moves the pool price" (the glossary's
 * words), measured on the pools the trade runs through, in the same quote:
 *
 *   impact = 1 − (what the pools pay ÷ what they receive) ÷ (their marginal price before the trade)
 *
 * The marginal price is each pool's mid price at its current point (1.0001^point of Y per X, in raw
 * units, so no decimals are involved) less that pool's own fee, multiplied along the path. Both sides
 * are the pools' own amounts: NEARKITS' fee (sent before the pool) and a token's tax (taken on its way
 * into or out of the pool) are outside them, so a cost is never counted as impact; the pool's fee is
 * in both sides, so it cancels. No USD price list is involved: a token's indexed USD price can sit far
 * from its pool (KITS on 2026-10-12: Rhea's list implied 737,000 KITS per NEAR, the pool 588,679).
 * Null when any hop lacks its point or doesn't match the path, or when the fill beats the pools' price by more than a tick
 * per pool (the point read is stale against the quote): an unknown is never guessed.
 */

export interface DclHop {
  pool: Pick<DclPool, 'id' | 'tokenX' | 'tokenY' | 'fee' | 'point'>
  /** The token this hop receives. */
  tokenIn: string
}

/** Raw units of the other token one raw unit of `tokenIn` is worth at the pool's current point, before its fee; null when unknown. */
export function dclMidRate(pool: Pick<DclPool, 'tokenX' | 'tokenY' | 'point'>, tokenIn: string): number | null {
  if (pool.point === null || !Number.isInteger(pool.point)) return null
  const yPerX = Math.pow(1.0001, pool.point)
  if (!(yPerX > 0) || !Number.isFinite(yPerX)) return null
  if (tokenIn === pool.tokenX) return yPerX
  if (tokenIn === pool.tokenY) return 1 / yPerX
  return null
}

/** Price impact (%) of `amountIn` (what the first pool receives) paying `amountOut` (what the last pool pays). */
export function dclImpactPct(hops: readonly DclHop[], amountIn: bigint, amountOut: bigint): number | null {
  if (hops.length === 0 || amountIn <= 0n || amountOut <= 0n) return null
  let marginal = 1
  for (const hop of hops) {
    const mid = dclMidRate(hop.pool, hop.tokenIn)
    if (mid === null) return null
    marginal *= mid * (1 - hop.pool.fee / 1_000_000)
  }
  const executed = Number(amountOut) / Number(amountIn)
  if (!(marginal > 0) || !Number.isFinite(marginal) || !Number.isFinite(executed)) return null
  const shortfall = 1 - executed / marginal
  // A pool's price sits anywhere inside its current point's tick (×1.0001), so a fill may beat the point's price by up to a
  // tick per pool: that is rounding, 0. Better than that, the point read isn't the pool the quote ran on (stale): unknown.
  if (shortfall < -(Math.pow(1.0001, hops.length) - 1) - 1e-9) return null
  return Math.max(0, shortfall * 100)
}
