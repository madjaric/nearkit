import { describe, expect, it } from 'vitest'
import { MINUS, formatAccount, formatAmount, formatClock, formatCompact, formatDateTime, formatDuration, formatPct, formatPrice, formatUsd, parseAmount, floorTo } from './format'

describe('formatPrice', () => {
  it('follows magnitude', () => {
    expect(formatPrice(2.8412)).toBe('2.84')
    expect(formatPrice(1204.18)).toBe('1,204.18')
    expect(formatPrice(0.010462)).toBe('0.0105')
    expect(formatPrice(0.00000788)).toBe('0.00000788')
    expect(formatPrice(0.000538)).toBe('0.000538')
  })
  it('compresses long zero runs', () => {
    expect(formatPrice(0.0000000001234)).toBe('0.0₉123')
    expect(formatPrice(0.000001)).toBe('0.00000100')
  })
  it('carries when rounding reaches the next decade', () => {
    expect(formatPrice(0.000009996)).toBe('0.0000100')
  })
})

describe('signed figures', () => {
  it('uses a true minus sign', () => {
    expect(formatUsd(-312.4)).toBe(`${MINUS}$312.40`)
    expect(formatUsd(1204.18, { signed: true })).toBe('+$1,204.18')
    expect(formatPct(-14.4412)).toBe(`${MINUS}14.44%`)
    expect(formatPct(2.56)).toBe('+2.56%')
    expect(formatPct(0)).toBe('0.00%')
  })
})

describe('formatAmount', () => {
  it('drops decimals on large balances and keeps them on small ones', () => {
    expect(formatAmount(184_203_110.4)).toBe('184,203,110')
    expect(formatAmount(1208.4, 2)).toBe('1,208.40')
    expect(formatAmount(0.125)).toBe('0.125')
  })
})

describe('formatCompact', () => {
  it('abbreviates', () => {
    expect(formatCompact(1_250_000)).toBe('1.3M')
    expect(formatCompact(420_690_000_000)).toBe('420.7B')
  })
})

describe('formatAccount', () => {
  it('shortens implicit accounts only', () => {
    expect(formatAccount('demo-trader.near')).toBe('demo-trader.near')
    expect(formatAccount('8f3a0c'.padEnd(60, '0') + 'd21e')).toBe('8f3a0c…d21e')
  })
})

describe('formatDuration', () => {
  it('prints compact spans', () => {
    expect(formatDuration(4 * 3_600_000)).toBe('4h')
    expect(formatDuration(26 * 3_600_000)).toBe('1d 2h')
    expect(formatDuration(90_000)).toBe('2m')
  })
  it('never prints 60m or 24h remainders', () => {
    expect(formatDuration(3 * 3_600_000 + 59.7 * 60_000)).toBe('4h')
    expect(formatDuration(2 * 86_400_000 + 23.6 * 3_600_000)).toBe('3d')
    expect(formatDuration(23 * 3_600_000 + 59.8 * 60_000)).toBe('1d')
  })
})

describe('clock times', () => {
  // Local-time dates, so the expectation holds in any time zone the tests run in.
  it('prints the hour after midnight as 00, never 24', () => {
    expect(formatDateTime(new Date(2026, 9, 2, 0, 5).getTime())).toBe('Oct 2, 00:05')
    expect(formatDateTime(new Date(2026, 9, 2, 15, 39).getTime())).toBe('Oct 2, 15:39')
  })
  it('prints the time of day alone for an axis within one day', () => {
    expect(formatClock(new Date(2026, 9, 2, 0, 5).getTime())).toBe('00:05')
    expect(formatClock(new Date(2026, 9, 2, 15, 39).getTime())).toBe('15:39')
  })
})

describe('parseAmount', () => {
  it('accepts plain and grouped input', () => {
    expect(parseAmount('10')).toBe(10)
    expect(parseAmount('1 000.5')).toBe(1000.5)
    expect(parseAmount('1_000')).toBe(1000)
    expect(parseAmount('.5')).toBe(0.5)
  })
  it('rejects anything else', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('1,000')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('.')).toBeNull()
  })
  it('floors MAX amounts so they never exceed a balance', () => {
    expect(floorTo(1.23456789, 4)).toBe(1.2345)
  })
})
