import { describe, expect, it } from 'vitest'
import {
  AmountError,
  formatUnits,
  formatUnitsUp,
  fractionOf,
  fromYocto,
  groupDigits,
  mulBps,
  parsePercent,
  parseUnits,
  PERCENT_SCALE,
  splitByWeights,
  splitEqual,
  toYocto,
  tryParseUnits,
  U128_MAX,
} from './amounts'

const YOCTO = 10n ** 24n

describe('parseUnits: exact human → raw', () => {
  it('converts whole and fractional amounts exactly', () => {
    expect(parseUnits('0', 24)).toBe(0n)
    expect(parseUnits('1', 24)).toBe(YOCTO)
    expect(parseUnits('1.5', 6)).toBe(1_500_000n)
    expect(parseUnits('0.000001', 6)).toBe(1n)
    expect(parseUnits('00012.340', 3)).toBe(12_340n)
    expect(parseUnits('1.', 2)).toBe(100n)
    expect(parseUnits('.5', 1)).toBe(5n)
    expect(parseUnits(' 2 ', 6)).toBe(2_000_000n)
  })

  it('keeps precision a float would lose (18 and 24 decimals)', () => {
    expect(parseUnits('1234567.123456789012345678', 18)).toBe(1234567123456789012345678n)
    expect(parseUnits('0.000000000000000000000001', 24)).toBe(1n)
    expect(parseUnits('98765432.109876543210987654321', 21)).toBe(98765432109876543210987654321n)
  })

  it('never rounds: more decimals than the token supports is an error', () => {
    expect(() => parseUnits('0.0000001', 6)).toThrowError(AmountError)
    expect(() => parseUnits('1.0000000000000000000000001', 24)).toThrowError(/at most 24 decimals/)
    expect(() => parseUnits('1.5', 0)).toThrowError(/whole numbers/)
    expect(parseUnits('1.500000', 6)).toBe(1_500_000n)
  })

  it('rejects anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', '   ', '-1', '+1', '1e3', '1,000', '1 000', '1.2.3', 'Infinity', 'NaN', '0x10', '.', '١٢']) {
      const r = tryParseUnits(bad, 6)
      expect(r.ok, bad).toBe(false)
    }
    expect(tryParseUnits('', 6)).toMatchObject({ ok: false, error: { code: 'empty' } })
    expect(tryParseUnits('-1', 6)).toMatchObject({ ok: false, error: { code: 'format' } })
  })

  it('caps at U128', () => {
    expect(parseUnits(U128_MAX.toString(), 0)).toBe(U128_MAX)
    expect(() => parseUnits((U128_MAX + 1n).toString(), 0)).toThrowError(/too large/)
    expect(() => parseUnits('340282366920938463463374607431768211455', 1)).toThrowError(/too large/)
  })

  it('refuses invalid decimals', () => {
    expect(() => parseUnits('1', -1)).toThrow()
    expect(() => parseUnits('1', 1.5)).toThrow()
    expect(() => parseUnits('1', 256)).toThrow()
  })
})

describe('formatUnits: exact raw → human', () => {
  it('prints exact values with trailing zeros trimmed', () => {
    expect(formatUnits(YOCTO, 24)).toBe('1')
    expect(formatUnits(1n, 24)).toBe('0.000000000000000000000001')
    expect(formatUnits(1_500_000n, 6)).toBe('1.5')
    expect(formatUnits(0n, 6)).toBe('0')
    expect(formatUnits(123n, 0)).toBe('123')
    expect(formatUnits(-1_500_000n, 6)).toBe('-1.5')
  })

  it('truncates toward zero when shortening, never rounding up', () => {
    expect(formatUnits(1_999_999n, 6, { maxFraction: 2 })).toBe('1.99')
    expect(formatUnits(999_999n, 6, { maxFraction: 0 })).toBe('0')
    expect(formatUnits(1_999_999_999_999_999_999_999_999n, 24, { maxFraction: 4 })).toBe('1.9999')
  })

  it('pads to a minimum and groups thousands on request', () => {
    expect(formatUnits(1_000_000n, 6, { minFraction: 2 })).toBe('1.00')
    expect(formatUnits(1_234_567_890_000n, 6, { group: true })).toBe('1,234,567.89')
    expect(formatUnits(12n, 0, { group: true })).toBe('12')
  })

  it('round-trips exactly for every decimals setting', () => {
    const raws = [0n, 1n, 9n, 10n, 123_456_789n, YOCTO - 1n, YOCTO, U128_MAX]
    for (const d of [0, 1, 6, 8, 18, 24, 30]) {
      for (const raw of raws) expect(parseUnits(formatUnits(raw, d), d)).toBe(raw)
    }
  })
})

describe('yoctoNEAR helpers', () => {
  it('converts NEAR with 24 decimals', () => {
    expect(toYocto('1')).toBe(YOCTO)
    expect(toYocto('0.00125')).toBe(1_250_000_000_000_000_000_000n)
    expect(fromYocto(1_250_000_000_000_000_000_000n)).toBe('0.00125')
    expect(fromYocto(12_345_678_900_000_000_000_000_000n, { maxFraction: 2, group: true })).toBe('12.34')
  })
})

describe('mulBps: fee math on raw amounts', () => {
  it('floors the result so a fee is never rounded up', () => {
    expect(mulBps(10n * YOCTO, 10)).toBe(10n ** 22n) // 0.10% of 10 NEAR = 0.01 NEAR
    expect(mulBps(1_999n, 10)).toBe(1n) // 1.999 → 1
    expect(mulBps(999n, 10)).toBe(0n)
    expect(mulBps(0n, 200)).toBe(0n)
    expect(mulBps(U128_MAX, 10_000)).toBe(U128_MAX)
  })

  it('accepts only integer basis points from 0 to 10000', () => {
    expect(() => mulBps(1n, -1)).toThrow()
    expect(() => mulBps(1n, 10_001)).toThrow()
    expect(() => mulBps(1n, 2.5)).toThrow()
    expect(() => mulBps(-1n, 200)).toThrow()
  })
})

describe('splits keep every raw unit', () => {
  it('splits equally with the remainder on the first parts', () => {
    expect(splitEqual(10n, 3)).toEqual([4n, 3n, 3n])
    expect(splitEqual(2n, 5)).toEqual([1n, 1n, 0n, 0n, 0n])
    expect(splitEqual(0n, 2)).toEqual([0n, 0n])
    expect(() => splitEqual(1n, 0)).toThrow()
  })

  it('splits by weight with the largest-remainder rule, ties to the lower index', () => {
    expect(splitByWeights(10n, [1n, 2n])).toEqual([3n, 7n])
    expect(splitByWeights(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n])
    expect(splitByWeights(1n, [1n, 1n])).toEqual([1n, 0n])
    expect(splitByWeights(7n, [0n, 1n])).toEqual([0n, 7n])
    expect(() => splitByWeights(1n, [0n, 0n])).toThrow()
    expect(() => splitByWeights(1n, [-1n, 2n])).toThrow()
    expect(() => splitByWeights(-1n, [1n])).toThrow()
  })

  it('reproduces the brief example exactly: 1,000,000 KIT at 25/25/20/15/15', () => {
    const total = parseUnits('1000000', 18)
    const weights = ['25', '25', '20', '15', '15'].map((p) => parsePercent(p))
    const parts = splitByWeights(total, weights)
    expect(parts.map((p) => formatUnits(p, 18))).toEqual(['250000', '250000', '200000', '150000', '150000'])
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(total)
  })

  it('never creates or destroys units on awkward splits', () => {
    const total = parseUnits('1', 6) // 1,000,000 raw units
    const parts = splitByWeights(
      total,
      ['33.3333', '33.3333', '33.3334'].map((p) => parsePercent(p)),
    )
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(total)
    expect(parts).toEqual([333_333n, 333_333n, 333_334n])
  })
})

describe('parsePercent', () => {
  it('reads percentages exactly with up to four decimals', () => {
    expect(PERCENT_SCALE).toBe(1_000_000n)
    expect(parsePercent('100')).toBe(PERCENT_SCALE)
    expect(parsePercent('25')).toBe(250_000n)
    expect(parsePercent('33.3333')).toBe(333_333n)
    expect(() => parsePercent('33.33333')).toThrow()
    expect(() => parsePercent('-5')).toThrow()
  })
})

describe('fractionOf: preset keys on exact balances', () => {
  it('floors a fraction of a raw amount', () => {
    expect(fractionOf(1001n, 1, 4)).toBe(250n)
    expect(fractionOf(1001n, 1, 2)).toBe(500n)
    expect(fractionOf(1001n, 3, 4)).toBe(750n)
    expect(fractionOf(1001n, 1, 1)).toBe(1001n)
    expect(fractionOf(U128_MAX, 1, 1)).toBe(U128_MAX)
    expect(() => fractionOf(1n, 2, 1)).toThrow()
    expect(() => fractionOf(1n, 1, 0)).toThrow()
  })
})

describe('groupDigits: display grouping of exact strings', () => {
  it('adds thousands separators to the whole part only', () => {
    expect(groupDigits('250000')).toBe('250,000')
    expect(groupDigits('1234567.123456789012345678')).toBe('1,234,567.123456789012345678')
    expect(groupDigits('0.000001')).toBe('0.000001')
    expect(groupDigits('-1500')).toBe('-1,500')
  })
})

describe('formatUnitsUp: requirements shown short, never understated', () => {
  it('rounds up to the shown precision, so a required amount is never displayed below the real one', () => {
    expect(formatUnitsUp(322900000000000000000001n, 24, 4)).toBe('0.323')
    expect(formatUnitsUp(322900000000000000000000n, 24, 4)).toBe('0.3229')
    expect(formatUnitsUp(1n, 24, 4)).toBe('0.0001')
    expect(formatUnitsUp(0n, 24, 4)).toBe('0')
  })
})
