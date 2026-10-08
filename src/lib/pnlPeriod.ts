import type { PnlPoint, PnlRange } from '@/types/domain'
import { formatClock, formatDate } from './format'

/**
 * The PnL page's periods, in one place: how far back each reaches, and how its cumulative chart is
 * cut. 24H is the last 24 hours to the millisecond, an hour a point; 7D six hours a point; 30D, 90D
 * and All a day a point (All from the first closed trade's day). Used by both report builders
 * (services/real/pnlReport.ts, the demo's), so the chart reads the same in either.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

export const PNL_PERIODS: readonly { value: PnlRange; label: string; /** Said in sentences: "in the last 24 hours". */ name: string }[] = [
  { value: '24h', label: '24H', name: 'the last 24 hours' },
  { value: '7d', label: '7D', name: 'the last 7 days' },
  { value: '30d', label: '30D', name: 'the last 30 days' },
  { value: '90d', label: '90D', name: 'the last 90 days' },
  { value: 'all', label: 'All', name: 'all history' },
]

/** How far back each period reaches; null: the whole history. */
export const PERIOD_MS: Readonly<Record<PnlRange, number | null>> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, all: null }

/** One chart point per bucket of this length. */
export const BUCKET_MS: Readonly<Record<PnlRange, number>> = { '24h': HOUR, '7d': 6 * HOUR, '30d': DAY, '90d': DAY, all: DAY }

/** When the period starts (ms); 0 for the whole history. */
export function periodStart(range: PnlRange, now: number): number {
  const span = PERIOD_MS[range]
  return span === null ? 0 : now - span
}

/** In the period: from its start on. A block time a little ahead of this clock still counts (clock skew loses nothing). */
export function inPeriod(at: number, range: PnlRange, now: number): boolean {
  return at >= periodStart(range, now)
}

/** The sum of what happened in the period (gas, volume, …). */
export function sumInPeriod(items: readonly { at: number; value: number }[], range: PnlRange, now: number): number {
  return items.reduce((s, x) => (inPeriod(x.at, range, now) ? s + x.value : s), 0)
}

export interface BookedEvent {
  at: number
  /** Realized PnL booked by it (only events whose result is known). */
  pnl: number
  /** Value traded, for return on volume. */
  volume: number
}

/**
 * The cumulative realized PnL chart: a point at the period's start at 0, then one per bucket, each
 * holding what was booked in it and the running total at its end (the last one ends now).
 */
export function pnlPoints(events: readonly BookedEvent[], range: PnlRange, now: number): PnlPoint[] {
  const bucket = BUCKET_MS[range]
  const since = periodStart(range, now)
  const counted = events.filter((e) => inPeriod(e.at, range, now))
  const first = PERIOD_MS[range] === null ? (counted.length ? Math.min(...counted.map((e) => e.at)) : now) : since
  const start = Math.floor(first / bucket) * bucket
  const points: PnlPoint[] = [{ t: start, end: start, booked: 0, cumulative: 0, volumeUsd: 0 }]
  let cumulative = 0
  // At least one bucket, so a chart always has a span to draw.
  for (let b = start; b < now || b === start; b += bucket) {
    // The last bucket also takes anything stamped a moment after now (clock skew).
    const last = b + bucket >= now
    const these = counted.filter((e) => e.at >= b && (last || e.at < b + bucket))
    const booked = these.reduce((s, e) => s + e.pnl, 0)
    cumulative += booked
    points.push({ t: b, end: Math.min(b + bucket, Math.max(now, b + 1)), booked, cumulative, volumeUsd: these.reduce((s, e) => s + e.volume, 0) })
  }
  return points
}

const DAY_MS = 86_400_000

/** A bucket as a reader names it: "Oct 8, 13:00–14:00" for hours, "Oct 8, 2026" for a day; the first point is the period's start. */
export function bucketLabel(p: PnlPoint, bucketMs: number): string {
  if (p.end === p.t) return `Start · ${formatDate(p.t)}, ${formatClock(p.t)}`
  if (bucketMs >= DAY_MS) return formatDate(p.t, true)
  return `${formatDate(p.t)}, ${formatClock(p.t)}–${formatClock(p.end)}`
}

/** What one bucket is called: "hour", "6 h", "day". */
export const bucketWord = (bucketMs: number): string => (bucketMs >= DAY_MS ? 'day' : bucketMs === 3_600_000 ? 'hour' : `${Math.round(bucketMs / 3_600_000)} h`)
