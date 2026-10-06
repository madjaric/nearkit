import type { HourWindow, RunProgress, ScheduleConfig } from './types'

/**
 * When the Volume Bot may act: its runtime and trade count, its UTC trading hours and pause windows,
 * the cooldown after a trade, and how many trades may be in flight. Pure: time comes in as `now`.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

const hourOf = (at: number) => new Date(at).getUTCHours()
const dayStart = (at: number) => at - (at % DAY)
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`
const label = (w: HourWindow) => `${hh(w.from)}–${hh(w.to)} UTC`

/** True when `at` falls inside the window ([from, to), spanning midnight when from > to). */
export function inWindow(at: number, w: HourWindow): boolean {
  const h = hourOf(at)
  const to = w.to % 24
  return w.from < to ? h >= w.from && h < to : h >= w.from || h < to
}

/** The next moment at or after `at` when the window opens (`at` itself when already inside). */
export function windowStart(at: number, w: HourWindow): number {
  if (inWindow(at, w)) return at
  const today = dayStart(at) + w.from * HOUR
  return today > at ? today : today + DAY
}

/** When the window that contains `at` closes. */
export function windowEnd(at: number, w: HourWindow): number {
  const to = w.to % 24
  const today = dayStart(at) + to * HOUR
  return today > at ? today : today + DAY
}

export type Gate = { open: true } | { open: false; kind: 'wait'; reason: string; until: number } | { open: false; kind: 'complete'; reason: string }

/** Whether the bot may trade now, and if not, why and until when (or that its run is over). */
export function scheduleGate(now: number, s: ScheduleConfig, run: RunProgress): Gate {
  if (s.maxRuntimeSec !== null && now - run.startedAt >= s.maxRuntimeSec * 1000) return { open: false, kind: 'complete', reason: `Ran for its set runtime` }
  if (s.maxTrades !== null && run.trades >= s.maxTrades) return { open: false, kind: 'complete', reason: `Made its ${s.maxTrades} trades` }
  if (s.activeHours !== null && !inWindow(now, s.activeHours))
    return { open: false, kind: 'wait', reason: `Outside its trading hours (${label(s.activeHours)})`, until: windowStart(now, s.activeHours) }
  const pause = s.pauseWindows.find((w) => inWindow(now, w))
  if (pause) return { open: false, kind: 'wait', reason: `In a pause window (${label(pause)})`, until: windowEnd(now, pause) }
  if (run.lastTradeAt !== null && now - run.lastTradeAt < s.cooldownSec * 1000)
    return { open: false, kind: 'wait', reason: 'Cooling down after its last trade', until: run.lastTradeAt + s.cooldownSec * 1000 }
  if (run.inFlight >= s.maxConcurrent) return { open: false, kind: 'wait', reason: 'A trade is in flight', until: now + 5_000 }
  return { open: true }
}

/** The next evaluation: between the shortest and the longest interval, drawn with `random` (0 ≤ r < 1). */
export function nextEvaluationAt(now: number, s: ScheduleConfig, random: () => number): number {
  const span = Math.max(0, s.maxIntervalSec - s.minIntervalSec)
  return now + Math.round((s.minIntervalSec + random() * span) * 1000)
}
