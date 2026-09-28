import { describe, expect, it } from 'vitest'
import { BATCH_EXAMPLE, parseBatchList } from './batch'

describe('parseBatchList', () => {
  it('parses the documented example', () => {
    const result = parseBatchList(BATCH_EXAMPLE)
    expect(result.rows.map((r) => [r.account, r.amount, r.status])).toEqual([
      ['alice.near', 100, 'ok'],
      ['bob.near', 250, 'ok'],
      ['charlie.near', 500, 'ok'],
    ])
    expect(result.total).toBe(850)
    expect(result.invalidCount).toBe(0)
  })

  it('accepts tabs, semicolons, spaces and padded commas', () => {
    const result = parseBatchList('a.near\t1\nb.near; 2\nc.near 3\nd.near , 4.5')
    expect(result.valid.map((r) => r.amount)).toEqual([1, 2, 3, 4.5])
  })

  it('skips blank lines, comments and a header row', () => {
    const result = parseBatchList('account,amount\n\n# payroll\n// note\nalice.near,1')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.line).toBe(5)
  })

  it('never mistakes a real first recipient for a header row', () => {
    for (const first of ['to.near,100', 'wallet-1.near,5', 'account.near,2', 'recipient.testnet 7']) {
      const result = parseBatchList([first, 'bob.near,1'].join('\n'))
      expect(result.valid).toHaveLength(2)
    }
    expect(parseBatchList(['Recipient;Amount', 'bob.near,1'].join('\n')).valid).toHaveLength(1)
  })

  it('flags invalid accounts and amounts with reasons', () => {
    const result = parseBatchList('Alice.near,10\nbob.near,-4\ncarl.near\ndan.near,abc\neve..near,1')
    expect(result.rows.map((r) => r.status)).toEqual(['invalid-account', 'invalid-amount', 'invalid-amount', 'invalid-amount', 'invalid-account'])
    expect(result.rows[0]?.message).toBe('Account IDs are lowercase')
    expect(result.rows[2]?.message).toBe('Missing amount')
    expect(result.invalidCount).toBe(5)
    expect(result.total).toBe(0)
  })

  it('refuses thousands separators instead of guessing', () => {
    const [row] = parseBatchList('alice.near,1,000').rows
    expect(row?.status).toBe('invalid-amount')
    expect(row?.message).toContain('thousands separators')
  })

  it('skips duplicate recipients and points at the first line', () => {
    const result = parseBatchList('alice.near,1\nbob.near,2\nalice.near,3')
    expect(result.rows[2]?.status).toBe('duplicate')
    expect(result.rows[2]?.message).toBe('Duplicate of line 1, skipped')
    expect(result.total).toBe(3)
    expect(result.duplicateCount).toBe(1)
  })

  it('accepts implicit and eth-implicit accounts', () => {
    const hex = 'a'.repeat(64)
    const eth = `0x${'b'.repeat(40)}`
    const result = parseBatchList(`${hex},1\n${eth},2`)
    expect(result.valid).toHaveLength(2)
  })
})

describe('parseBatchList with token decimals', () => {
  it('keeps each amount exactly as written and totals in raw units', () => {
    const r = parseBatchList('alice.near,0.1\nbob.near,0.2\ncarol.near,1234567.123456789012345678', { decimals: 18 })
    expect(r.valid.map((v) => v.amountText)).toEqual(['0.1', '0.2', '1234567.123456789012345678'])
    expect(r.totalRaw).toBe(1234567423456789012345678n)
    expect(r.totalText).toBe('1234567.423456789012345678')
  })

  it('rejects a line with more decimals than the token supports instead of rounding', () => {
    const r = parseBatchList('alice.near,1.1234567\nbob.near,2', { decimals: 6 })
    expect(r.rows[0]).toMatchObject({ status: 'invalid-amount', message: 'This token supports at most 6 decimals' })
    expect(r.valid).toHaveLength(1)
    expect(r.totalText).toBe('2')
  })

  it('leaves raw totals empty when decimals are unknown', () => {
    const r = parseBatchList('alice.near,1')
    expect(r.totalRaw).toBeNull()
    expect(r.valid[0]?.amountText).toBe('1')
  })
})
