import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { costLines, impactEstimated, impactLabel, impactValue } from '@/lib/quoteCosts'
import type { WebTradeLeg } from '@/services/nearkitWeb'
import { ROUTE_SOURCE_LABEL, type RouteSource } from '@/services/routing/select'

/**
 * The NEARKITS-wallet review's words, from the server's quotes (server/src/web/multi.ts): the route's real
 * source (DCL directly or Rhea), how the fee is taken on it, and a wallet's own route and costs when the
 * wallets' routes differ.
 */

/** The route line: the path and its source; with wallets on different sources, both, per wallet. */
export function routeText(path: readonly string[], source: RouteSource | null, legs: readonly Pick<WebTradeLeg, 'source'>[]): string {
  if (!path.length) return '—'
  if (source) return `${path.join(' → ')} · ${ROUTE_SOURCE_LABEL[source]}`
  const labels = [...new Set(legs.flatMap((l) => (l.source ? [ROUTE_SOURCE_LABEL[l.source]] : [])))]
  return labels.length > 1 ? `${path.join(' → ')} · ${labels.join(' and ')}, per wallet` : path.join(' → ')
}

/** How the NEARKITS fee is taken on these routes: inside Rhea's swap, or sent to NEARKITS with a direct DCL swap. */
export function feeText(fee: { charged: boolean }, source: RouteSource | null, networkLabel: string): string {
  if (!fee.charged) return `Not charged on ${networkLabel.toLowerCase()}`
  if (source === 'dcl') return `${NEARKIT_FEE_LABEL}, sent to NEARKITS with the swap`
  if (source === 'rhea-aggregator') return `${NEARKIT_FEE_LABEL}, taken inside the swap by Rhea`
  return `${NEARKIT_FEE_LABEL}, as each wallet’s route takes it`
}

/** One wallet's own route and costs, for its row when the wallets' routes differ. */
export function legRouteText(l: Pick<WebTradeLeg, 'source' | 'costs' | 'priceImpactPct'>, symbols: { in: string; out: string }): string {
  const estimated = impactEstimated(l.costs, true)
  return [
    ...(l.source ? [ROUTE_SOURCE_LABEL[l.source]] : []),
    ...(l.costs ? costLines(l.costs, symbols).map((c) => `${c.label} ${c.value}`) : []),
    `${impactLabel(estimated)} ${impactValue(l.priceImpactPct, estimated)}`,
  ].join(' · ')
}
