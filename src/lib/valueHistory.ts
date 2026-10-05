/**
 * The portfolio's value over time, as this browser saw it: the dashboard records a sample each
 * time it reads the portfolio (executable wallets only), at most one per 5 minutes. Every sample
 * of the last 26 hours is kept (the 1D view), one an hour before that, and nothing older than 31
 * days. Only what was seen: nothing is filled in for the time NearKit wasn't open.
 */

export interface ValueSample {
  t: number
  v: number
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
export const SAMPLE_MS = 5 * MIN
const FINE_MS = 26 * HOUR
const KEEP_MS = 31 * DAY

/** `list` with a reading at `at`: added when the last sample is 5 minutes old or more, then thinned and aged out. */
export function recordValue(list: readonly ValueSample[], at: number, value: number): ValueSample[] {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(at)) return [...list]
  const last = list[list.length - 1]
  if (last && at - last.t < SAMPLE_MS) return [...list]
  const out: ValueSample[] = []
  for (const p of [...list, { t: at, v: value }]) {
    if (at - p.t > KEEP_MS) continue
    const prev = out[out.length - 1]
    // Older than the fine window: one sample per hour, the last one seen in it.
    if (prev && at - p.t > FINE_MS && at - prev.t > FINE_MS && Math.floor(prev.t / HOUR) === Math.floor(p.t / HOUR)) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

/** The samples of the last `days` days, oldest first. */
export function valueWindow(list: readonly ValueSample[], now: number, days: number): ValueSample[] {
  const from = now - days * DAY
  return list.filter((p) => p.t >= from && p.t <= now)
}
