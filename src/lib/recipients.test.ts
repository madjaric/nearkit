import { describe, expect, it } from 'vitest'
import { parseRecipients } from './recipients'

describe('parseRecipients', () => {
  it('reads accounts with percentages', () => {
    const r = parseRecipients('alice.near, 40\nbob.near 60%')
    expect(r.valid.map((l) => [l.account, l.pct])).toEqual([
      ['alice.near', 40],
      ['bob.near', 60],
    ])
    expect(r.withPercents).toBe(true)
  })

  it('treats a bare account list as an equal split', () => {
    const r = parseRecipients('alice.near\n\n# team\nbob.near')
    expect(r.valid).toHaveLength(2)
    expect(r.withPercents).toBe(false)
  })

  it('flags bad accounts, bad percentages and duplicates with line numbers', () => {
    const r = parseRecipients('Alice.near,10\nbob.near,120\ncarol.near,10\ncarol.near,5')
    expect(r.lines.map((l) => [l.line, l.error])).toEqual([
      [1, 'Account IDs are lowercase'],
      [2, 'Percentage must be between 0 and 100'],
      [3, null],
      [4, 'Duplicate recipient'],
    ])
  })
})
