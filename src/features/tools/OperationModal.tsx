import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SimulationNote, StatusLamp } from '@/components/domain/Status'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Skeleton } from '@/components/ui/Indicators'
import { useToast } from '@/components/ui/toast-context'
import { cn } from '@/lib/cn'
import { truncateMiddle } from '@/lib/format'
import { describeError, type ErrorView } from '@/services/errors'
import { useCapabilities, useExecution } from '@/services/queries'
import { useConnectPrompt } from '@/state/contexts'
import type { OperationPlan, OperationProgress, TxProgress } from '@/types/operations'
import { PlanReview } from './PlanReview'

type Stage =
  | { kind: 'preparing' }
  | { kind: 'prepare-error'; error: ErrorView }
  | { kind: 'review'; plan: OperationPlan; error: ErrorView | null }
  | { kind: 'running' | 'settled'; plan: OperationPlan; progress: OperationProgress; error?: ErrorView }

/** Settled phase from what the transactions show (for a run that stopped with an error). */
function phaseOf(txs: TxProgress[]): OperationProgress['phase'] {
  if (txs.length > 0 && txs.every((t) => t.phase === 'success')) return 'success'
  return txs.some((t) => t.phase === 'success') ? 'partial' : 'failed'
}

interface OperationModalProps {
  /** Modal title while reviewing, e.g. "Review batch send". */
  title: string
  /** Constant fire-key label, e.g. "Send batch". */
  confirmLabel: string
  prepare: () => Promise<OperationPlan>
  onClose: () => void
  onSettled?: (progress: OperationProgress) => void
}

function Diagnostics({ detail }: { detail: string | null | undefined }) {
  if (!detail) return null
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11px] text-fg-3 hover:text-fg-2">Technical details</summary>
      <pre className="num mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xs bg-well px-2 py-1.5 text-[11px] leading-4 text-fg-3">{detail}</pre>
    </details>
  )
}

function ErrorBox({ error }: { error: ErrorView }) {
  return (
    <div role="alert" className="rounded-sm border border-neg/40 bg-neg/10 px-3 py-2">
      <p className="text-sm text-neg">
        <Figures>{error.message}</Figures>
      </p>
      <Diagnostics detail={error.detail} />
    </div>
  )
}

function TxRow({ tx, label, simulated }: { tx: TxProgress; label: string; simulated: boolean }) {
  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          <Figures>{label}</Figures>
        </span>
        <StatusLamp status={tx.phase === 'success' && simulated ? 'simulated' : tx.phase} className="shrink-0" />
      </div>
      {(tx.hash || tx.note || tx.error) && (
        <div className="flex flex-col gap-0.5 text-xs">
          {tx.hash && (
            <span className="flex items-center gap-1.5 text-fg-3">
              <span className="num" title={tx.hash}>
                {truncateMiddle(tx.hash, 8, 6)}
              </span>
              {tx.explorerUrl && (
                <a
                  href={tx.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg"
                >
                  Explorer <ExternalLink size={11} aria-hidden="true" />
                </a>
              )}
            </span>
          )}
          {tx.error && (
            <span className={tx.phase === 'failed' ? 'text-neg' : tx.phase === 'unknown' ? 'text-warn' : 'text-fg-3'}>
              <Figures>{tx.error.message}</Figures>
            </span>
          )}
          {tx.note && (
            <span className="text-fg-3">
              <Figures>{tx.note}</Figures>
            </span>
          )}
          <Diagnostics detail={tx.error?.detail} />
        </div>
      )}
    </li>
  )
}

function headline(plan: OperationPlan, progress: OperationProgress): string {
  const txs = progress.txs
  const done = txs.filter((t) => t.phase === 'success').length
  if (progress.phase === 'running') {
    if (txs.some((t) => t.phase === 'awaiting_signature')) return 'Waiting for your approval in the wallet'
    return progress.simulated ? 'Simulating' : 'Confirming on chain'
  }
  if (progress.phase === 'paused') {
    if (progress.pause?.reason === 'switch-account') return 'Switch account to continue'
    return progress.pause?.reason === 'requote' ? 'Quote expired' : 'Paused: review the results'
  }
  if (progress.simulated) return 'Simulation complete'
  if (progress.phase === 'success') return `${plan.transactions.length === 1 ? 'Confirmed' : `All ${done} transactions confirmed`}`
  if (txs.some((t) => t.phase === 'unknown')) return 'Outcome not confirmed'
  if (progress.phase === 'partial') return `${done} of ${txs.length} transactions confirmed`
  return txs.every((t) => t.phase === 'not_sent') ? 'Nothing was sent' : 'Not completed'
}

/**
 * Review → sign → confirm → results, for every value-moving operation. The
 * review renders the service's exact plan; progress comes from the executor,
 * which only reports success after the chain confirms it.
 */
export function OperationModal({ title, confirmLabel, prepare, onClose, onSettled }: OperationModalProps) {
  const caps = useCapabilities()
  const run = useExecution()
  const toast = useToast()
  const { promptConnect } = useConnectPrompt()
  const [stage, setStage] = useState<Stage>({ kind: 'preparing' })
  const prepareRef = useRef(prepare)
  const alive = useRef(true)
  /** Latest progress of the current run, so an error never hides what reached the wallet. */
  const lastProgress = useRef<OperationProgress | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const prepareInto = async () => {
    try {
      const plan = await prepareRef.current()
      if (alive.current) setStage({ kind: 'review', plan, error: null })
    } catch (e) {
      if (alive.current) setStage({ kind: 'prepare-error', error: describeError(e) })
    }
  }

  /** Retry or refresh from an event handler. */
  const load = () => {
    setStage({ kind: 'preparing' })
    void prepareInto()
  }

  // Prepare exactly once per open: the modal starts in `preparing`.
  useEffect(() => {
    void prepareInto()
  }, [])

  const execute = async (plan: OperationPlan, prior: OperationProgress | null) => {
    lastProgress.current = prior
    try {
      const progress = await run(plan, prior, (p) => {
        lastProgress.current = p
        if (alive.current) setStage({ kind: 'running', plan, progress: p })
      })
      // The parent hears the outcome even when this modal was closed while the run finished
      // (the last transaction can show as confirmed a moment before the run returns).
      if (progress.phase !== 'paused') onSettled?.(progress)
      if (!alive.current) return
      setStage({ kind: 'settled', plan, progress })
      if (progress.phase !== 'paused') {
        const ok = progress.txs.filter((t) => t.phase === 'success').length
        if (progress.simulated) toast.push({ tone: 'accent', title: `Simulated · ${plan.title}`, detail: 'Nothing was signed or sent. Balances are unchanged.' })
        else if (progress.phase === 'success')
          toast.push({
            tone: 'accent',
            title: `Confirmed · ${plan.title}`,
            detail: `${ok} ${ok === 1 ? 'transaction' : 'transactions'} confirmed on ${caps.networkLabel.toLowerCase()}.`,
          })
        else toast.push({ tone: 'neg', title: `Not completed · ${plan.title}`, detail: `${ok} of ${progress.txs.length} transactions confirmed. Review the results.` })
      }
    } catch (e) {
      if (!alive.current) return
      const p = lastProgress.current
      // Once anything left the queue, stay on the results: going back to review would invite a second send.
      if (p && p.txs.some((t) => t.phase !== 'queued')) {
        setStage({
          kind: 'settled',
          plan,
          progress: { ...p, phase: p.phase === 'paused' ? 'paused' : phaseOf(p.txs), finishedAt: p.finishedAt ?? Date.now() },
          error: describeError(e),
        })
      } else {
        setStage({ kind: 'review', plan, error: describeError(e) })
      }
    }
  }

  const running = stage.kind === 'running' && stage.progress.phase === 'running'
  const plan = stage.kind === 'review' || stage.kind === 'running' || stage.kind === 'settled' ? stage.plan : null
  const progress = stage.kind === 'running' || stage.kind === 'settled' ? stage.progress : null
  const expired = stage.kind === 'review' && stage.plan.expiresAt !== null && stage.error?.code === 'QUOTE_EXPIRED'
  const blocked =
    plan && plan.mode === 'near'
      ? plan.fee?.charged
        ? caps.execution.trading.enabled
          ? null
          : caps.execution.trading.reason
        : caps.execution.enabled
          ? null
          : caps.execution.reason
      : null

  const modalTitle = stage.kind === 'review' || stage.kind === 'preparing' || stage.kind === 'prepare-error' ? title : plan && progress ? headline(plan, progress) : title
  const description =
    stage.kind === 'preparing'
      ? 'Checking accounts, balances and storage on chain…'
      : stage.kind === 'prepare-error'
        ? 'The operation could not be prepared. Nothing was signed or sent.'
        : stage.kind === 'review'
          ? stage.plan.title
          : progress?.simulated
            ? 'Simulation only: nothing is signed or sent.'
            : plan?.title

  const lineLabelFor = (p: OperationPlan, tx: TxProgress) => p.transactions[tx.index]?.label ?? `Transaction ${tx.index + 1}`

  const footer = (() => {
    if (stage.kind === 'preparing')
      return (
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      )
    if (stage.kind === 'prepare-error')
      return (
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </>
      )
    if (stage.kind === 'review')
      return (
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {expired ? (
              <Button variant="secondary" onClick={() => void load()}>
                Refresh quote
              </Button>
            ) : (
              <Button variant="primary" disabled={blocked !== null} onClick={() => void execute(stage.plan, null)}>
                {confirmLabel}
              </Button>
            )}
          </div>
          {blocked && (
            <p className="text-xs text-fg-3 sm:text-right">
              <Figures>{blocked}</Figures>
            </p>
          )}
        </div>
      )
    if (stage.kind === 'settled' && stage.progress.phase === 'paused') {
      const pause = stage.progress.pause
      if (pause?.reason === 'requote') {
        // The rest of this plan can't run on its old quote. A single swap is prepared again
        // (steps already done are detected on chain); anything else stops here.
        return (
          <>
            <Button variant="ghost" onClick={onClose}>
              Stop here
            </Button>
            {stage.plan.kind === 'swap' && (
              <Button variant="primary" onClick={() => void load()}>
                Get a fresh quote
              </Button>
            )}
          </>
        )
      }
      // A failed step inside a swap (e.g. a registration) can't be skipped safely: stop, then prepare again.
      if (pause?.reason === 'failure' && (stage.plan.kind === 'swap' || stage.plan.kind === 'multi-trade')) {
        return (
          <Button variant="ghost" onClick={onClose}>
            Stop here
          </Button>
        )
      }
      return (
        <>
          <Button variant="ghost" onClick={onClose}>
            Stop here
          </Button>
          {pause?.reason === 'switch-account' && (
            <Button variant="secondary" onClick={promptConnect}>
              Switch account
            </Button>
          )}
          <Button variant="primary" onClick={() => void execute(stage.plan, stage.progress)}>
            {pause?.reason === 'switch-account' ? 'Continue' : 'Continue with the rest'}
          </Button>
        </>
      )
    }
    return (
      <Button variant="secondary" onClick={onClose} disabled={running}>
        {running ? 'Working…' : 'Close'}
      </Button>
    )
  })()

  return (
    <Modal open onClose={onClose} dismissible={!running} size="lg" title={modalTitle} description={description} footer={footer}>
      <div className="flex flex-col gap-4">
        {stage.kind === 'preparing' && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}
        {stage.kind === 'prepare-error' && <ErrorBox error={stage.error} />}
        {stage.kind === 'review' && (
          <>
            {stage.error && <ErrorBox error={stage.error} />}
            <PlanReview plan={stage.plan} networkLabel={caps.networkLabel} />
            <SimulationNote />
          </>
        )}
        {plan && progress && (
          <>
            {(stage.kind === 'running' || stage.kind === 'settled') && stage.error && <ErrorBox error={stage.error} />}
            {progress.pause && (
              <p className={cn('rounded-sm border px-3 py-2 text-sm', progress.pause.reason === 'failure' ? 'border-warn/40 bg-warn/[0.06] text-warn' : 'border-line text-fg-2')}>
                <Figures>{progress.pause.message}</Figures>
                {plan.kind === 'multi-trade' && progress.pause.reason !== 'switch-account' && (
                  <> Wallets already done keep their swaps. To trade with the others, start a new Multi Trade for them.</>
                )}
              </p>
            )}
            <ol className="max-h-80 divide-y divide-line-soft overflow-y-auto rounded-sm border border-line-soft" aria-label="Transactions">
              {progress.txs.map((tx) => (
                <TxRow key={tx.index} tx={tx} label={lineLabelFor(plan, tx)} simulated={progress.simulated} />
              ))}
            </ol>
            {progress.simulated && <SimulationNote />}
          </>
        )}
      </div>
    </Modal>
  )
}
