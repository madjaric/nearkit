import type { ReactNode } from 'react'
import { Tip } from '@/components/ui/Floating'
import { Led, Tag, type LedTone } from '@/components/ui/Indicators'
import { cn } from '@/lib/cn'
import { useCapabilities } from '@/services/queries'
import { useInComingSoon } from '@/state/contexts'
import type { OrderStatus, RuleStatus } from '@/types/domain'
import type { TxPhase } from '@/types/operations'

type TxLamp = Exclude<TxPhase, 'queued'>

const STATUS: Record<OrderStatus | RuleStatus | TxLamp | 'draft' | 'armed' | 'simulated' | 'skipped' | 'queued', { tone: LedTone; label: string; hint?: string }> = {
  open: { tone: 'on', label: 'Open', hint: 'Nothing watches the price, so this order never fills. Order execution needs a keeper service (Phase 3).' },
  filled: { tone: 'idle', label: 'Filled' },
  cancelled: { tone: 'off', label: 'Cancelled' },
  expired: { tone: 'off', label: 'Expired' },
  standby: { tone: 'idle', label: 'Standby', hint: 'Saved, not running. Nothing monitors or executes it; automation needs a keeper service (Phase 3).' },
  draft: { tone: 'idle', label: 'Draft', hint: 'Saved in this browser only. Nothing monitors or executes it; automation needs a keeper service (Phase 3).' },
  armed: { tone: 'on', label: 'Armed' },
  simulated: { tone: 'on', label: 'Simulated', hint: 'Simulated only. Nothing was signed or sent.' },
  skipped: { tone: 'warn', label: 'Skipped' },
  queued: { tone: 'off', label: 'Queued' },
  awaiting_signature: { tone: 'warn', label: 'Sign in wallet' },
  submitted: { tone: 'idle', label: 'Submitted' },
  confirming: { tone: 'on', label: 'Confirming' },
  processing: {
    tone: 'warn',
    label: 'Processing',
    hint: 'NEAR network is taking longer than usual. NEARKITS keeps checking the chain; don’t send this again until it settles.',
  },
  success: { tone: 'on', label: 'Confirmed' },
  failed: { tone: 'neg', label: 'Failed' },
  unknown: { tone: 'warn', label: 'Unknown', hint: 'The outcome is not confirmed. Check the explorer or your wallet before trying again.' },
  not_sent: { tone: 'off', label: 'Not sent' },
}

export type StatusKind = keyof typeof STATUS

/** Lamp + word. The word always carries the meaning; the lamp is reinforcement. */
export function StatusLamp({ status, className }: { status: StatusKind; className?: string }) {
  const s = STATUS[status]
  const body = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em]',
        s.tone === 'on' ? 'text-fg' : s.tone === 'warn' ? 'text-warn' : s.tone === 'neg' ? 'text-neg' : 'text-fg-3',
        className,
      )}
    >
      <Led tone={s.tone} />
      {s.label}
    </span>
  )
  return s.hint ? (
    <Tip content={s.hint} focusable>
      {body}
    </Tip>
  ) : (
    body
  )
}

/**
 * Page status for tools that move value: "Execution simulated" in the demo, the
 * network in real mode, or "view only" when this build can't sign (the mainnet switch,
 * or a missing fee account for trades).
 */
export function ExecutionTag({ trading = false }: { trading?: boolean }) {
  const caps = useCapabilities()
  if (caps.mode === 'demo') return <Tag tone="neutral">Execution simulated</Tag>
  const enabled = trading ? caps.execution.trading.enabled : caps.execution.enabled
  const reason = trading ? caps.execution.trading.reason : caps.execution.reason
  if (!enabled) {
    return (
      <Tag tone="warn" title={reason ?? undefined}>
        {caps.networkLabel} · view only
      </Tag>
    )
  }
  return <Tag tone="neutral">{caps.networkLabel}</Tag>
}

/** Where the figures on a page come from: demo data, or the named network. */
export function DataTag() {
  const caps = useCapabilities()
  return <Tag tone="neutral">{caps.mode === 'demo' ? 'Demo data' : `${caps.networkLabel} data`}</Tag>
}

/**
 * The standing disclosure under anything that executes: simulation in demo mode,
 * wallet signing on the named network in real mode, or why execution is off.
 */
export function SimulationNote({ className, children, demo, real }: { className?: string; children?: ReactNode; demo?: ReactNode; real?: ReactNode }) {
  const caps = useCapabilities()
  const soon = useInComingSoon()
  if (soon)
    return (
      <p className={cn('flex items-start gap-2 text-xs leading-4 text-fg-3', className)}>
        <Led tone="off" className="mt-[5px]" />
        <span>Coming soon. This is not available in the public beta yet, so nothing here can be signed, sent or saved.</span>
      </p>
    )
  const off = caps.mode === 'near' && !caps.execution.enabled && real === undefined
  const text =
    children ??
    (caps.mode === 'demo'
      ? (demo ?? 'Simulation only. Nothing is signed or sent in demo mode.')
      : (real ??
        (off
          ? (caps.execution.reason ?? 'Execution is disabled in this build.')
          : `You sign in your wallet; NEARKITS confirms the result on NEAR ${caps.networkLabel.toLowerCase()}.`)))
  return (
    <p className={cn('flex items-start gap-2 text-xs leading-4', off ? 'text-warn' : 'text-fg-3', className)}>
      <Led tone={caps.mode === 'demo' ? 'off' : off ? 'warn' : 'on'} className="mt-[5px]" />
      <span>{text}</span>
    </p>
  )
}
