import type { QuoteCosts } from '@/types/domain'
import { formatNumber, formatPct } from './format'

/**
 * A quote's cost lines in words, the same on every surface (the web's quote and review, the NEARKITS-wallet
 * review, Telegram). The figures come from the route, worked out once (services/real/swapCosts.ts); this only
 * says them. Rates are exact (pool tiers, Rhea's rate, a token's stated tax); a price impact measured on the
 * pools has two decimals, an estimate from listed prices one, marked as an estimate.
 */

export interface CostLine {
  key: 'pool' | 'protocol' | 'tax-in' | 'tax-out'
  label: string
  value: string
  /** What the line means, for a tooltip or a note. */
  hint: string
}

const ppmPct = (ppm: number) => `${formatNumber(ppm / 10_000, 2, 2)}%`
const bpsPct = (bps: number) => `${formatNumber(bps / 100, 0, 2)}%`

export function costLines(c: QuoteCosts, symbols: { in: string; out: string }): CostLine[] {
  const lines: CostLine[] = []
  if (c.poolFeesPpm?.length) {
    const many = c.poolFeesPpm.length > 1
    lines.push({
      key: 'pool',
      label: many ? 'Pool fees' : 'Pool fee',
      value: c.poolFeesPpm.map(ppmPct).join(' + '),
      hint: `${many ? 'Each DCL pool’s own fee tier' : 'The DCL pool’s own fee tier'}, kept by the pool and already in the rate. Not a NEARKITS fee, and not price impact.`,
    })
  } else {
    lines.push({ key: 'pool', label: 'Pool fees', value: 'In the rate', hint: 'The pools on this route charge their own fees inside the rate; the route doesn’t itemise them.' })
  }
  if (c.protocolFeePpm)
    lines.push({
      key: 'protocol',
      label: 'Rhea protocol fee',
      value: ppmPct(c.protocolFeePpm),
      hint: 'Rhea’s own fee on every swap through its aggregator, separate from the NEARKITS fee.',
    })
  if (c.tax.inBps)
    lines.push({
      key: 'tax-in',
      label: `${symbols.in} sell tax`,
      value: bpsPct(c.tax.inBps),
      hint: `${symbols.in}’s own tax on tokens entering its pool, kept by the token. Already in the amounts; not a NEARKITS fee.`,
    })
  if (c.tax.outBps)
    lines.push({
      key: 'tax-out',
      label: `${symbols.out} buy tax`,
      value: bpsPct(c.tax.outBps),
      hint: `${symbols.out}’s own tax on tokens leaving its pool, kept by the token. Already in the amounts; not a NEARKITS fee.`,
    })
  return lines
}

/**
 * Whether a quote's price impact is an estimate from listed prices. A route's costs say how it was known;
 * without them (wrapping, the demo's model, Multi Trade wallets on different routes) the caller says.
 */
export function impactEstimated(c: QuoteCosts | null | undefined, otherwise: boolean): boolean {
  return c ? c.impactBasis === 'listed-prices' : otherwise
}

/** Price impact's label: measured, or an estimate from listed prices. */
export function impactLabel(estimated: boolean): string {
  return estimated ? 'Price impact (est.)' : 'Price impact'
}

/** Price impact's figure, at the precision its source supports; `unknown` when there is none. */
export function impactValue(pct: number | null, estimated: boolean, unknown = 'Unknown'): string {
  if (pct === null) return unknown
  return estimated ? `≈ ${formatPct(pct, { signed: false, decimals: 1 })}` : formatPct(pct, { signed: false })
}

/** Why an impact is unknown, in a few words. */
export function impactUnknownReason(estimated: boolean): string {
  return estimated ? 'no listed prices to estimate it' : 'the pool’s price before the trade couldn’t be read reliably'
}
