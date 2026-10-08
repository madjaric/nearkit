import { describe, expect, it } from 'vitest'
import type { PnlPoint } from '@/types/domain'
import { BUCKET_MS, bucketLabel, bucketWord, inPeriod, PNL_PERIODS, periodStart, pnlPoints, sumInPeriod } from './pnlPeriod'

/**
 * The PnL page's periods: 24H, 7D, 30D, 90D and All. A period decides which closed trades, volume
 * and gas count, and how the cumulative chart is cut: an hour per point over 24 hours, six hours
 * over a week, a day beyond. The line starts at 0 at the period's start: PnL booked in the period.
 */

const H = 3_600_000
const D = 24 * H
const NOW = Date.UTC(2026, 9, 8, 14, 37, 12)

describe('the periods', () => {
  it('are 24H, 7D, 30D, 90D and All, in that order', () => {
    expect(PNL_PERIODS.map((p) => p.label)).toEqual(['24H', '7D', '30D', '90D', 'All'])
  })

  it('24H is the last 24 hours to the millisecond; All is the whole history', () => {
    expect(periodStart('24h', NOW)).toBe(NOW - D)
    expect(inPeriod(NOW - D + 1, '24h', NOW)).toBe(true)
    expect(inPeriod(NOW - D - 1, '24h', NOW)).toBe(false)
    expect(inPeriod(NOW - 30 * D, '7d', NOW)).toBe(false)
    expect(inPeriod(0, 'all', NOW)).toBe(true)
    // A block stamped a moment ahead of this clock still counts.
    expect(inPeriod(NOW + 2_000, '24h', NOW)).toBe(true)
  })

  it('sums only what happened in the period', () => {
    const gas = [
      { at: NOW - 2 * H, value: 0.002 },
      { at: NOW - 3 * D, value: 0.01 },
      { at: NOW - 40 * D, value: 1 },
    ]
    expect(sumInPeriod(gas, '24h', NOW)).toBeCloseTo(0.002)
    expect(sumInPeriod(gas, '7d', NOW)).toBeCloseTo(0.012)
    expect(sumInPeriod(gas, 'all', NOW)).toBeCloseTo(1.012)
  })
})

describe('the cumulative chart’s points', () => {
  const events = [
    { at: NOW - 23 * H - 10 * 60_000, pnl: 5, volume: 100 },
    { at: NOW - 23 * H - 5 * 60_000, pnl: -2, volume: 40 },
    { at: NOW - 30 * 60_000, pnl: 1.5, volume: 20 },
    // Outside 24H, inside 7D.
    { at: NOW - 2 * D, pnl: 10, volume: 200 },
  ]

  it('24H: one point an hour from 24 hours ago to now, starting at 0, ending at the period’s total', () => {
    const pts = pnlPoints(events, '24h', NOW)
    expect(BUCKET_MS['24h']).toBe(H)
    expect(pts[0]).toEqual({ t: pts[0]?.t, end: pts[0]?.t, booked: 0, cumulative: 0, volumeUsd: 0 })
    expect(pts[0]?.t).toBe(Math.floor((NOW - D) / H) * H)
    expect(pts).toHaveLength(26)
    expect(pts.at(-1)?.end).toBe(NOW)
    expect(pts.at(-1)?.cumulative).toBeCloseTo(4.5)
    // Every point is an hour apart, and holds what was booked in its hour.
    const second = pts[1]
    expect(second?.end).toBe((second?.t ?? 0) + H)
    const booked = pts.filter((p) => p.booked !== 0).map((p) => p.booked)
    expect(booked).toEqual([3, 1.5])
  })

  it('7D: six hours a point, and the trade two days ago counts', () => {
    const pts = pnlPoints(events, '7d', NOW)
    expect(BUCKET_MS['7d']).toBe(6 * H)
    expect((pts[2]?.end ?? 0) - (pts[2]?.t ?? 0)).toBe(6 * H)
    expect(pts.at(-1)?.cumulative).toBeCloseTo(14.5)
    expect(pts.reduce((s, p) => s + p.volumeUsd, 0)).toBe(360)
  })

  it('All: a day a point from the first trade’s day', () => {
    const pts = pnlPoints(events, 'all', NOW)
    expect(pts[0]?.t).toBe(Math.floor((NOW - 2 * D) / D) * D)
    expect(pts.at(-1)?.cumulative).toBeCloseTo(14.5)
  })

  it('names each point the way a reader looks for it: the hour, the six hours, the day; the first as the start', () => {
    const [origin, hour] = pnlPoints(events, '24h', NOW)
    expect(bucketLabel(origin as PnlPoint, H)).toMatch(/^Start · /)
    expect(bucketLabel(hour as PnlPoint, H)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:00–\d{2}:00$/)
    const day = pnlPoints(events, '30d', NOW)[3] as PnlPoint
    expect(bucketLabel(day, D)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, 2026$/)
    expect([bucketWord(H), bucketWord(6 * H), bucketWord(D)]).toEqual(['hour', '6 h', 'day'])
  })

  it('a trade stamped a moment after now (the chain’s clock ahead of this one) lands in the last point, not nowhere', () => {
    const pts = pnlPoints([{ at: NOW + 2_000, pnl: 7, volume: 10 }], '24h', NOW)
    expect(pts.at(-1)).toMatchObject({ booked: 7, cumulative: 7 })
  })

  it('without a trade in the period the line stays at 0 from start to end (a zero state, not a broken chart)', () => {
    const pts = pnlPoints([{ at: NOW - 40 * D, pnl: 3, volume: 1 }], '30d', NOW)
    expect(pts.length).toBeGreaterThan(2)
    expect(pts.every((p) => p.cumulative === 0 && p.booked === 0)).toBe(true)
    const none = pnlPoints([], 'all', NOW)
    expect(none.length).toBeGreaterThanOrEqual(2)
    expect(none.every((p) => p.cumulative === 0)).toBe(true)
  })
})
