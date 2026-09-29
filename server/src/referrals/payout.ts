import type { RpcTxResult } from '@/services/near/rpc'
import type { Claim } from './store'

/**
 * Checks a payout the owner made from NearKit's account before a claim is marked paid:
 * the transaction succeeded, every receipt succeeded, and it pays exactly this claim's
 * amount of its token to its destination (`ft_transfer` on the token contract, or a plain
 * NEAR transfer for a wNEAR claim). Anything else is refused: a claim is never marked paid
 * on the owner's word alone.
 */

export type PayoutCheck = { ok: true } | { ok: false; reason: string }

const failed = (status: unknown) => Boolean(status && typeof status === 'object' && 'Failure' in status)

function argsOf(b64: unknown): Record<string, unknown> | null {
  if (typeof b64 !== 'string') return null
  try {
    const value: unknown = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function checkPayout(result: RpcTxResult, claim: Pick<Claim, 'token' | 'amount' | 'destination'>, wrapContract: string): PayoutCheck {
  const status = result.status as Record<string, unknown> | null
  if (!status || typeof status !== 'object' || !('SuccessValue' in status)) return { ok: false, reason: 'the transaction did not succeed' }
  if (failed(result.transaction_outcome?.outcome?.status) || (result.receipts_outcome ?? []).some((r) => failed(r.outcome.status)))
    return { ok: false, reason: 'a receipt of the transaction failed' }
  const receiver = result.transaction.receiver_id
  const amount = claim.amount.toString()
  for (const action of result.transaction.actions ?? []) {
    if (!action || typeof action !== 'object') continue
    const a = action as Record<string, Record<string, unknown> | undefined>
    const call = a.FunctionCall
    if (call && receiver === claim.token && call.method_name === 'ft_transfer') {
      const args = argsOf(call.args)
      if (args?.receiver_id === claim.destination && String(args.amount) === amount) return { ok: true }
    }
    const transfer = a.Transfer
    if (transfer && claim.token === wrapContract && receiver === claim.destination && String(transfer.deposit) === amount) return { ok: true }
  }
  return { ok: false, reason: 'the transaction does not pay exactly this claim’s amount to its destination' }
}
