import { describe, expect, it } from 'vitest'
import { amountState, amountsFromPercents, equalPercents, equalSplit, percentState, sumOf } from './allocation'

describe('equalSplit', () => {
  it('splits evenly when divisible', () => {
    expect(equalSplit(10, 5)).toEqual([2, 2, 2, 2, 2])
  })
  it('never loses a unit to rounding', () => {
    const parts = equalSplit(10, 3, 4)
    expect(parts).toEqual([3.3334, 3.3333, 3.3333])
    expect(sumOf(parts)).toBeCloseTo(10, 10)
  })
  it('returns zeros for empty totals', () => {
    expect(equalSplit(0, 3)).toEqual([0, 0, 0])
  })
})

describe('equalPercents', () => {
  it('sums to exactly 100', () => {
    expect(equalPercents(3)).toEqual([33.34, 33.33, 33.33])
    expect(sumOf(equalPercents(7))).toBeCloseTo(100, 10)
  })
})

describe('amountsFromPercents', () => {
  it('matches the split example from the brief', () => {
    expect(amountsFromPercents(1_000_000, [25, 25, 20, 15, 15])).toEqual([250_000, 250_000, 200_000, 150_000, 150_000])
  })
  it('lets the last part absorb rounding when balanced', () => {
    const parts = amountsFromPercents(100, [33.33, 33.33, 33.34], 2)
    expect(sumOf(parts)).toBeCloseTo(100, 10)
  })
  it('does not force the total when percentages are unbalanced', () => {
    const parts = amountsFromPercents(1000, [50, 30])
    expect(sumOf(parts)).toBe(800)
  })
})

describe('balance states', () => {
  it('classifies percentages', () => {
    expect(percentState([])).toBe('empty')
    expect(percentState([50, 50])).toBe('balanced')
    expect(percentState([50, 40])).toBe('under')
    expect(percentState([60, 50])).toBe('over')
    expect(percentState([60, Number.NaN])).toBe('invalid')
  })
  it('classifies amounts against a budget', () => {
    expect(amountState([2, 2, 2, 2, 2], 10)).toBe('balanced')
    expect(amountState([2, 2], 10)).toBe('under')
    expect(amountState([6, 6], 10)).toBe('over')
  })
})
