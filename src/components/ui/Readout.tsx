import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Figures } from './Figures'
import { Skeleton } from './Indicators'

/**
 * A row of stat cards: each a bordered surface with a plain label, a large mono value and one
 * caption line. Values never shift when digits change; an absent value prints a ghost figure.
 */
export function ReadoutStrip({ children, className, cols = 'grid-cols-2 lg:grid-cols-4' }: { children: ReactNode; className?: string; cols?: string }) {
  return <div className={cn('grid gap-3', cols, className)}>{children}</div>
}

interface ReadoutSlotProps {
  legend: ReactNode
  value: ReactNode
  sub?: ReactNode
  loading?: boolean
  size?: 'md' | 'lg'
  className?: string
  /** Right of the label: a freshness age, an icon, a tag. */
  aside?: ReactNode
  /** Drawn at the card's right edge, beside the value (a sparkline, an icon). */
  trace?: ReactNode
}

export function ReadoutSlot({ legend, value, sub, loading = false, size = 'md', className, aside, trace }: ReadoutSlotProps) {
  return (
    <div className={cn('@container flex min-w-0 flex-col justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-fg-3">{legend}</span>
        {aside && <span className="shrink-0 text-fg-3">{aside}</span>}
      </div>
      {loading ? (
        <>
          <Skeleton className={cn('mt-1', size === 'lg' ? 'h-8 w-40' : 'h-7 w-28')} />
          <Skeleton className="h-3.5 w-24" />
        </>
      ) : (
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className={cn('num truncate text-fg', size === 'lg' ? 'text-2xl @[13rem]:text-3xl' : 'text-xl @[12.5rem]:text-2xl')}>{value}</div>
            <div className="mt-1 min-h-4 text-xs text-fg-3">
              <Figures>{sub}</Figures>
            </div>
          </div>
          {trace && <div className="hidden shrink-0 text-fg-4 @[17rem]:block">{trace}</div>}
        </div>
      )}
    </div>
  )
}
