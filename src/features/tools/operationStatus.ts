import type { ToastTone } from '@/components/ui/toast-context'
import type { OperationPlan, OperationProgress } from '@/types/operations'

/**
 * What the operation dialog says about a run: its title, whether it can be closed, and the
 * notice when it settles. Slower than usual is never worded as a failure.
 */

export function headline(plan: OperationPlan, progress: OperationProgress): string {
  const txs = progress.txs
  const done = txs.filter((t) => t.phase === 'success').length
  if (progress.phase === 'running') {
    if (txs.some((t) => t.phase === 'awaiting_signature')) return 'Waiting for your approval in the wallet'
    if (txs.some((t) => t.phase === 'processing')) return 'Processing — NEAR network is taking longer than usual'
    return progress.simulated ? 'Simulating' : 'Confirming on chain'
  }
  if (progress.phase === 'paused') {
    if (progress.pause?.reason === 'switch-account') return 'Switch account to continue'
    return progress.pause?.reason === 'requote' ? 'Quote expired' : 'Paused: review the results'
  }
  if (progress.simulated) return 'Simulation complete'
  if (progress.phase === 'success') return `${plan.transactions.length === 1 ? 'Confirmed' : `All ${done} transactions confirmed`}`
  if (progress.phase === 'processing') return 'Still processing on chain'
  if (txs.some((t) => t.phase === 'unknown')) return 'Outcome not confirmed'
  if (progress.phase === 'partial') return `${done} of ${txs.length} transactions confirmed`
  return txs.every((t) => t.phase === 'not_sent') ? 'Nothing was sent' : 'Not completed'
}

/**
 * A running operation's dialog may close once all that's left is following the chain: nothing
 * awaits the wallet and no later approval is to come. The run goes on, and its result still
 * arrives (notice, Activity).
 */
export function canCloseWhileRunning(progress: OperationProgress): boolean {
  return progress.txs.every((t) => t.phase !== 'awaiting_signature' && t.phase !== 'queued')
}

export function settledToast(plan: OperationPlan, progress: OperationProgress, networkLabel: string): { tone: ToastTone; title: string; detail: string } {
  const ok = progress.txs.filter((t) => t.phase === 'success').length
  if (progress.simulated) return { tone: 'accent', title: `Simulated · ${plan.title}`, detail: 'Nothing was signed or sent. Balances are unchanged.' }
  if (progress.phase === 'success')
    return { tone: 'accent', title: `Confirmed · ${plan.title}`, detail: `${ok} ${ok === 1 ? 'transaction' : 'transactions'} confirmed on ${networkLabel.toLowerCase()}.` }
  if (progress.phase === 'processing')
    return {
      tone: 'warn',
      title: `Still processing · ${plan.title}`,
      detail: 'NEAR network is taking longer than usual. NearKit keeps checking it in Activity; don’t send it again until it settles.',
    }
  return { tone: 'neg', title: `Not completed · ${plan.title}`, detail: `${ok} of ${progress.txs.length} transactions confirmed. Review the results.` }
}
