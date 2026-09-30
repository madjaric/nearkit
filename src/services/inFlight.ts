import { useSyncExternalStore } from 'react'
import type { OperationPlan } from '@/types/operations'

/**
 * Runs that are still going in this tab: signing, or followed on chain while the NEAR network
 * is slow (the dialog can be closed meanwhile). The review of a new trade checks it, so the
 * same trade from the same wallet can't be sent again by accident before the first settles.
 */

export interface InFlightRun {
  planId: string
  kind: OperationPlan['kind']
  signers: readonly string[]
  /** `tokenIn→tokenOut` for trades; null for anything else. */
  pair: string | null
  title: string
}

const pairOf = (plan: OperationPlan) => (plan.swap && (plan.kind === 'swap' || plan.kind === 'multi-trade') ? `${plan.swap.tokenIn.id}→${plan.swap.tokenOut.id}` : null)

export function createInFlight() {
  let runs: readonly InFlightRun[] = []
  const listeners = new Set<() => void>()
  const set = (next: readonly InFlightRun[]) => {
    runs = next
    for (const l of listeners) l()
  }
  return {
    /** Registers a run; call the result when it has settled. */
    add(plan: OperationPlan): () => void {
      const run: InFlightRun = { planId: plan.id, kind: plan.kind, signers: [...plan.signers], pair: pairOf(plan), title: plan.title }
      set([...runs, run])
      let done = false
      return () => {
        if (done) return
        done = true
        set(runs.filter((r) => r !== run))
      }
    },
    get: () => runs,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

/** A run still going that `plan` would repeat: the same trade from one of the same wallets. */
export function conflictOf(runs: readonly InFlightRun[], plan: OperationPlan): InFlightRun | null {
  const pair = pairOf(plan)
  if (!pair) return null
  return runs.find((r) => r.planId !== plan.id && r.pair === pair && r.signers.some((s) => plan.signers.includes(s))) ?? null
}

export const inFlight = createInFlight()

export function useInFlightConflict(plan: OperationPlan | null): InFlightRun | null {
  const runs = useSyncExternalStore(inFlight.subscribe, inFlight.get, inFlight.get)
  return plan ? conflictOf(runs, plan) : null
}
