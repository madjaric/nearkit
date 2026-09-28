import { MS } from '@/lib/time'
import type { DcaFrequency } from '@/types/domain'

export const FREQUENCIES: { value: DcaFrequency; label: string; words: string; ms: number }[] = [
  { value: '1h', label: '1 hour', words: 'every hour', ms: MS.hour },
  { value: '4h', label: '4 hours', words: 'every 4 hours', ms: 4 * MS.hour },
  { value: '12h', label: '12 hours', words: 'every 12 hours', ms: 12 * MS.hour },
  { value: '1d', label: '1 day', words: 'every day', ms: MS.day },
  { value: '1w', label: '1 week', words: 'every week', ms: MS.week },
]

export function frequencyOf(value: DcaFrequency) {
  return FREQUENCIES.find((f) => f.value === value) ?? FREQUENCIES[1]!
}

/** Number of runs between start and end inclusive, or null when open-ended. */
export function runCount(start: number, end: number | null, ms: number): number | null {
  if (end === null) return null
  if (end < start) return 0
  return Math.floor((end - start) / ms) + 1
}

/** The next run at or after `now` for a plan that started at `start`. */
export function nextRun(start: number, ms: number, now: number, end: number | null): number | null {
  const at = start >= now ? start : start + Math.ceil((now - start) / ms) * ms
  return end !== null && at > end ? null : at
}
