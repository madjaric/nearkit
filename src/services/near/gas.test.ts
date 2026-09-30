import { describe, expect, it } from 'vitest'
import type { PlannedAction } from '@/types/operations'
import { FEES, GAS_BUY_PRICE, gasCostBoundYocto, gasPurchaseYocto, MIN_GAS_PRICE, TGAS, txGas } from './gas'

const call = (method: string, args: Record<string, unknown>, gas: bigint, deposit = 0n): PlannedAction => ({
  kind: 'call',
  method,
  args,
  gas: gas.toString(),
  deposit: deposit.toString(),
})
const transfer = (deposit: bigint): PlannedAction => ({ kind: 'transfer', deposit: deposit.toString() })

/**
 * Real NearKit transactions on mainnet (2026-09-28, signer testone.near). `burnt` is the chain's
 * transaction_outcome.gas_burnt; `bought` is what it refunded plus what the receipts burnt, at
 * 1e9 yocto/gas (the refunds are exact: no penalty, the price difference comes back too).
 */
describe('gas of a transaction, exactly as mainnet charges it (nearcore tx_cost)', () => {
  it('USDT registration 27krNPk4…: 311,349,676,335 gas burnt, 10,888,213,779,446 bought', () => {
    const g = txGas({
      receiverId: 'usdt.tether-token.near',
      actions: [call('storage_deposit', { account_id: 'testone.near', registration_only: true }, 10n * TGAS, 1_250_000_000_000_000_000_000n)],
    })
    expect(g).toEqual({ burnt: 311_349_676_335n, bought: 10_888_213_779_446n })
  })

  it('Rhea registration 2Z83kFs5…: 518,931,387,020 gas burnt, 61,668,569,292,952 bought', () => {
    const g = txGas({
      receiverId: 'aggregatedex.near',
      actions: [
        call(
          'tokens_storage_deposit',
          { user: 'testone.near', tokens: ['wrap.near', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'usdt.tether-token.near'] },
          30n * TGAS,
          15_000_000_000_000_000_000_000n,
        ),
        call('tokens_storage_deposit', { user: 'testone.near', tokens: ['wrap.near'] }, 30n * TGAS, 5_000_000_000_000_000_000_000n),
      ],
    })
    expect(g).toEqual({ burnt: 518_931_387_020n, bought: 61_668_569_292_952n })
  })

  it('counts every byte of the method name and the args: a long swap msg costs more', () => {
    const short = txGas({ receiverId: 'wrap.near', actions: [call('ft_transfer_call', { msg: '' }, 300n * TGAS, 1n)] })
    const long = txGas({ receiverId: 'wrap.near', actions: [call('ft_transfer_call', { msg: 'x'.repeat(2000) }, 300n * TGAS, 1n)] })
    expect(long.burnt - short.burnt).toBe(2000n * FEES.functionCallByte.sendNotSir)
    expect(long.bought - short.bought).toBe(2000n * FEES.functionCallByte.exec)
  })

  it('a transfer to a named account; to an implicit account it also pays for creating the account and its key', () => {
    const named = txGas({ receiverId: 'bob.near', actions: [transfer(1n)] })
    expect(named).toEqual({ burnt: FEES.receipt.send + FEES.transfer.send, bought: FEES.receipt.exec + FEES.transfer.exec })
    const implicit = txGas({ receiverId: 'a'.repeat(64), actions: [transfer(1n)] })
    expect(implicit.bought - named.bought).toBe(FEES.createAccount.exec + FEES.addFullAccessKey.exec)
    expect(implicit.burnt - named.burnt).toBe(FEES.createAccount.send + FEES.addFullAccessKey.send)
    // Receiver unknown: priced as the dearer case.
    expect(txGas({ actions: [transfer(1n)] })).toEqual(implicit)
  })

  it('a NearKit wallet changing its own keys: a full-access AddKey, a DeleteKey', () => {
    const wallet = 'a'.repeat(64)
    expect(txGas({ receiverId: wallet, actions: [{ kind: 'add-key', publicKey: 'ed25519:x' }] })).toEqual({
      burnt: FEES.receipt.send + FEES.addFullAccessKey.send,
      bought: FEES.receipt.exec + FEES.addFullAccessKey.exec,
    })
    expect(txGas({ receiverId: wallet, actions: [{ kind: 'delete-key', publicKey: 'ed25519:x' }] })).toEqual({
      burnt: FEES.receipt.send + FEES.deleteKey.send,
      bought: FEES.receipt.exec + FEES.deleteKey.exec,
    })
  })
})

describe('what a transaction takes from the signer', () => {
  const swap = { receiverId: 'wrap.near', actions: [call('near_deposit', {}, 10n * TGAS, 5n), call('ft_transfer_call', { msg: 'x' }, 300n * TGAS, 1n)] }

  it('when accepted: all of its gas at the purchase floor (NEP-642), about 0.31 NEAR for a 310 TGas swap', () => {
    const g = txGas(swap)
    expect(gasPurchaseYocto(swap)).toBe((g.burnt + g.bought) * GAS_BUY_PRICE)
    expect(gasPurchaseYocto(swap)).toBeGreaterThan(311n * 10n ** 21n)
    expect(gasPurchaseYocto(swap)).toBeLessThan(313n * 10n ** 21n)
  })

  it('once its refunds land: at most every unit of that gas, burnt at twice the minimum gas price', () => {
    const g = txGas(swap)
    expect(gasCostBoundYocto(swap)).toBe((g.burnt + g.bought) * 2n * MIN_GAS_PRICE)
    // The real swap AChtju7f… cost 0.00803 NEAR; the bound is far above what swaps burn.
    expect(gasCostBoundYocto(swap)).toBeGreaterThan(8_031n * 10n ** 18n)
  })
})
