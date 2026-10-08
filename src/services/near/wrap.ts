import { NATIVE_TOKEN_ID } from '@/config/networks'
import type { PlannedAction } from '@/types/operations'
import { GAS } from './gas'
import { storageDepositAction } from './plans'

/**
 * NEAR ↔ wNEAR, built once. NEARKITS' server signs these for a NEARKITS wallet (custody/unwrap.ts,
 * and the wrap step of its swaps), held to exactly this shape by the signer's policy; the browser
 * signs the same calls for a connected wallet. Wrapping is 1:1 and carries no NEARKITS fee.
 */

type CallAction = Extract<PlannedAction, { kind: 'call' }>

export type WrapDirection = 'wrap' | 'unwrap'

/** NEAR into the network's wrap contract (wNEAR), or back; null for any other pair. */
export function wrapDirection(tokenIn: string, tokenOut: string, wrapContract: string): WrapDirection | null {
  if (tokenIn === NATIVE_TOKEN_ID && tokenOut === wrapContract) return 'wrap'
  if (tokenIn === wrapContract && tokenOut === NATIVE_TOKEN_ID) return 'unwrap'
  return null
}

/** What one call to the wrap contract burns, about: the ≈ 0.0005 NEAR the Telegram bot's unwrap review shows (judged when final). */
export const WRAP_NETWORK_FEE_YOCTO = 5n * 10n ** 20n

/** wNEAR back to NEAR: the wrap contract's `near_withdraw`, with the 1 yoctoNEAR it requires attached. */
export function nearWithdrawAction(amount: bigint): CallAction {
  return { kind: 'call', method: 'near_withdraw', args: { amount: amount.toString() }, gas: GAS.NEAR_WITHDRAW.toString(), deposit: '1' }
}

/** NEAR into wNEAR: the wrap contract's `near_deposit`, carrying the amount. */
export function nearDepositAction(amount: bigint): CallAction {
  return { kind: 'call', method: 'near_deposit', args: {}, gas: GAS.NEAR_DEPOSIT.toString(), deposit: amount.toString() }
}

/** A wrap on its own, as the wrap step of a swap from NEAR does it: registration with the wrap contract when the account has none, then the deposit. */
export function wrapActions(signerId: string, amount: bigint, registerDeposit: bigint | null): PlannedAction[] {
  return [...(registerDeposit !== null ? [storageDepositAction(signerId, registerDeposit)] : []), nearDepositAction(amount)]
}
