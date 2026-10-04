import { describe, expect, it } from 'vitest'
import { checkOwnerAccount, isEvmAddress, ownerAccountProblem, walletAccounts } from './ownerAccount'

const OWNER = 'bottest.near'
/** A NearKit wallet's own account: 64 hex characters, a NEAR implicit account (not an EVM address). */
const IMPLICIT = 'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672'
/** An EVM address as wallets show it (checksummed, mixed case). */
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'
/** The same kind of address in NEAR's ETH-implicit form (lowercase): still an EVM address. */
const EVM_LOWER = `0x${'ab'.repeat(20)}`

describe('the NEAR account a wallet is on', () => {
  it('an EVM address (0x + 40 hex, any case) is never a NEAR account; a 64-character hex id is a NEAR implicit account', () => {
    expect(isEvmAddress(EVM)).toBe(true)
    expect(isEvmAddress(EVM_LOWER)).toBe(true)
    expect(isEvmAddress(IMPLICIT)).toBe(false)
    expect(isEvmAddress(OWNER)).toBe(false)
    expect(walletAccounts([EVM, IMPLICIT, EVM_LOWER, OWNER, 'Not An Account', IMPLICIT])).toEqual({ near: [IMPLICIT, OWNER], evm: [EVM, EVM_LOWER] })
  })

  it('is the owner only when the active NEAR account (the first one the wallet lists) is exactly the owner', () => {
    expect(checkOwnerAccount([OWNER], OWNER)).toEqual({ ok: true, account: OWNER })
    // EVM values are skipped: never matched, never taken for the account.
    expect(checkOwnerAccount([EVM, OWNER], OWNER)).toEqual({ ok: true, account: OWNER })
    // Another NEAR account is active: the owner further down the list doesn't count.
    expect(checkOwnerAccount([IMPLICIT, OWNER], OWNER)).toEqual({ ok: false, reason: 'other-account', account: IMPLICIT })
    expect(checkOwnerAccount([IMPLICIT], OWNER)).toEqual({ ok: false, reason: 'other-account', account: IMPLICIT })
    // Exact: no case folding, no trimming (neither is a NEAR account id).
    expect(checkOwnerAccount(['BotTest.near'], OWNER)).toEqual({ ok: false, reason: 'none' })
    expect(checkOwnerAccount([` ${OWNER}`], OWNER)).toEqual({ ok: false, reason: 'none' })
    expect(checkOwnerAccount([EVM], OWNER)).toEqual({ ok: false, reason: 'evm-only', evm: EVM })
    expect(checkOwnerAccount([], OWNER)).toEqual({ ok: false, reason: 'none' })
  })

  it('says which account the wallet returned and to switch to the owner in the wallet; an EVM address is named as one', () => {
    expect(ownerAccountProblem({ ok: false, reason: 'other-account', account: IMPLICIT }, OWNER)).toBe(
      `Your wallet returned ${IMPLICIT}, not ${OWNER}. Switch to ${OWNER} in your wallet, then try again.`,
    )
    expect(ownerAccountProblem({ ok: false, reason: 'evm-only', evm: EVM }, OWNER)).toBe(
      `Your wallet returned an EVM address (${EVM}), not a NEAR account. Switch to the NEAR account ${OWNER} in your wallet, then try again.`,
    )
    expect(ownerAccountProblem({ ok: false, reason: 'none' }, OWNER)).toBe(`No NEAR account is connected. Connect ${OWNER}, the wallet this NearKit wallet was created with.`)
  })
})
