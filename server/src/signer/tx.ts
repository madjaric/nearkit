import { jsonArgs, type NearTransaction, type TxAction } from '@/services/near/transaction'
import type { WalletAction } from '../custody/policy'

/** NearKit's planned actions as NEAR transaction actions (full-access keys only for AddKey). */
export function toTxActions(actions: readonly WalletAction[]): TxAction[] {
  return actions.map((a): TxAction => {
    switch (a.kind) {
      case 'transfer':
        return { type: 'Transfer', deposit: BigInt(a.deposit) }
      case 'call':
        return { type: 'FunctionCall', methodName: a.method, args: jsonArgs(a.args), gas: BigInt(a.gas), deposit: BigInt(a.deposit) }
      case 'add-key':
        return { type: 'AddKey', publicKey: a.publicKey, permission: 'FullAccess' }
      case 'delete-key':
        return { type: 'DeleteKey', publicKey: a.publicKey }
    }
  })
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

function sameAction(a: TxAction, b: TxAction): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'Transfer':
      return a.deposit === (b as typeof a).deposit
    case 'FunctionCall': {
      const o = b as typeof a
      return a.methodName === o.methodName && sameBytes(a.args, o.args) && a.gas === o.gas && a.deposit === o.deposit
    }
    case 'AddKey': {
      const o = b as typeof a
      return a.publicKey === o.publicKey && a.permission === 'FullAccess' && o.permission === 'FullAccess'
    }
    case 'DeleteKey':
      return a.publicKey === (b as typeof a).publicKey
  }
}

/** Field by field: what was signed is exactly what was planned. */
export function sameTransaction(a: NearTransaction, b: NearTransaction): boolean {
  return (
    a.signerId === b.signerId &&
    a.publicKey === b.publicKey &&
    a.nonce === b.nonce &&
    a.receiverId === b.receiverId &&
    sameBytes(a.blockHash, b.blockHash) &&
    a.actions.length === b.actions.length &&
    a.actions.every((x, i) => sameAction(x, b.actions[i] as TxAction))
  )
}
