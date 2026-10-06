import { describe, expect, it } from 'vitest'
import type { PlannedAction } from '@/types/operations'
import { buildSwapTransactions, type SwapTxInput } from './swapTransactions'

const ONE = 10n ** 24n
const base: SwapTxInput = {
  signerId: 'alice.near',
  wrap: null,
  registrations: [],
  aggregatorDeposits: null,
  swap: { tokenContract: 'usdt.tether-token.near', receiverId: 'aggregatedex.near', amount: 5_000_000n, msg: '{"msg":"x","signature":"y"}' },
  label: 'Swap 5 USDt → NEAR',
}

const methods = (actions: PlannedAction[]) => actions.map((a) => (a.kind === 'call' ? a.method : 'Transfer'))

describe('buildSwapTransactions', () => {
  it('is a single ft_transfer_call with 300 TGas and 1 yocto when nothing needs setting up', () => {
    const txs = buildSwapTransactions(base)
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({ signerId: 'alice.near', receiverId: 'usdt.tether-token.near', label: 'Swap 5 USDt → NEAR' })
    expect(txs[0]?.actions).toEqual([
      {
        kind: 'call',
        method: 'ft_transfer_call',
        args: { receiver_id: 'aggregatedex.near', amount: '5000000', msg: '{"msg":"x","signature":"y"}' },
        gas: '300000000000000',
        deposit: '1',
      },
    ])
  })

  it('wraps NEAR in the same transaction as the swap, registering first if needed', () => {
    const txs = buildSwapTransactions({
      ...base,
      wrap: { contract: 'wrap.near', amount: 2n * ONE, registerDeposit: 1_250_000_000_000_000_000_000n },
      swap: { ...base.swap, tokenContract: 'wrap.near', amount: 2n * ONE },
    })
    expect(txs).toHaveLength(1)
    expect(txs[0]?.receiverId).toBe('wrap.near')
    expect(methods(txs[0]?.actions ?? [])).toEqual(['storage_deposit', 'near_deposit', 'ft_transfer_call'])
    expect(txs[0]?.actions[1]).toMatchObject({ method: 'near_deposit', deposit: (2n * ONE).toString() })
    expect(txs[0]?.deposit).toBe((2n * ONE + 1_250_000_000_000_000_000_000n + 1n).toString())
  })

  it('puts every registration before the swap, and aggregator registrations in one call per account', () => {
    const txs = buildSwapTransactions({
      ...base,
      registrations: [
        { contract: 'blackdragon.tkn.near', accountId: 'alice.near', deposit: 10n },
        { contract: 'blackdragon.tkn.near', accountId: 'aggregatedex.near', deposit: 10n },
        { contract: 'usdt.tether-token.near', accountId: 'aggregatedex.near', deposit: 7n },
      ],
      aggregatorDeposits: { contract: 'aggregatedex.near', entries: [{ user: 'alice.near', tokens: ['blackdragon.tkn.near'], deposit: 5n }] },
    })
    expect(txs.map((t) => t.receiverId)).toEqual(['blackdragon.tkn.near', 'aggregatedex.near', 'usdt.tether-token.near'])
    expect(methods(txs[0]?.actions ?? [])).toEqual(['storage_deposit', 'storage_deposit'])
    expect(txs[1]?.actions).toEqual([
      { kind: 'call', method: 'tokens_storage_deposit', args: { user: 'alice.near', tokens: ['blackdragon.tkn.near'] }, gas: '30000000000000', deposit: '5' },
    ])
    // The registration on the input token's own contract rides with the swap, before it.
    expect(methods(txs[2]?.actions ?? [])).toEqual(['storage_deposit', 'ft_transfer_call'])
  })

  it('a direct route pays the NEARKITS fee with one ft_transfer right before the swap, in the same transaction', () => {
    const txs = buildSwapTransactions({
      ...base,
      wrap: { contract: 'wrap.near', amount: 2n * ONE, registerDeposit: null },
      registrations: [{ contract: 'wrap.near', accountId: 'nearkitfee.near', deposit: 1_250_000_000_000_000_000_000n }],
      swap: { tokenContract: 'wrap.near', receiverId: 'dclv2.ref-labs.near', amount: 2n * ONE - 10n ** 22n, msg: '{"Swap":{}}' },
      feeTransfer: { recipient: 'nearkitfee.near', amount: 10n ** 22n },
    })
    expect(txs).toHaveLength(1)
    expect(methods(txs[0]?.actions ?? [])).toEqual(['storage_deposit', 'near_deposit', 'ft_transfer', 'ft_transfer_call'])
    expect(txs[0]?.actions[2]).toEqual({
      kind: 'call',
      method: 'ft_transfer',
      args: { receiver_id: 'nearkitfee.near', amount: (10n ** 22n).toString() },
      gas: '10000000000000',
      deposit: '1',
    })
    expect(txs[0]?.actions[3]).toMatchObject({ method: 'ft_transfer_call', args: { receiver_id: 'dclv2.ref-labs.near', amount: (2n * ONE - 10n ** 22n).toString() } })
    // The NEAR wrapped must cover the swap and the fee exactly.
    expect(() =>
      buildSwapTransactions({
        ...base,
        wrap: { contract: 'wrap.near', amount: 2n * ONE, registerDeposit: null },
        swap: { tokenContract: 'wrap.near', receiverId: 'dclv2.ref-labs.near', amount: 2n * ONE, msg: '{}' },
        feeTransfer: { recipient: 'nearkitfee.near', amount: 10n ** 22n },
      }),
    ).toThrow(/cover the swap and the fee/)
    // No fee (testnet): no transfer.
    expect(methods(buildSwapTransactions({ ...base, feeTransfer: { recipient: 'nearkitfee.near', amount: 0n } })[0]?.actions ?? [])).toEqual(['ft_transfer_call'])
  })

  it('never pays the NEARKITS fee with a transfer on Rhea’s aggregator: the fee travels inside the signed route only', () => {
    const txs = buildSwapTransactions({
      ...base,
      aggregatorDeposits: { contract: 'aggregatedex.near', entries: [{ user: 'fees.nearkit.near', tokens: ['wrap.near'], deposit: 5n }] },
    })
    const all = txs.flatMap((t) => t.actions)
    expect(all.some((a) => a.kind === 'transfer')).toBe(false)
    expect(all.some((a) => a.kind === 'call' && a.method === 'ft_transfer')).toBe(false)
    expect(all.filter((a) => a.kind === 'call' && a.method === 'ft_transfer_call')).toHaveLength(1)
  })
})
