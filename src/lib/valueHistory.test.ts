import { describe, expect, it } from 'vitest'
import { recordValue, valueWindow, type ValueSample } from './valueHistory'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 1)

/** Samples as the dashboard records them, one call per summary read. */
function seen(reads: [at: number, value: number][]): ValueSample[] {
  return reads.reduce<ValueSample[]>((list, [at, value]) => recordValue(list, at, value), [])
}

describe('portfolio value history, as this browser saw it', () => {
  it('one sample per 5 minutes at most: reads in between keep the last sample', () => {
    const list = seen([
      [T0, 100],
      [T0 + MIN, 101],
      [T0 + 4 * MIN, 102],
      [T0 + 5 * MIN, 103],
    ])
    expect(list).toEqual([
      { t: T0, v: 100 },
      { t: T0 + 5 * MIN, v: 103 },
    ])
  })

  it('1D: every sample of the last 24 hours, and nothing invented for the time NearKit was closed', () => {
    const now = T0 + 3 * DAY
    const list = seen([
      [now - 30 * HOUR, 90],
      [now - 23 * HOUR, 95],
      [now - 22 * HOUR, 96],
      // Closed for 20 hours.
      [now - 2 * HOUR, 110],
      [now, 120],
    ])
    expect(valueWindow(list, now, 1)).toEqual([
      { t: now - 23 * HOUR, v: 95 },
      { t: now - 22 * HOUR, v: 96 },
      { t: now - 2 * HOUR, v: 110 },
      { t: now, v: 120 },
    ])
  })

  it('past the last day, one sample an hour (the last seen in it); nothing older than 31 days', () => {
    const now = T0 + 40 * DAY
    let list: ValueSample[] = []
    // Every 5 minutes for 3 hours, 5 days ago, then a read now.
    for (let i = 0; i < 36; i += 1) list = recordValue(list, now - 5 * DAY + i * 5 * MIN, 200 + i)
    list = recordValue(list, now - 35 * DAY + 0, 1)
    list = recordValue(list, now, 300)
    const old = list.filter((p) => p.t < now - DAY)
    expect(old.map((p) => p.v)).toEqual([211, 223, 235])
    expect(list.some((p) => p.v === 1)).toBe(false)
    expect(valueWindow(list, now, 7).map((p) => p.v)).toEqual([211, 223, 235, 300])
    expect(valueWindow(list, now, 30).length).toBe(4)
  })

  it('no reading, or one that isn’t a value, records nothing', () => {
    expect(recordValue([], T0, Number.NaN)).toEqual([])
    expect(recordValue([], T0, -1)).toEqual([])
    expect(valueWindow([], T0, 1)).toEqual([])
  })
})
