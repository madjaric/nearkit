import { describe, expect, it } from 'vitest'
import { parseBatchList } from '@/lib/batch'
import type { Wallet } from '@/types/domain'
import { batchLines, manualList, SELF_RECIPIENT } from './manualRows'

/**
 * Batch Send, Manual: one source (Send from) and one token for every line; each row picks its
 * recipient like Split does (one of the user's wallets, or an external account) and an amount.
 */

const wallet = (id: string, accountId: string, extra: Partial<Wallet> = {}): Wallet => ({
  id,
  label: id,
  accountId,
  kind: 'named',
  isMain: false,
  access: 'signer',
  source: 'nearkit',
  ...extra,
})
const MAIN = wallet('main', 'a'.repeat(64), { label: 'Main' })
const DEGEN = wallet('degen', 'b'.repeat(64), { label: 'Degen 1' })
const SNIPER = wallet('sniper', 'c'.repeat(64), { label: 'Sniper A' })
const WALLETS = [MAIN, DEGEN, SNIPER]

describe('the lines Manual rows make', () => {
  it('an internal wallet sends to its account, an external .near or 64-character account to itself, each row to its own recipient', () => {
    const rows = [
      { id: 1, kind: 'wallet' as const, walletId: 'degen', amount: '100' },
      { id: 2, kind: 'account' as const, accountId: 'bob.near', amount: '50' },
      { id: 3, kind: 'wallet' as const, walletId: 'sniper', amount: '25' },
      { id: 4, kind: 'account' as const, accountId: 'd'.repeat(64), amount: '5' },
    ]
    expect(manualList(rows, WALLETS)).toBe([`${DEGEN.accountId},100`, 'bob.near,50', `${SNIPER.accountId},25`, `${'d'.repeat(64)},5`].join('\n'))
    const parsed = parseBatchList(manualList(rows, WALLETS), { decimals: 24 })
    expect(parsed.valid.map((r) => r.account)).toEqual([DEGEN.accountId, 'bob.near', SNIPER.accountId, 'd'.repeat(64)])
    expect(parsed.totalText).toBe('180')
  })

  it('an empty row is skipped but keeps its line number, so line N is row N', () => {
    const rows = [
      { id: 1, kind: 'account' as const, accountId: '', amount: '' },
      { id: 2, kind: 'account' as const, accountId: 'bob.near', amount: '1' },
    ]
    expect(manualList(rows, WALLETS)).toBe('#\nbob.near,1')
    expect(parseBatchList(manualList(rows, WALLETS)).valid.map((r) => r.line)).toEqual([2])
  })

  it('recipients are validated as before: a malformed account or amount is refused with its reason', () => {
    const rows = [
      { id: 1, kind: 'account' as const, accountId: 'Bob.near', amount: '1' },
      { id: 2, kind: 'account' as const, accountId: 'bob.near', amount: '0' },
      { id: 3, kind: 'wallet' as const, walletId: 'degen', amount: '' },
    ]
    const parsed = parseBatchList(manualList(rows, WALLETS))
    expect(parsed.rows.map((r) => r.status)).toEqual(['invalid-account', 'invalid-amount', 'invalid-amount'])
    expect(parsed.valid).toEqual([])
  })
})

describe('one source for the whole batch', () => {
  it('the source wallet can’t be a recipient (Split’s rule): chosen before Send from moved to it, or typed', () => {
    const rows = [
      { id: 1, kind: 'wallet' as const, walletId: 'main', amount: '1' },
      { id: 2, kind: 'account' as const, accountId: MAIN.accountId, amount: '1' },
      { id: 3, kind: 'wallet' as const, walletId: 'degen', amount: '1' },
    ]
    const parsed = parseBatchList(manualList(rows, WALLETS), { refuse: { account: MAIN.accountId, message: SELF_RECIPIENT } })
    expect(parsed.rows.map((r) => [r.status, r.message])).toEqual([
      ['invalid-account', SELF_RECIPIENT],
      ['invalid-account', SELF_RECIPIENT],
      ['ok', null],
    ])
  })

  it('every line is sent from Send from: no line names a wallet of its own', () => {
    const parsed = parseBatchList(`bob.near,1\n${DEGEN.accountId},2.5`, { decimals: 24 })
    expect(batchLines(parsed.valid)).toEqual([
      { to: 'bob.near', amount: '1' },
      { to: DEGEN.accountId, amount: '2.5' },
    ])
  })
})
