import { NEAR_DECIMALS } from '@/config/networks'
import { tryParseUnits } from '@/lib/amounts'
import type { LimitOrderType } from './config'

/**
 * Trigger arithmetic, exact (integers only). A price is NEAR per whole token, as an executable
 * quote gives it: NEAR spent per token received on a buy, NEAR received per token sold on a sell,
 * every fee, tax and price impact already in it. A target is a decimal string of NEAR, compared as
 * yoctoNEAR per whole token, so a boundary is decided without rounding.
 */

/** The target as yoctoNEAR per whole token; null if it isn't a positive decimal of at most 24 places. */
export function targetYocto(triggerPriceNear: string): bigint | null {
  const p = tryParseUnits(triggerPriceNear, NEAR_DECIMALS)
  return p.ok && p.value > 0n ? p.value : null
}

/** A quote's price as yoctoNEAR per whole token (rounded down); null for a quote of nothing. */
export function priceYocto(nearRaw: bigint, tokenRaw: bigint, decimals: number): bigint | null {
  if (nearRaw <= 0n || tokenRaw <= 0n) return null
  return (nearRaw * 10n ** BigInt(decimals)) / tokenRaw
}

/**
 * Whether the executable quote meets the order's condition:
 * - limit buy: buy when it costs at most the target (price ≤ target);
 * - limit sell and take profit: sell when it pays at least the target (price ≥ target);
 * - stop loss: sell when it pays at most the target (price ≤ target).
 * Compared as nearRaw × 10^decimals against target × tokenRaw: no division, no rounding.
 */
export function meetsTrigger(type: LimitOrderType, nearRaw: bigint, tokenRaw: bigint, decimals: number, target: bigint): boolean {
  if (nearRaw <= 0n || tokenRaw <= 0n || target <= 0n) return false
  const left = nearRaw * 10n ** BigInt(decimals)
  const right = target * tokenRaw
  return type === 'limit-sell' || type === 'take-profit' ? left >= right : left <= right
}

/** yoctoNEAR per whole token as a short decimal for messages (never used for a decision). */
export function formatPrice(yocto: bigint): string {
  const whole = yocto / 10n ** 24n
  const frac = (yocto % 10n ** 24n).toString().padStart(24, '0')
  if (whole > 0n) return `${whole}.${frac.slice(0, 4)}`.replace(/\.?0+$/, '')
  const firstSignificant = frac.search(/[1-9]/)
  if (firstSignificant < 0) return '0'
  return `0.${frac.slice(0, Math.min(24, firstSignificant + 4))}`.replace(/0+$/, '')
}
