import { describe, expect, it } from 'vitest'
import { fitFigure } from './fitFigure'

describe('fitFigure', () => {
  it('sizes a figure by its length: each digit takes 0.6em of the box', () => {
    expect(fitFigure(10)).toBe('clamp(1.125rem, calc((100cqi - 1.75rem) / 6.0), 2rem)')
    expect(fitFigure(12)).toBe('clamp(1.125rem, calc((100cqi - 1.75rem) / 7.2), 2rem)')
  })
  it('never sizes for fewer than four digits, so an empty field and "0.00" read the same', () => {
    expect(fitFigure(0)).toBe(fitFigure(4))
    expect(fitFigure(4)).toBe('clamp(1.125rem, calc((100cqi - 1.75rem) / 2.4), 2rem)')
  })
})
