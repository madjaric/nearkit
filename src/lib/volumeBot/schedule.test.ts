import { describe, expect, it } from 'vitest'
import { defaultBotConfig } from './config'
import { inWindow, nextEvaluationAt, scheduleGate, windowEnd, windowStart } from './schedule'
import type { RunProgress, ScheduleConfig } from './types'

const H = 3_600_000
const DAY0 = Date.UTC(2026, 9, 6) // 2026-10-06 00:00 UTC
const at = (hour: number, min = 0) => DAY0 + hour * H + min * 60_000
const base = (): ScheduleConfig => defaultBotConfig('market-maker', { id: 't.near', symbol: 'T', decimals: 18 }, ['w1', 'w2']).schedule
const run = (patch: Partial<RunProgress> = {}): RunProgress => ({ startedAt: at(0), trades: 0, boughtNear: 0, soldTokens: 0, lastTradeAt: null, inFlight: 0, ...patch })

describe('UTC hour windows', () => {
  it('contain their start hour and not their end hour', () => {
    expect(inWindow(at(9), { from: 9, to: 17 })).toBe(true)
    expect(inWindow(at(16, 59), { from: 9, to: 17 })).toBe(true)
    expect(inWindow(at(17), { from: 9, to: 17 })).toBe(false)
  })

  it('span midnight when they start later than they end', () => {
    const night = { from: 22, to: 6 }
    expect(inWindow(at(23), night)).toBe(true)
    expect(inWindow(at(3), night)).toBe(true)
    expect(inWindow(at(12), night)).toBe(false)
    expect(windowStart(at(12), night)).toBe(at(22))
    expect(windowEnd(at(23), night)).toBe(at(24 + 6))
    expect(windowEnd(at(3), night)).toBe(at(6))
  })

  it('start next on the following day once today’s has passed', () => {
    expect(windowStart(at(18), { from: 9, to: 17 })).toBe(at(24 + 9))
  })
})

describe('the schedule gate', () => {
  it('opens when nothing holds the bot back', () => {
    expect(scheduleGate(at(1), base(), run())).toEqual({ open: true })
  })

  it('completes the run at its runtime or its trade count', () => {
    expect(scheduleGate(at(5), { ...base(), maxRuntimeSec: 4 * 3600 }, run())).toMatchObject({ open: false, kind: 'complete' })
    expect(scheduleGate(at(1), { ...base(), maxTrades: 3 }, run({ trades: 3 }))).toMatchObject({ open: false, kind: 'complete' })
    expect(scheduleGate(at(1), { ...base(), maxTrades: 3 }, run({ trades: 2 }))).toEqual({ open: true })
  })

  it('waits outside its active hours until they begin', () => {
    expect(scheduleGate(at(7), { ...base(), activeHours: { from: 9, to: 17 } }, run())).toEqual({
      open: false,
      kind: 'wait',
      reason: 'Outside its trading hours (09:00–17:00 UTC)',
      until: at(9),
    })
  })

  it('waits through a pause window until it ends', () => {
    expect(scheduleGate(at(12, 30), { ...base(), pauseWindows: [{ from: 12, to: 14 }] }, run())).toEqual({
      open: false,
      kind: 'wait',
      reason: 'In a pause window (12:00–14:00 UTC)',
      until: at(14),
    })
  })

  it('cools down after a trade', () => {
    const s = { ...base(), cooldownSec: 120 }
    expect(scheduleGate(at(1, 1), s, run({ lastTradeAt: at(1) }))).toEqual({ open: false, kind: 'wait', reason: 'Cooling down after its last trade', until: at(1, 2) })
    expect(scheduleGate(at(1, 2), s, run({ lastTradeAt: at(1) }))).toEqual({ open: true })
  })

  it('never puts more trades in flight than allowed', () => {
    expect(scheduleGate(at(1), { ...base(), maxConcurrent: 1 }, run({ inFlight: 1 }))).toMatchObject({ open: false, kind: 'wait', reason: 'A trade is in flight' })
    expect(scheduleGate(at(1), { ...base(), maxConcurrent: 2 }, run({ inFlight: 1 }))).toEqual({ open: true })
  })
})

describe('the next evaluation', () => {
  it('comes between the shortest and the longest interval', () => {
    const s = { ...base(), minIntervalSec: 30, maxIntervalSec: 90 }
    expect(nextEvaluationAt(at(1), s, () => 0)).toBe(at(1) + 30_000)
    expect(nextEvaluationAt(at(1), s, () => 0.5)).toBe(at(1) + 60_000)
    expect(nextEvaluationAt(at(1), s, () => 0.999999)).toBeLessThanOrEqual(at(1) + 90_000)
  })
})
