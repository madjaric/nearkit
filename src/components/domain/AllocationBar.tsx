import { Figures } from '@/components/ui/Figures'
import { Led } from '@/components/ui/Indicators'
import type { BalanceState } from '@/lib/allocation'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'

interface Segment {
  key: string
  label: string
  value: number
}

const STATE_COPY: Record<BalanceState, { label: string; tone: 'on' | 'warn' | 'neg' | 'off' }> = {
  balanced: { label: 'Balanced', tone: 'on' },
  under: { label: 'Under-allocated', tone: 'warn' },
  over: { label: 'Over-allocated', tone: 'neg' },
  invalid: { label: 'Invalid value', tone: 'neg' },
  empty: { label: 'Nothing allocated', tone: 'off' },
}

/**
 * Stacked allocation bar: one segment per wallet against a fixed budget. The
 * unfilled remainder is hatched; anything past the budget is drawn in red.
 */
export function AllocationBar({
  segments,
  budget,
  state,
  unit,
  className,
  summary,
}: {
  segments: Segment[]
  budget: number
  state: BalanceState
  unit: string
  className?: string
  summary?: string
}) {
  const used = segments.reduce((s, x) => s + Math.max(0, x.value), 0)
  const scale = Math.max(budget, used) || 1
  const over = Math.max(0, used - budget)
  const remaining = Math.max(0, budget - used)
  const copy = STATE_COPY[state]

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        className="flex h-2.5 w-full gap-px overflow-hidden rounded-xs bg-well"
        role="img"
        aria-label={`${copy.label}: ${formatNumber(used, 0, 4)} of ${formatNumber(budget, 0, 4)} ${unit} allocated across ${segments.length} wallets`}
      >
        {segments.map((seg, i) => {
          const width = (Math.min(seg.value, Math.max(0, budget - segments.slice(0, i).reduce((s, x) => s + x.value, 0))) / scale) * 100
          if (width <= 0) return null
          return (
            <span
              key={seg.key}
              title={`${seg.label}: ${formatNumber(seg.value, 0, 4)} ${unit}`}
              className={cn('h-full shrink-0', state === 'balanced' ? (i % 2 === 0 ? 'bg-accent/80' : 'bg-accent/55') : i % 2 === 0 ? 'bg-fg-3' : 'bg-fg-4')}
              style={{ width: `${width}%` }}
            />
          )
        })}
        {remaining > 0 && <span className="h-full flex-1" style={{ backgroundImage: 'repeating-linear-gradient(135deg, var(--color-line) 0 2px, transparent 2px 6px)' }} />}
        {over > 0 && <span className="h-full shrink-0 bg-neg" style={{ width: `${(over / scale) * 100}%` }} />}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <span
          className={cn(
            'flex items-center gap-1.5 font-medium uppercase tracking-[0.06em]',
            copy.tone === 'on' ? 'text-accent' : copy.tone === 'warn' ? 'text-warn' : copy.tone === 'neg' ? 'text-neg' : 'text-fg-3',
          )}
        >
          <Led tone={copy.tone} />
          {copy.label}
        </span>
        {summary && (
          <span className="text-fg-3">
            <Figures>{summary}</Figures>
          </span>
        )}
      </div>
    </div>
  )
}
