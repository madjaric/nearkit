/**
 * Choosing between executable routes from different sources. Deterministic: the route that
 * pays the most, measured the same way for every source (what the user receives after DEX
 * fees, the router's protocol fee and NearKit's fee). Rhea's aggregator is production-proven,
 * so a route that beats it by less than RHEA_PREFERENCE_PPM keeps Rhea; a materially better
 * route wins whatever its source.
 */

export type RouteSource = 'rhea-aggregator' | 'rhea-classic' | 'dcl'

/** How the source reads in a quote, a review and the bot. */
export const ROUTE_SOURCE_LABEL: Record<RouteSource, string> = { 'rhea-aggregator': 'Rhea', 'rhea-classic': 'Rhea', dcl: 'DCL' }

/** Within this much of Rhea's net output, Rhea's route is kept (0.25%). */
export const RHEA_PREFERENCE_PPM = 2_500n
const PPM = 1_000_000n

export interface Rankable {
  source: RouteSource
  /** Expected output as quoted. */
  amountOut: bigint
  /** Fees still to come off the quoted output (an aggregator fee taken from the output), in ppm. */
  outputFeePpm: number
}

/** What the user is expected to receive: the quote less any fee still taken from it. */
export function netOutOf(r: Rankable): bigint {
  return (r.amountOut * (PPM - BigInt(r.outputFeePpm))) / PPM
}

export function selectRoute<T extends Rankable>(candidates: readonly T[]): T {
  if (candidates.length === 0) throw new Error('No route to select from')
  let best = candidates[0] as T
  for (const c of candidates.slice(1)) if (netOutOf(c) > netOutOf(best)) best = c
  const rhea = candidates.find((c) => c.source !== 'dcl')
  if (rhea && best !== rhea && netOutOf(rhea) * PPM >= netOutOf(best) * (PPM - RHEA_PREFERENCE_PPM)) return rhea
  return best
}
