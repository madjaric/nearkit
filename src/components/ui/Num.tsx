import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { formatAmount, formatPct, formatPrice, formatUsd, formatUsdCompact } from '@/lib/format'
import { toneOf } from '@/lib/tone'

interface NumProps {
  className?: string
  /** Explains an unknown (null) value on hover. */
  unknownHint?: string
}

/** An unknown figure: a quiet dash, never a zero that could be mistaken for a value. */
function Unknown({ className, hint }: { className?: string; hint?: string }) {
  return (
    <span className={cn('num text-fg-4', className)} title={hint ?? 'Not available'}>
      —
    </span>
  )
}

export function Usd({
  value,
  signed = false,
  colored = false,
  compact = false,
  className,
  unknownHint,
}: NumProps & { value: number | null; signed?: boolean; colored?: boolean; compact?: boolean }) {
  if (value === null) return <Unknown className={className} hint={unknownHint} />
  const text = compact ? formatUsdCompact(value) : formatUsd(value, { signed })
  const shown = compact && signed && value > 0 ? `+${text}` : text
  return <span className={cn('num', colored && toneOf(value), className)}>{shown}</span>
}

export function Price({ value, className, unknownHint }: NumProps & { value: number | null }) {
  if (value === null) return <Unknown className={className} hint={unknownHint} />
  return <span className={cn('num', className)}>${formatPrice(value)}</span>
}

export function Pct({
  value,
  signed = true,
  colored = true,
  className,
  decimals = 2,
  unknownHint,
}: NumProps & { value: number | null; signed?: boolean; colored?: boolean; decimals?: number }) {
  if (value === null) return <Unknown className={className} hint={unknownHint} />
  return <span className={cn('num', colored && toneOf(value), className)}>{formatPct(value, { signed, decimals })}</span>
}

/** Token amount with an optional unit; the unit is set in the sans face, smaller and quieter. */
export function Amount({ value, unit, minDecimals = 0, className, unitClassName }: NumProps & { value: number; unit?: ReactNode; minDecimals?: number; unitClassName?: string }) {
  return (
    <span className={cn('whitespace-nowrap', className)}>
      <span className="num">{formatAmount(value, minDecimals)}</span>
      {unit && <span className={cn('ml-1 text-[0.86em] font-medium tracking-[0.02em] text-fg-3', unitClassName)}>{unit}</span>}
    </span>
  )
}
