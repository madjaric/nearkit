import { NEAR_DECIMALS } from '@/config/networks'
import { bridgeChain, type BridgeChain } from '@/config/bridge'
import { formatUnits } from '@/lib/amounts'
import type { BridgeOrderView } from '@/lib/bridge/types'

/** Raw amounts as Bridge & Buy prints them: grouped, a few decimals, never rounded up. */

const KITS_DECIMALS = 18

/** A raw amount in `decimals`, at most `maxFraction` decimals (fewer for big figures). */
export function rawText(raw: string | bigint, decimals: number, maxFraction = 6): string {
  const v = typeof raw === 'bigint' ? raw : BigInt(raw)
  const whole = v / 10n ** BigInt(decimals)
  const frac = whole >= 1_000_000n ? 0 : whole >= 1_000n ? Math.min(2, maxFraction) : maxFraction
  return formatUnits(v, decimals, { maxFraction: frac, group: true })
}

export const nearText = (yocto: string | bigint, maxFraction = 4) => rawText(yocto, NEAR_DECIMALS, maxFraction)
export const kitsText = (raw: string | bigint) => rawText(raw, KITS_DECIMALS, 2)

/** mm:ss until `at`, or 0:00 once passed. */
export function countdown(at: number, now: number): string {
  const s = Math.max(0, Math.floor((at - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** NEAR Intents' time estimate, as people say it. */
export function etaText(seconds: number): string {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`
  return `~${Math.round(seconds / 60)} min`
}

/**
 * "1 SOL → 123,456 KITS" (Bridge & Buy) or "0.06 SOL → 1.42 NEAR" (Bridge): what was received when it
 * was (the unwrap's or the delivery's own record), what is expected while it isn't.
 */
export function orderSummary(o: BridgeOrderView): string {
  const chain = bridgeChain(o.chain) as BridgeChain
  const from = `${rawText(o.quote.amountIn, chain.decimals)} ${chain.symbol}`
  if (o.product === 'bridge') {
    if (o.unwrapped) return `${from} → ${nearText(o.unwrapped.amount)} NEAR`
    if (o.delivered) return `${from} → ${nearText(o.delivered.amount)} ${o.delivered.asset === 'wnear' ? 'wNEAR' : 'NEAR'}`
    if (o.status !== 'refunded' && o.status !== 'expired' && o.status !== 'failed') return `${from} → ≈ ${nearText(o.quote.nearOut)} NEAR`
    return `${from} → NEAR`
  }
  if (o.kits) return `${from} → ${kitsText(o.kits.amount)} KITS`
  if (o.quote.kits && o.status !== 'refunded' && o.status !== 'expired' && o.status !== 'failed') return `${from} → ≈ ${kitsText(o.quote.kits.amountOut)} KITS`
  return `${from} → $KITS`
}
