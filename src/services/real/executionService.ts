import { createExecutor } from '@/services/near/executor'
import type { ExecutionService } from '../types'
import { recordFrom } from './activity'
import type { NearContext } from './context'

/**
 * Real execution: the shared executor (policy check, wallet signing, on-chain
 * confirmation) plus NearKit's activity record, written on every update so a
 * reload can reconcile an interrupted run.
 */
export function createExecutionService(ctx: NearContext, active: Set<string>): ExecutionService {
  const executor = createExecutor({
    rpc: ctx.rpc,
    wallet: ctx.wallet,
    policy: ctx.policy,
    explorerTxUrl: ctx.explorerTx,
    now: ctx.now,
    onUpdate: (plan, progress) => {
      const existing = ctx.stores.activity.list().find((r) => r.id === plan.id) ?? null
      const record = recordFrom(ctx, plan, progress, existing)
      if (record) ctx.stores.activity.upsert(record)
    },
  })

  return {
    async run(plan, prior, onProgress) {
      active.add(plan.id)
      try {
        const result = await executor.run(plan, prior, onProgress)
        return result
      } finally {
        active.delete(plan.id)
        for (const signer of plan.signers) ctx.balances.invalidate(signer)
        for (const line of plan.lines) ctx.balances.invalidate(line.accountId)
      }
    },
  }
}
