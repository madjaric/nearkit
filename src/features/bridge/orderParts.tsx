import { Check, CircleAlert, ExternalLink, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import type { BridgeChain } from '@/config/bridge'
import type { BridgeStep, StepState } from '@/lib/bridge/progress'
import type { BridgeOrderView, BridgeTx } from '@/lib/bridge/types'
import { cn } from '@/lib/cn'
import { truncateMiddle } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { countdown, rawText } from './format'

/**
 * Pieces of an order's page both bridge products show the same way: the steps (each marked only on
 * what was seen), the transactions as explorer links, and what to send while the deposit address
 * waits. The balance refresh once funds arrive is orderEffects.ts's.
 */

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done')
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-accent text-accent-ink">
        <Check size={12} strokeWidth={3} aria-hidden="true" />
      </span>
    )
  if (state === 'active')
    return (
      <span className="flex size-5 items-center justify-center rounded-full border border-accent/60 text-accent">
        <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      </span>
    )
  if (state === 'error')
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-warn/15 text-warn">
        <CircleAlert size={12} aria-hidden="true" />
      </span>
    )
  return <span className="size-5 rounded-full border border-line" aria-hidden="true" />
}

const STATE_WORD: Record<StepState, string> = { done: 'done', active: 'in progress', todo: 'to do', error: 'stopped' }

export function StepList({ steps }: { steps: BridgeStep[] }) {
  return (
    <ol className="flex flex-col gap-0" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s.key} className="flex gap-3">
          <div className="flex flex-col items-center">
            <StepIcon state={s.state} />
            {i < steps.length - 1 && <span className={cn('w-px flex-1', s.state === 'done' ? 'bg-accent/50' : 'bg-line')} aria-hidden="true" />}
          </div>
          <p className={cn('pb-4 text-sm leading-5', s.state === 'todo' ? 'text-fg-3' : s.state === 'error' ? 'text-warn' : 'text-fg')}>
            {s.label}
            <span className="sr-only">: {STATE_WORD[s.state]}</span>
          </p>
        </li>
      ))}
    </ol>
  )
}

export function TxLinks({ txs, label }: { txs: BridgeTx[]; label: string }) {
  if (!txs.length) return <span className="text-fg-3">—</span>
  return (
    <span className="flex flex-wrap justify-end gap-x-2">
      {txs.map((t) =>
        t.url ? (
          <a
            key={t.hash}
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            className="num inline-flex items-center gap-1 text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg"
            aria-label={`${label} ${t.hash} on the explorer`}
          >
            {truncateMiddle(t.hash, 6, 4)}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : (
          <span key={t.hash} className="num text-fg-2">
            {truncateMiddle(t.hash, 6, 4)}
          </span>
        ),
      )}
    </span>
  )
}

/** While the deposit address waits: exactly what to send, from where, to where, and until when. */
export function AwaitingDeposit({ order: o, chain, newLabel, onNew }: { order: BridgeOrderView; chain: BridgeChain; newLabel: string; onNew: () => void }) {
  const now = useNow(1_000)
  const open = now < o.depositDeadline
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-soft bg-well/60 p-3 text-sm">
      {open ? (
        <>
          <p className="text-fg">
            Waiting for <span className="num font-semibold">{`${rawText(o.quote.amountIn, chain.decimals, chain.decimals)} ${chain.symbol}`}</span> from{' '}
            <span className="num">{truncateMiddle(o.sourceAddress, 6, 4)}</span> to the deposit address:
          </p>
          <p className="flex items-center gap-1.5">
            <span className="num break-all text-fg">{o.depositAddress}</span>
            <CopyButton value={o.depositAddress} label="Copy deposit address" />
          </p>
          <p className="text-xs text-fg-3">
            {now < o.signBy
              ? `Send within ${countdown(o.signBy, now)}, and only if you haven’t sent it yet.`
              : `The time to send this quote has passed: don’t send to it now. Start a new ${newLabel.replace(/^New /, '')}.`}
          </p>
        </>
      ) : (
        <p className="text-fg-3">The deposit address closed. If nothing was sent, nothing happens.</p>
      )}
      <div>
        <Button variant="ghost" size="sm" onClick={onNew}>
          {newLabel}
        </Button>
      </div>
    </div>
  )
}
