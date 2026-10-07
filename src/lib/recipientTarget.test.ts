import { describe, expect, it } from 'vitest'
import type { Wallet } from '@/types/domain'
import { choiceOf, EXTERNAL_RECIPIENT, nextTarget, recipientAccount, takenBy, targetOf } from './recipientTarget'

/**
 * The recipient picker of Split and Batch Send (one component, RecipientSelect): a row sends to one
 * of the user's wallets, or to an account typed after "External account…".
 */

const wallet = (id: string, accountId: string): Wallet => ({ id, label: id, accountId, kind: 'named', isMain: false, access: 'signer', source: 'nearkit' })
const MAIN = wallet('main', 'a'.repeat(64))
const DEGEN = wallet('degen', 'b'.repeat(64))
const WALLETS = [MAIN, DEGEN]

describe('a recipient row’s target', () => {
  it('an internal wallet sends to that wallet’s account; an external account to what was typed, trimmed', () => {
    expect(recipientAccount({ kind: 'wallet', walletId: 'degen' }, WALLETS)).toBe(DEGEN.accountId)
    expect(recipientAccount({ kind: 'account', accountId: '  bob.near ' }, WALLETS)).toBe('bob.near')
    expect(recipientAccount({ kind: 'account', accountId: 'c'.repeat(64) }, WALLETS)).toBe('c'.repeat(64))
    // A wallet that is gone sends nowhere (the row then fails validation).
    expect(recipientAccount({ kind: 'wallet', walletId: 'gone' }, WALLETS)).toBe('')
  })

  it('the picker’s value: the wallet, or "External account…" for a typed account; choosing it starts an empty account', () => {
    expect(choiceOf({ kind: 'wallet', walletId: 'degen' })).toBe('degen')
    expect(choiceOf({ kind: 'account', accountId: 'bob.near' })).toBe(EXTERNAL_RECIPIENT)
    expect(targetOf('degen')).toEqual({ kind: 'wallet', walletId: 'degen' })
    expect(targetOf(EXTERNAL_RECIPIENT)).toEqual({ kind: 'account', accountId: '' })
  })

  it('never offers the source wallet, nor a wallet another row already sends to; a row keeps its own', () => {
    const rows = [
      { id: 1, kind: 'wallet' as const, walletId: 'degen' },
      { id: 2, kind: 'account' as const, accountId: 'bob.near' },
      { id: 3, kind: 'wallet' as const, walletId: 'sniper' },
    ]
    expect(takenBy('main', rows, 1)).toEqual(['main', 'sniper'])
    expect(takenBy('main', rows, 2)).toEqual(['main', 'degen', 'sniper'])
  })

  it('a new row starts with the first wallet that is neither the source nor another row’s; with none left, External account', () => {
    const SNIPER = wallet('sniper', 'c'.repeat(64))
    const all = [MAIN, DEGEN, SNIPER]
    expect(nextTarget('main', [], all)).toEqual({ kind: 'wallet', walletId: 'degen' })
    expect(
      nextTarget(
        'main',
        [
          { kind: 'wallet', walletId: 'degen' },
          { kind: 'account', accountId: 'bob.near' },
        ],
        all,
      ),
    ).toEqual({ kind: 'wallet', walletId: 'sniper' })
    expect(
      nextTarget(
        'main',
        [
          { kind: 'wallet', walletId: 'degen' },
          { kind: 'wallet', walletId: 'sniper' },
        ],
        all,
      ),
    ).toEqual({ kind: 'account', accountId: '' })
  })
})
