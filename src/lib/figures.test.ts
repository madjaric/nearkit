import { describe, expect, it } from 'vitest'
import { splitFigures } from './figures'

/** Figures in brackets, words bare: "[5] wallets · [10.00 NEAR] total". */
const mark = (text: string) =>
  splitFigures(text)
    .map((r) => (r.figure ? `[${r.text}]` : r.text))
    .join('')

describe('splitFigures', () => {
  it('sets counts and amounts with their unit apart from the words', () => {
    expect(mark('5 wallets · 10.00 NEAR total')).toBe('[5] wallets · [10.00 NEAR] total')
    expect(mark('400,000 KITS to 4 wallets')).toBe('[400,000 KITS] to [4] wallets')
    expect(mark('3 recipients · 850 SHITZU')).toBe('[3] recipients · [850 SHITZU]')
    expect(mark('5 of 12 selected')).toBe('[5] of [12] selected')
    expect(mark('1 limit · 1 TP · 1 SL')).toBe('[1] limit · [1] TP · [1] SL')
  })

  it('keeps sign, currency, magnitude and percent inside the figure', () => {
    expect(mark('≈ $32,632.40 · Main 8,420.55')).toBe('[≈ $32,632.40] · Main [8,420.55]')
    expect(mark('−$70.48 per day')).toBe('[−$70.48] per day')
    expect(mark('on $136.6K traded')).toBe('on [$136.6K] traded')
    expect(mark('+0.69% vs 24h ago')).toBe('[+0.69%] vs [24h] ago')
    expect(mark('≈ 1.76M BLACKDRAGON')).toBe('[≈ 1.76M BLACKDRAGON]')
  })

  it('treats durations, dates and times as figures', () => {
    expect(mark('updated 40d ago')).toBe('updated [40d] ago')
    expect(mark('in 2h 15m')).toBe('in [2h 15m]')
    expect(mark('since Sep 25, 11:59')).toBe('since [Sep 25, 11:59]')
    expect(mark('Sep 21')).toBe('[Sep 21]')
  })

  it('leaves digits inside words and ids alone', () => {
    expect(mark('1 main · 11 NEARKITS-managed')).toBe('[1] main · [11] NEARKITS-managed')
    expect(mark('w01 to 3fa9c2')).toBe('w01 to 3fa9c2')
    expect(mark('Split KITS across TRADING')).toBe('Split KITS across TRADING')
    expect(mark('')).toBe('')
  })

  it('does not swallow a trailing comma into a number', () => {
    expect(mark('1,000, then 20')).toBe('[1,000], then [20]')
  })
})
