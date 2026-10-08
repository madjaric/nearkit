import { formatUnits } from '@/lib/amounts'
import type { KitsBurn } from '@/services/kitsBurns'

/**
 * The Buyback & Burn chart's series: KITS burned in all over time, from the verified burn
 * transactions only. Each burn is one step up at the moment it ran; between burns the total stays
 * where it is (nothing is interpolated: a burn is an event, not a rate), and the line runs flat to
 * `now` from the last one. Amounts stay exact until they are turned into plot coordinates.
 */

export interface BurnStep {
  tx: string
  /** When the burn ran (ms). */
  at: number
  /** KITS burned by this transaction, whole units (for the plot); `amountText` is exact. */
  amount: number
  amountText: string
  /** KITS burned by this burn and every one before it. */
  cumulative: number
  cumulativeText: string
  kind: KitsBurn['kind']
}

export interface BurnSeries {
  steps: BurnStep[]
  /** The plot's time span: the first burn to now. */
  start: number
  end: number
  /** The total the last step reaches. */
  max: number
}

const whole = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals))
const text = (raw: bigint, decimals: number) => formatUnits(raw, decimals, { maxFraction: 2, group: true })

/** Oldest burn first, each with its running total. Null when there is no burn to draw. */
export function burnSeries(burns: readonly KitsBurn[], decimals: number, now: number): BurnSeries | null {
  if (!burns.length) return null
  const sorted = [...burns].sort((a, b) => a.at - b.at || a.tx.localeCompare(b.tx))
  let running = 0n
  const steps = sorted.map((b): BurnStep => {
    const raw = BigInt(b.amount)
    running += raw
    return {
      tx: b.tx,
      at: b.at,
      amount: whole(raw, decimals),
      amountText: text(raw, decimals),
      cumulative: whole(running, decimals),
      cumulativeText: text(running, decimals),
      kind: b.kind,
    }
  })
  const first = steps[0] as BurnStep
  const last = steps[steps.length - 1] as BurnStep
  return { steps, start: first.at, end: Math.max(now, last.at), max: last.cumulative }
}
