import { NATIVE_TOKEN_ID } from '@/config/networks'
import { createExecutor } from '@/services/near/executor'
import { createTxLocator } from '@/services/near/locate'
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
    // What the wallet sent is found on chain even when the wallet's own wait times out.
    locator: createTxLocator(ctx.rpc),
    onUpdate: (plan, progress) => {
      const existing = ctx.stores.activity.list().find((r) => r.id === plan.id) ?? null
      const record = recordFrom(ctx, plan, progress, existing)
      if (record) ctx.stores.activity.upsert(record)
    },
  })

  return {
    forgetBalances(accountIds) {
      for (const id of accountIds) ctx.balances.invalidate(id)
    },
    trackBalances(accountIds, contracts) {
      const tokens = contracts.filter((c) => c !== NATIVE_TOKEN_ID)
      if (tokens.length > 0) for (const id of accountIds) ctx.balances.track(id, tokens)
    },
    async run(plan, prior, onProgress) {
      active.add(plan.id)
      try {
        const result = await executor.run(plan, prior, onProgress)
        return result
      } finally {
        active.delete(plan.id)
        // The traded tokens are read from chain on every balance read for a while, even
        // before the token indexer reports them (a first-time token included).
        const tokens = plan.swap ? [plan.swap.tokenIn, plan.swap.tokenOut, ...(plan.swap.routeTokens ?? [])] : [plan.token]
        const contracts = tokens.flatMap((t) => (t.contract ? [t.contract] : []))
        for (const account of new Set([...plan.signers, ...plan.lines.map((l) => l.accountId)])) {
          ctx.balances.track(account, contracts)
          ctx.balances.invalidate(account)
        }
      }
    },
  }
}
