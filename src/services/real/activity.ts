import { mapLimit } from '@/lib/async'
import { classifyOutcome } from '@/services/near/outcome'
import type { ActivityKind, ActivityStatus } from '@/types/domain'
import type { OperationPlan, OperationProgress, PlannedTransaction, TxPhase } from '@/types/operations'
import type { NearContext } from './context'
import type { ActivityRecord, ActivityTx } from './stores'

/**
 * NearKit's own transaction history: a local record per operation, written as
 * the executor reports progress and reconciled with the chain afterwards. A
 * record whose outcome was never confirmed stays "unknown" until the chain
 * answers; it is never promoted to success on the wallet's word.
 */

const KIND: Record<OperationPlan['kind'], ActivityKind> = {
  transfer: 'batch-send',
  'batch-send': 'batch-send',
  split: 'split',
  consolidate: 'consolidate',
  swap: 'swap',
  'multi-trade': 'multi-trade',
}

const OPEN: readonly TxPhase[] = ['submitted', 'confirming', 'processing', 'unknown']
/** Phases a run still in progress can change. */
const LIVE: readonly TxPhase[] = ['queued', 'awaiting_signature', 'submitted', 'confirming', 'processing']
/** A run that stopped reporting this long ago was interrupted (tab closed). */
const STALE_MS = 10 * 60_000
const RECHECK_MS = 20_000

export function activityStatus(txs: readonly Pick<ActivityTx, 'phase'>[], running: boolean): ActivityStatus {
  // Still settling on chain is pending, never a failure.
  if (running || txs.some((t) => t.phase === 'processing')) return 'pending'
  if (txs.some((t) => OPEN.includes(t.phase) || t.phase === 'awaiting_signature')) return 'unknown'
  if (txs.length > 0 && txs.every((t) => t.phase === 'success')) return 'success'
  return txs.some((t) => t.phase === 'success') ? 'partial' : 'failed'
}

function detailOf(plan: OperationPlan): string {
  if (plan.swap) return `${plan.swap.amountIn.display} ${plan.swap.tokenIn.symbol} → min ${plan.swap.minOut.display} ${plan.swap.tokenOut.symbol}`
  const n = plan.lines.length
  return `${n} ${n === 1 ? 'line' : 'lines'} · ${plan.totals.amount.display} ${plan.token.symbol}`
}

/** Record for a plan's current progress; null until something has actually been submitted. */
export function recordFrom(ctx: NearContext, plan: OperationPlan, progress: OperationProgress, existing: ActivityRecord | null): ActivityRecord | null {
  const txs: ActivityTx[] = plan.transactions.map((t) => {
    const p = progress.txs.find((x) => x.index === t.index)
    return {
      hash: p?.hash ?? null,
      signerId: t.signerId,
      receiverId: t.receiverId,
      phase: p?.phase ?? 'queued',
      last: t.actions.at(-1) ?? null,
      note: p?.note ?? p?.error?.message ?? null,
    }
  })
  const hashes = txs.flatMap((t) => (t.hash ? [t.hash] : []))
  if (!existing && hashes.length === 0) return null
  const first = hashes[0]
  return {
    id: plan.id,
    planId: plan.id,
    kind: KIND[plan.kind],
    title: plan.title,
    detail: detailOf(plan),
    at: existing?.at ?? progress.startedAt,
    origin: 'nearkit',
    status: activityStatus(txs, progress.phase === 'running'),
    network: ctx.network.id,
    accountId: plan.signers[0] ?? '',
    txHashes: hashes,
    explorerUrl: first ? ctx.explorerTx(first) : null,
    txs,
    checkedAt: ctx.now(),
  }
}

const plannedFrom = (t: ActivityTx): PlannedTransaction => ({
  index: 0,
  signerId: t.signerId,
  receiverId: t.receiverId,
  actions: t.last ? [t.last] : [],
  lineIds: [],
  label: '',
  gas: '0',
  deposit: '0',
})

/**
 * Ask the chain about every transaction that isn't settled yet. Interrupted runs
 * are closed out: transactions that never reached the wallet are "not sent", and
 * ones the wallet was still holding stay "unknown" with a note to check the wallet.
 */
export async function reconcile(ctx: NearContext, record: ActivityRecord, active: ReadonlySet<string>): Promise<ActivityRecord> {
  if (active.has(record.planId)) return record
  if (record.status !== 'pending' && record.status !== 'unknown') return record
  if (record.checkedAt !== null && ctx.now() - record.checkedAt < RECHECK_MS) return record

  const interrupted = record.status === 'pending' && ctx.now() - (record.checkedAt ?? record.at) > STALE_MS
  const txs = await mapLimit(record.txs, 3, async (t): Promise<ActivityTx> => {
    if (t.hash && OPEN.includes(t.phase)) {
      try {
        const result = await ctx.rpc.txStatus(t.hash, t.signerId, 'FINAL')
        if (!result) return t
        const verdict = classifyOutcome(result, plannedFrom(t))
        return { ...t, phase: verdict.phase, note: verdict.note ?? verdict.error?.message ?? null }
      } catch {
        return t
      }
    }
    if (!interrupted) return t
    if (t.phase === 'queued') return { ...t, phase: 'not_sent' }
    if (t.phase === 'awaiting_signature') return { ...t, phase: 'unknown', note: 'NearKit closed while the wallet was open. Check your wallet activity.' }
    if (t.phase === 'processing' && !t.hash) return { ...t, phase: 'unknown', note: 'NearKit closed while looking for this transaction on chain. Check your wallet activity.' }
    return t
  })
  // Pending also means "still settling on chain"; a record whose steps all settled isn't running.
  const running = record.status === 'pending' && !interrupted && txs.some((t) => LIVE.includes(t.phase))
  return { ...record, txs, status: activityStatus(txs, running), checkedAt: ctx.now() }
}
