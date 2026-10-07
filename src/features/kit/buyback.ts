import type { KitStatus } from '@/config/kit'
import { formatUnits } from '@/lib/amounts'
import { formatDateTime, formatUsd, truncateMiddle } from '@/lib/format'

/**
 * $KIT's Buyback & Burn as the chain records it: what the buybacks spent, what was burned, and when
 * the last buyback landed. An on-chain source fills this in; none exists yet, so the $KIT page hands
 * the tracker nothing and it says so. A figure no source has read is null, never 0.
 */
export interface BuybackFacts {
  /** NEAR spent on buybacks, in total, in yoctoNEAR. */
  boughtBackYocto: string | null
  /** That NEAR's USD value at the time of each buyback. */
  boughtBackUsd: number | null
  /** $KIT burned, in total, in its smallest unit. */
  burnedRaw: string | null
  /** The burned $KIT's USD value at the time of each burn. */
  burnedUsd: number | null
  /** When the last buyback landed (ms), and its transaction. */
  lastBuybackAt: number | null
  lastBuybackTx: string | null
}

export type BuybackTracker =
  /** $KIT has no contract yet: there is nothing to track. */
  | { state: 'awaiting-launch' }
  /** $KIT is live, but nothing reads its buybacks and burns from the chain yet. */
  | { state: 'awaiting-data' }
  | { state: 'tracking'; facts: BuybackFacts }

/** What the tracker shows: nothing before launch, whatever it is handed; then what a source read, if one did. */
export function buybackTracker(status: KitStatus, facts: BuybackFacts | null): BuybackTracker {
  if (status !== 'live') return { state: 'awaiting-launch' }
  return facts ? { state: 'tracking', facts } : { state: 'awaiting-data' }
}

export interface BuybackReadout {
  legend: string
  value: string
  sub: string
}

/** A figure no source has read. */
export const UNKNOWN = '—'
const NEAR_DECIMALS = 24

/** The tracker's four readouts. Until a source has read a figure, it is "—", and its caption says what will be there. */
export function buybackReadouts(tracker: BuybackTracker, kitDecimals: number | null): BuybackReadout[] {
  const f = tracker.state === 'tracking' ? tracker.facts : null
  const usd = (value: number | null | undefined) => (value != null ? `≈ ${formatUsd(value)}` : null)
  const units = (raw: string | null | undefined, decimals: number | null, unit: string) =>
    raw != null && decimals !== null ? `${formatUnits(BigInt(raw), decimals, { maxFraction: 2, group: true })} ${unit}` : UNKNOWN
  return [
    {
      legend: 'Total bought back',
      value: units(f?.boughtBackYocto, NEAR_DECIMALS, 'NEAR'),
      sub: f ? (usd(f.boughtBackUsd) ?? 'USD value unknown') : 'NEAR spent, and its USD value',
    },
    { legend: 'Total burned', value: f?.burnedUsd != null ? formatUsd(f.burnedUsd) : UNKNOWN, sub: 'USD value of the $KIT burned' },
    { legend: '$KIT burned', value: units(f?.burnedRaw, kitDecimals, 'KIT'), sub: 'tokens burned' },
    {
      legend: 'Last buyback',
      value: f?.lastBuybackAt != null ? formatDateTime(f.lastBuybackAt) : UNKNOWN,
      sub: f?.lastBuybackTx ? `Tx ${truncateMiddle(f.lastBuybackTx, 6, 3)}` : 'when, and its transaction',
    },
  ]
}
