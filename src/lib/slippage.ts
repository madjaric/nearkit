import { HIGH_SLIPPAGE, MAX_SLIPPAGE } from './fees'
import { formatPct } from './format'

/** Problem with a slippage setting, if any. Errors block a trade; warnings only inform. */
export function slippageIssue(value: number): { level: 'error' | 'warning'; message: string } | null {
  if (!Number.isFinite(value) || value <= 0) return { level: 'error', message: 'Slippage must be above 0%' }
  if (value > MAX_SLIPPAGE) return { level: 'error', message: `Slippage is capped at ${MAX_SLIPPAGE}%` }
  if (value > HIGH_SLIPPAGE) return { level: 'warning', message: `High slippage: you may receive up to ${formatPct(value, { signed: false, decimals: 1 })} less than quoted` }
  if (value < 0.1) return { level: 'warning', message: 'Very low slippage: the trade may fail if the price moves' }
  return null
}
