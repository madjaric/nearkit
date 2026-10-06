import { describe, expect, it } from 'vitest'
import { HIGH_SLIPPAGE } from '@/lib/fees'
import { readPrefill } from './swapPrefill'

const read = (query: string) => readPrefill(new URLSearchParams(query))

describe('a swap link’s prefill', () => {
  it('never sets a high slippage: anyone can make the link, so above HIGH_SLIPPAGE it is the user’s to set on the form', () => {
    expect(HIGH_SLIPPAGE).toBe(5)
    for (const s of ['50', '49.9', '10', '5.01']) expect(read(`slippage=${s}`), s).not.toHaveProperty('slippage')
    expect(read('slippage=5').slippage).toBe(5)
    expect(read('slippage=0.5').slippage).toBe(0.5)
  })

  it('takes only what the form would accept', () => {
    for (const s of ['0', '-1', 'abc', '', 'Infinity']) expect(read(`slippage=${s}`), s).not.toHaveProperty('slippage')
    expect(read('amount=1.5').amount).toBe('1.5')
    for (const a of ['1e3', '-1', '1.', '0x10', '1'.repeat(31)]) expect(read(`amount=${a}`), a).not.toHaveProperty('amount')
    expect(read('').handoff).toBeNull()
  })
})
