import { useId, useState } from 'react'
import { InfoTip } from '@/components/ui/Help'
import { cn } from '@/lib/cn'
import { SLIPPAGE_PRESETS } from '@/lib/fees'
import { slippageIssue } from '@/lib/slippage'

const PERCENTS = [
  { label: '25%', fraction: 0.25 },
  { label: '50%', fraction: 0.5 },
  { label: '75%', fraction: 0.75 },
  { label: 'MAX', fraction: 1 },
]

/** 25 / 50 / 75 / MAX keys. `active` lights the key whose fraction the current amount matches. */
export function PercentKeys({ onPick, active, disabled, className }: { onPick: (fraction: number) => void; active?: number | null; disabled?: boolean; className?: string }) {
  return (
    <div className={cn('grid grid-cols-4 gap-1', className)} role="group" aria-label="Amount presets">
      {PERCENTS.map((p) => {
        const on = active !== null && active !== undefined && Math.abs(active - p.fraction) < 1e-6
        return (
          <button
            key={p.label}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onPick(p.fraction)}
            className={cn(
              'keycap h-7 rounded-xs border text-2xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line bg-raised/50 text-fg-2 hover:border-line-strong hover:text-fg',
            )}
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}

/** Preset keys plus a custom field. Warnings are printed under the control, never hidden in a tooltip. */
export function SlippageControl({ value, onChange, className, hideLabel = false }: { value: number; onChange: (value: number) => void; className?: string; hideLabel?: boolean }) {
  const id = useId()
  const isPreset = SLIPPAGE_PRESETS.some((p) => p === value)
  const [custom, setCustom] = useState(isPreset ? '' : String(value))
  const issue = slippageIssue(value)

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className={cn('flex items-center justify-between gap-2', hideLabel && 'sr-only')}>
        <span id={`${id}-label`} className="legend flex items-center gap-1.5">
          Slippage <InfoTip term="slippage" />
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1" role="group" aria-labelledby={`${id}-label`}>
        {SLIPPAGE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={value === p && custom === ''}
            onClick={() => {
              setCustom('')
              onChange(p)
            }}
            className={cn(
              'num h-7 rounded-xs border text-xs transition-colors',
              value === p && custom === '' ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line bg-raised/50 text-fg-2 hover:border-line-strong hover:text-fg',
            )}
          >
            {p}%
          </button>
        ))}
        <div
          className={cn(
            'flex h-7 items-center rounded-xs border bg-well pr-1.5 transition-colors focus-within:border-accent',
            custom !== '' ? (issue?.level === 'error' ? 'border-neg' : 'border-accent/50') : 'border-line',
          )}
        >
          <input
            aria-label="Custom slippage percent"
            inputMode="decimal"
            placeholder="Custom"
            value={custom}
            onChange={(e) => {
              const next = e.target.value.replace(',', '.')
              if (next !== '' && !/^\d*\.?\d*$/.test(next)) return
              setCustom(next)
              const n = Number(next)
              if (next !== '' && Number.isFinite(n)) onChange(n)
              if (next === '') onChange(SLIPPAGE_PRESETS[1])
            }}
            aria-invalid={custom !== '' && issue?.level === 'error'}
            className="num h-full w-full min-w-0 bg-transparent px-1.5 text-center text-xs text-fg placeholder:font-sans placeholder:text-fg-3 focus:outline-none"
          />
          {custom !== '' && <span className="text-xs text-fg-3">%</span>}
        </div>
      </div>
      {issue && <p className={cn('text-xs', issue.level === 'error' ? 'text-neg' : 'text-warn')}>{issue.message}</p>}
    </div>
  )
}
