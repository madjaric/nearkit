import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { accountState } from '@/services/near/account'
import { NearKitError } from '@/services/near/errors'
import { estimateUpfrontYocto, GAS } from '@/services/near/gas'
import type { ServerNear } from '../near'
import type { IntentHandler } from './engine'

/** wNEAR back to NEAR: one `near_withdraw` on the wrap contract (1 yoctoNEAR attached). */

export interface UnwrapParams {
  /** Raw wNEAR (24 decimals). */
  amount: string
}

export const UNWRAP_TTL_MS = 5 * 60_000

export function unwrapHandler(near: ServerNear): IntentHandler {
  const wrap = near.ctx.network.wrapContract
  return {
    async plan(intent, wallet) {
      const amount = BigInt((intent.params as unknown as UnwrapParams).amount)
      const [held, state] = await Promise.all([near.ctx.reader.balanceOf(wrap, wallet.accountId), accountState(near.ctx.rpc, wallet.accountId, 'final')])
      if (held < amount) throw new NearKitError('INSUFFICIENT_BALANCE', `Your NEARKITS wallet holds ${formatUnits(held, NEAR_DECIMALS, { maxFraction: 6 })} wNEAR.`)
      const upfront = estimateUpfrontYocto({ transactions: 1, actions: 1, attachedGas: GAS.NEAR_WITHDRAW, deposits: 1n })
      if (state.availableYocto < upfront) throw new NearKitError('INSUFFICIENT_GAS', 'Unwrapping needs a little NEAR for gas. Deposit some NEAR first.')
      return {
        kind: 'plan',
        op: { kind: 'unwrap', amount },
        plan: [
          {
            receiverId: wrap,
            actions: [{ kind: 'call', method: 'near_withdraw', args: { amount: amount.toString() }, gas: GAS.NEAR_WITHDRAW.toString(), deposit: '1' }],
            label: 'Unwrap wNEAR',
          },
        ],
      }
    },
    async summarize(_intent, _wallet, confirmed) {
      const status = confirmed.at(-1)?.result.status as Record<string, unknown> | undefined
      const ok = Boolean(status && 'SuccessValue' in status)
      return { ok, message: ok ? 'Unwrapped.' : 'Unwrapping failed on chain. Your wNEAR stayed in the wallet.', hashes: confirmed.map((c) => c.hash) }
    },
  }
}
