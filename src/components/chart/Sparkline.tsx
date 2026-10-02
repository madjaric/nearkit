import { useId } from 'react'
import { cn } from '@/lib/cn'

/**
 * A small trace of a series, for a stat card: the line and a faint fill under it, no axes.
 * Drawn only from the points given; fewer than two draws nothing.
 */
export function Sparkline({ values, width = 120, height = 36, className }: { values: readonly number[]; width?: number; height?: number; className?: string }) {
  const id = useId()
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length < 2) return null
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const span = max - min || 1
  const pad = 2
  const x = (i: number) => pad + (i / (finite.length - 1)) * (width - pad * 2)
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2)
  const line = finite.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className={cn('shrink-0 overflow-visible', className)}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.25" />
          <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L ${x(finite.length - 1).toFixed(1)} ${height} L ${x(0).toFixed(1)} ${height} Z`} fill={`url(#${id})`} stroke="none" />
      <path d={line} fill="none" className="stroke-accent" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
