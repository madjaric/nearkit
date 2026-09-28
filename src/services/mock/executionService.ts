import { initialProgress, settledPhase } from '@/services/near/executor'
import type { ActivityKind } from '@/types/domain'
import type { OperationPlan, OperationProgress, TxProgress } from '@/types/operations'
import type { ExecutionService } from '../types'
import { ServiceError, logActivity, type MockState } from './state'

const KIND: Record<OperationPlan['kind'], ActivityKind> = {
  transfer: 'batch-send',
  'batch-send': 'batch-send',
  split: 'split',
  consolidate: 'consolidate',
  swap: 'swap',
  'multi-trade': 'multi-trade',
}

let latency = 1
/** Tests set this to 0 so simulated runs finish instantly. */
export function setSimulationLatency(scale: number): void {
  latency = scale
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms * latency))

/** Demo execution: walks the plan's groups with believable timing. Nothing is signed or sent, and no hash exists. */
export function createExecutionService(state: MockState): ExecutionService {
  return {
    async run(plan, prior, onProgress) {
      if (plan.mode !== 'demo') throw new ServiceError('wrong-mode', 'The demo can only simulate demo plans')
      let progress: OperationProgress = prior ? { ...prior, phase: 'running', pause: null } : { ...initialProgress(plan, true), phase: 'running' }
      const set = (patch: Partial<OperationProgress>, txPatch: Record<number, Partial<TxProgress>> = {}) => {
        progress = { ...progress, ...patch, txs: progress.txs.map((t) => (txPatch[t.index] ? { ...t, ...txPatch[t.index] } : t)) }
        onProgress(progress)
      }
      const each = (indexes: number[], patch: Partial<TxProgress>) => Object.fromEntries(indexes.map((i) => [i, patch])) as Record<number, Partial<TxProgress>>
      set({})
      for (let g = progress.groupIndex; g < plan.groups.length; g++) {
        const group = plan.groups[g] ?? []
        set({ groupIndex: g }, each(group, { phase: 'awaiting_signature' }))
        await pause(260)
        set({}, each(group, { phase: 'confirming', note: 'Simulated: nothing is sent' }))
        await pause(Math.max(90, Math.min(400, 1200 / plan.groups.length)))
        set({}, each(group, { phase: 'success' }))
      }
      set({ phase: settledPhase(progress.txs), groupIndex: plan.groups.length, finishedAt: Date.now() })
      logActivity(state, {
        kind: KIND[plan.kind],
        title: `${plan.title} (simulated)`,
        detail: `${plan.lines.length} ${plan.lines.length === 1 ? 'line' : 'lines'} · ${plan.totals.amount.display} ${plan.token.symbol}`,
      })
      return progress
    },
  }
}
