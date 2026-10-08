import { BRIDGE_FEE_BPS } from '@/lib/fees'

/**
 * Bridge & Buy's fee on the cross-chain leg, as NEAR Intents' 1Click API charges it.
 *
 * 1Click takes app fees (`appFees`, bps of the input) and, on its default partner policy, shares
 * each 50/50: half to the app, half to itself, its half at least 20 bps. Measured with dry quotes on
 * 2026-10-08 (no API key): asked 25 → NEARKITS 13 + 1Click 20; asked 50 → 25 + 25. Its quote echoes
 * the request with the fees as it will really charge them (`quoteRequest.appFees`), so the split is
 * read from there, never assumed, and a quote that doesn't pay NEARKITS exactly BRIDGE_FEE_BPS is
 * refused.
 */

/** 1Click's minimum share of an app fee, in bps (its default partner policy). */
export const ONECLICK_MIN_SHARE_BPS = 20

/** The app fee to ask 1Click for so that NEARKITS' half of it is `shareBps`. */
export function bridgeAppFeeRequestBps(shareBps: number = BRIDGE_FEE_BPS): number {
  if (!Number.isInteger(shareBps) || shareBps <= 0) throw new Error('The bridge fee is a whole number of basis points above 0')
  return shareBps * 2
}

export interface BridgeFeeSplit {
  /** What NEARKITS' fee account receives, bps of the amount bridged. */
  nearkitsBps: number
  /** What NEAR Intents' 1Click keeps, bps of the amount bridged. */
  intentsBps: number
  totalBps: number
}

/**
 * The fees a quote really charges, from 1Click's echo of the request: the shares paid to
 * `feeRecipient` are NEARKITS', every other is NEAR Intents'. Null when the echo isn't a list of
 * fees in whole bps.
 */
export function feeSplitOf(echoed: unknown, feeRecipient: string): BridgeFeeSplit | null {
  if (echoed === undefined || echoed === null) return { nearkitsBps: 0, intentsBps: 0, totalBps: 0 }
  if (!Array.isArray(echoed)) return null
  let nearkitsBps = 0
  let intentsBps = 0
  for (const f of echoed) {
    const o = typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : null
    if (!o || typeof o.recipient !== 'string' || typeof o.fee !== 'number' || !Number.isInteger(o.fee) || o.fee < 0 || o.fee > 10_000) return null
    if (o.recipient === feeRecipient) nearkitsBps += o.fee
    else intentsBps += o.fee
  }
  return { nearkitsBps, intentsBps, totalBps: nearkitsBps + intentsBps }
}

/** `bps` of a raw amount, rounded down (an input-side fee, in the input's base units). */
export const bpsOf = (raw: bigint, bps: number): bigint => (raw * BigInt(bps)) / 10_000n

/** A share in bps as people read it: 25 → "0.25%". */
export const bpsPct = (bps: number): string => `${(bps / 100).toFixed(2)}%`
