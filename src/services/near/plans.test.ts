import { describe, expect, it } from 'vitest'
import type { TokenRef } from '@/types/operations'
import {
  buildFtTransferTransactions,
  buildNearTransferTransactions,
  FT_RECIPIENTS_PER_TX,
  ftTransferAction,
  groupTransactions,
  MAX_TXS_PER_APPROVAL,
  storageDepositAction,
  toConnectorTransaction,
  txStorageYocto,
  txUpfrontYocto,
  type TransferLineInput,
} from './plans'
import { GAS } from './gas'

const USDC: TokenRef = { id: 'usdc.testnet', symbol: 'USDC', decimals: 6, contract: 'usdc.testnet' }
const MIN_STORAGE = 1_250_000_000_000_000_000_000n

const lines = (n: number, unregistered: (i: number) => boolean = () => false): TransferLineInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: `l${i}`, accountId: `r${i}.testnet`, raw: BigInt(i + 1) * 1_000_000n, storageDeposit: unregistered(i) ? MIN_STORAGE : null }))

describe('buildFtTransferTransactions', () => {
  it('sends ft_transfer with exactly 1 yocto and 10 TGas, amounts as U128 strings', () => {
    const [tx] = buildFtTransferTransactions('alice.testnet', USDC, lines(1))
    expect(tx).toMatchObject({ signerId: 'alice.testnet', receiverId: 'usdc.testnet', lineIds: ['l0'] })
    expect(tx?.actions).toEqual([{ kind: 'call', method: 'ft_transfer', args: { receiver_id: 'r0.testnet', amount: '1000000' }, gas: GAS.FT_TRANSFER.toString(), deposit: '1' }])
  })

  it('registers a recipient immediately before its transfer, in the same transaction', () => {
    const [tx] = buildFtTransferTransactions(
      'alice.testnet',
      USDC,
      lines(2, (i) => i === 1),
    )
    expect(tx?.actions.map((a) => (a.kind === 'call' ? a.method : a.kind))).toEqual(['ft_transfer', 'storage_deposit', 'ft_transfer'])
    expect(tx?.actions[1]).toEqual({
      kind: 'call',
      method: 'storage_deposit',
      args: { account_id: 'r1.testnet', registration_only: true },
      gas: GAS.STORAGE_DEPOSIT.toString(),
      deposit: MIN_STORAGE.toString(),
    })
    expect(tx?.deposit).toBe((MIN_STORAGE + 2n).toString())
  })

  it(`chunks at ${FT_RECIPIENTS_PER_TX} recipients per transaction and keeps every line exactly once`, () => {
    const txs = buildFtTransferTransactions(
      'alice.testnet',
      USDC,
      lines(45, (i) => i % 2 === 0),
    )
    expect(txs.map((t) => t.lineIds.length)).toEqual([20, 20, 5])
    expect(txs.flatMap((t) => t.lineIds)).toEqual(lines(45).map((l) => l.id))
    expect(txs.map((t) => t.index)).toEqual([0, 1, 2])
    for (const t of txs) {
      expect(t.actions.length).toBeLessThanOrEqual(40)
      expect(BigInt(t.gas)).toBeLessThanOrEqual(1000n * 10n ** 12n)
    }
    expect(txs[1]?.label).toBe('Transaction 2 of 3 · 20 recipients')
  })

  it('refuses a native NEAR token', () => {
    expect(() => buildFtTransferTransactions('alice.testnet', { id: 'near', symbol: 'NEAR', decimals: 24, contract: null }, lines(1))).toThrow()
  })
})

describe('buildNearTransferTransactions', () => {
  it('sends one Transfer transaction per recipient with the exact yocto amount', () => {
    const txs = buildNearTransferTransactions('alice.testnet', [
      { id: 'a', accountId: 'bob.testnet', raw: 10n ** 24n, storageDeposit: null },
      { id: 'b', accountId: 'f'.repeat(64), raw: 5n, storageDeposit: null },
    ])
    expect(txs).toHaveLength(2)
    expect(txs[0]).toMatchObject({ receiverId: 'bob.testnet', actions: [{ kind: 'transfer', deposit: '1000000000000000000000000' }], lineIds: ['a'] })
    expect(txs[1]).toMatchObject({ receiverId: 'f'.repeat(64), actions: [{ kind: 'transfer', deposit: '5' }] })
  })
})

describe('groupTransactions', () => {
  it(`groups at most ${MAX_TXS_PER_APPROVAL} per approval, per signer, in order`, () => {
    expect(
      groupTransactions(
        Array.from({ length: 23 }, (_, i) => ({ index: i, signerId: 'a' })),
        true,
      ),
    ).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
      [20, 21, 22],
    ])
    expect(
      groupTransactions(
        [
          { index: 0, signerId: 'a' },
          { index: 1, signerId: 'b' },
          { index: 2, signerId: 'b' },
        ],
        true,
      ),
    ).toEqual([[0], [1, 2]])
  })

  it('signs one at a time when the wallet cannot batch', () => {
    expect(
      groupTransactions(
        [
          { index: 0, signerId: 'a' },
          { index: 1, signerId: 'a' },
        ],
        false,
      ),
    ).toEqual([[0], [1]])
  })
})

describe('toConnectorTransaction', () => {
  it('maps planned actions to wallet actions without changing any value', () => {
    const [tx] = buildFtTransferTransactions(
      'alice.testnet',
      USDC,
      lines(1, () => true),
    )
    if (!tx) throw new Error('no tx')
    expect(toConnectorTransaction(tx)).toEqual({
      receiverId: 'usdc.testnet',
      actions: [
        {
          type: 'FunctionCall',
          params: { methodName: 'storage_deposit', args: { account_id: 'r0.testnet', registration_only: true }, gas: '10000000000000', deposit: MIN_STORAGE.toString() },
        },
        { type: 'FunctionCall', params: { methodName: 'ft_transfer', args: { receiver_id: 'r0.testnet', amount: '1000000' }, gas: '10000000000000', deposit: '1' } },
      ],
    })
    const [near] = buildNearTransferTransactions('alice.testnet', [{ id: 'x', accountId: 'bob.testnet', raw: 7n, storageDeposit: null }])
    if (!near) throw new Error('no tx')
    expect(toConnectorTransaction(near)).toEqual({ receiverId: 'bob.testnet', actions: [{ type: 'Transfer', params: { deposit: '7' } }] })
  })
})

describe('transaction costs', () => {
  it('counts registrations as storage and only gas plus 1-yocto deposits as upfront', () => {
    const tx = {
      gas: (10n * 10n ** 12n + 10n * 10n ** 12n + 30n * 10n ** 12n).toString(),
      actions: [
        storageDepositAction('bob.near', 1250n),
        { kind: 'call' as const, method: 'tokens_storage_deposit', args: {}, gas: (30n * 10n ** 12n).toString(), deposit: '5000' },
        ftTransferAction('bob.near', 7n),
      ],
    }
    expect(txStorageYocto(tx)).toBe(6250n)
    // 50 TGas attached + 3 × 0.8 + 0.5 TGas overhead, bought at 1e9 yocto/gas, plus the 1-yocto deposit.
    expect(txUpfrontYocto(tx)).toBe((50n * 10n ** 12n + 3n * 800_000_000_000n + 500_000_000_000n) * 10n ** 9n + 1n)
  })
})
