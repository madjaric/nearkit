import { describe, expect, it } from 'vitest'
import { GAS } from './gas'
import { nearDepositAction, nearWithdrawAction, WRAP_NETWORK_FEE_YOCTO, wrapActions, wrapDirection } from './wrap'

/**
 * Wrapping and unwrapping NEAR, built once: the calls NEARKITS' server signs for a NEARKITS wallet
 * (custody/unwrap.ts, held to them by the signer's policy) and the browser signs for a connected one.
 */

const ONE = 10n ** 24n

describe('which pairs are wrapping, not a swap', () => {
  it('NEAR to the network’s wrap contract wraps, the wrap contract to NEAR unwraps; nothing else does', () => {
    expect(wrapDirection('near', 'wrap.near', 'wrap.near')).toBe('wrap')
    expect(wrapDirection('wrap.near', 'near', 'wrap.near')).toBe('unwrap')
    expect(wrapDirection('wrap.testnet', 'near', 'wrap.testnet')).toBe('unwrap')
    // Another network's wrap contract, a token, or the same token twice: not wrapping.
    expect(wrapDirection('wrap.near', 'near', 'wrap.testnet')).toBeNull()
    expect(wrapDirection('near', 'usdt.tether-token.near', 'wrap.near')).toBeNull()
    expect(wrapDirection('wrap.near', 'usdt.tether-token.near', 'wrap.near')).toBeNull()
    expect(wrapDirection('near', 'near', 'wrap.near')).toBeNull()
  })

  it('costs about 0.0005 NEAR of network fee, as the Telegram bot’s unwrap review says', () => {
    expect(WRAP_NETWORK_FEE_YOCTO).toBe(5n * 10n ** 20n)
  })
})

describe('unwrap: wNEAR back to NEAR', () => {
  it('is one near_withdraw of the exact amount, with the 1 yoctoNEAR the wrap contract requires and its gas', () => {
    expect(nearWithdrawAction(3n * ONE)).toEqual({
      kind: 'call',
      method: 'near_withdraw',
      args: { amount: (3n * ONE).toString() },
      gas: GAS.NEAR_WITHDRAW.toString(),
      deposit: '1',
    })
  })
})

describe('wrap: NEAR into wNEAR', () => {
  it('is a near_deposit carrying the amount, as the wrap step of every swap from NEAR signs it', () => {
    expect(nearDepositAction(2n * ONE)).toEqual({ kind: 'call', method: 'near_deposit', args: {}, gas: GAS.NEAR_DEPOSIT.toString(), deposit: (2n * ONE).toString() })
  })

  it('registers the account with the wrap contract first when it has no storage there, and only then', () => {
    const fresh = wrapActions('alice.near', ONE, 1_250_000_000_000_000_000_000n)
    expect(fresh.map((a) => (a.kind === 'call' ? a.method : a.kind))).toEqual(['storage_deposit', 'near_deposit'])
    expect(fresh[0]).toMatchObject({ args: { account_id: 'alice.near', registration_only: true }, deposit: '1250000000000000000000' })
    expect(wrapActions('alice.near', ONE, null)).toEqual([nearDepositAction(ONE)])
  })
})
