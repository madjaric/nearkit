import { GAS } from '@/services/near/gas'
import { storageDepositAction } from '@/services/near/plans'
import type { PlannedAction, PlannedTransaction } from '@/types/operations'

/**
 * The transactions of one swap, in signing order: storage registrations on
 * token contracts, then registrations inside Rhea's aggregator, then the swap
 * itself (with NEAR wrapped in the same transaction when NEAR is the input).
 * The NearKit fee never appears here as a transfer: on mainnet it is part of
 * the signed route (`app_fee_rate`), collected by the aggregator.
 */

export interface SwapTxInput {
  signerId: string
  /** NEAR input: wrap this much first, registering with the wrap contract if needed. */
  wrap: { contract: string; amount: bigint; registerDeposit: bigint | null } | null
  /** NEP-145 `storage_deposit` calls: the signer on route tokens, the aggregator on token contracts. */
  registrations: { contract: string; accountId: string; deposit: bigint }[]
  /** Aggregator-internal registrations: `tokens_storage_deposit {user, tokens}` per account. */
  aggregatorDeposits: { contract: string; entries: { user: string; tokens: string[]; deposit: bigint }[] } | null
  swap: { tokenContract: string; receiverId: string; amount: bigint; msg: string }
  label: string
}

type Draft = Omit<PlannedTransaction, 'index' | 'gas' | 'deposit'>

const sum = (actions: PlannedAction[], pick: (a: PlannedAction) => bigint) => actions.reduce((s, a) => s + pick(a), 0n).toString()

export function buildSwapTransactions(input: SwapTxInput): PlannedTransaction[] {
  const drafts: Draft[] = []
  const byContract = new Map<string, PlannedAction[]>()
  for (const r of input.registrations) byContract.set(r.contract, [...(byContract.get(r.contract) ?? []), storageDepositAction(r.accountId, r.deposit)])

  for (const [contract, actions] of byContract) {
    if (contract === input.swap.tokenContract) continue
    drafts.push({ signerId: input.signerId, receiverId: contract, actions, lineIds: [], label: `Register storage on ${contract}` })
  }

  const agg = input.aggregatorDeposits
  if (agg && agg.entries.length) {
    drafts.push({
      signerId: input.signerId,
      receiverId: agg.contract,
      actions: agg.entries.map((e) => ({
        kind: 'call',
        method: 'tokens_storage_deposit',
        args: { user: e.user, tokens: e.tokens },
        gas: GAS.AGGREGATOR_STORAGE.toString(),
        deposit: e.deposit.toString(),
      })),
      lineIds: [],
      label: 'Register tokens with Rhea',
    })
  }

  const swapActions: PlannedAction[] = [...(byContract.get(input.swap.tokenContract) ?? [])]
  if (input.wrap) {
    if (input.wrap.contract !== input.swap.tokenContract) throw new Error('NEAR input must be swapped from the wrap contract')
    if (input.wrap.registerDeposit !== null && !swapActions.some((a) => a.kind === 'call' && a.method === 'storage_deposit' && a.args.account_id === input.signerId)) {
      swapActions.unshift(storageDepositAction(input.signerId, input.wrap.registerDeposit))
    }
    swapActions.push({ kind: 'call', method: 'near_deposit', args: {}, gas: GAS.NEAR_DEPOSIT.toString(), deposit: input.wrap.amount.toString() })
  }
  swapActions.push({
    kind: 'call',
    method: 'ft_transfer_call',
    args: { receiver_id: input.swap.receiverId, amount: input.swap.amount.toString(), msg: input.swap.msg },
    gas: GAS.SWAP_CALL.toString(),
    deposit: '1',
  })
  drafts.push({ signerId: input.signerId, receiverId: input.swap.tokenContract, actions: swapActions, lineIds: [], label: input.label })

  return drafts.map((d, index) => ({
    ...d,
    index,
    gas: sum(d.actions, (a) => (a.kind === 'call' ? BigInt(a.gas) : 0n)),
    deposit: sum(d.actions, (a) => BigInt(a.deposit)),
  }))
}
