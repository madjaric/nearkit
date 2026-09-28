/**
 * Allocation math for multi-wallet tools. Amounts are split in integer units at a
 * fixed precision so the parts always add back to the whole exactly.
 */

export type BalanceState = 'empty' | 'under' | 'balanced' | 'over' | 'invalid'

const EPS = 1e-9

function scale(precision: number): number {
  return 10 ** precision
}

/** Split `total` into `count` near-equal parts; the remainder lands on the first parts. */
export function equalSplit(total: number, count: number, precision = 6): number[] {
  if (count <= 0 || !Number.isFinite(total) || total <= 0) return Array.from({ length: Math.max(0, count) }, () => 0)
  const f = scale(precision)
  const units = Math.round(total * f)
  const base = Math.floor(units / count)
  let remainder = units - base * count
  return Array.from({ length: count }, () => {
    const extra = remainder > 0 ? 1 : 0
    remainder -= extra
    return (base + extra) / f
  })
}

/** Equal percentages that sum to exactly 100 at 2 decimals. */
export function equalPercents(count: number): number[] {
  return equalSplit(100, count, 2)
}

/**
 * Amount per percentage. When the percentages sum to 100, the last non-zero part
 * absorbs rounding so the amounts sum to `total` exactly.
 */
export function amountsFromPercents(total: number, percents: number[], precision = 6): number[] {
  const f = scale(precision)
  const units = Math.round(Math.max(0, total) * f)
  const parts = percents.map((p) => (Number.isFinite(p) && p > 0 ? Math.floor((units * p) / 100) : 0))
  const sumPct = percents.reduce((s, p) => s + (Number.isFinite(p) && p > 0 ? p : 0), 0)
  if (Math.abs(sumPct - 100) < EPS) {
    const used = parts.reduce((s, u) => s + u, 0)
    let lastIndex = -1
    percents.forEach((p, i) => {
      if (p > 0) lastIndex = i
    })
    if (lastIndex >= 0) parts[lastIndex] = (parts[lastIndex] ?? 0) + (units - used)
  }
  return parts.map((u) => u / f)
}

export function sumOf(values: number[]): number {
  return values.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0)
}

/** Balance state of a set of percentages that must total 100. */
export function percentState(percents: number[]): BalanceState {
  if (percents.length === 0) return 'empty'
  if (percents.some((p) => !Number.isFinite(p) || p < 0)) return 'invalid'
  const total = sumOf(percents)
  if (total === 0) return 'empty'
  if (Math.abs(total - 100) < 0.005) return 'balanced'
  return total < 100 ? 'under' : 'over'
}

/** Balance state of amounts that must fit within (and ideally equal) a budget. */
export function amountState(amounts: number[], budget: number): BalanceState {
  if (amounts.length === 0) return 'empty'
  if (amounts.some((a) => !Number.isFinite(a) || a < 0)) return 'invalid'
  const total = sumOf(amounts)
  if (total === 0) return 'empty'
  const tolerance = Math.max(1e-6, budget * 1e-9)
  if (Math.abs(total - budget) <= tolerance) return 'balanced'
  return total < budget ? 'under' : 'over'
}

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}
