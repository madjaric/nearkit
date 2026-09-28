import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Figures } from './Figures'
import { Skeleton } from './Indicators'

/**
 * Fixed-slot measurement strip. Slots are separated by 1px rules (the strip's
 * ground shows through a 1px gap), and values never shift when digits change.
 */
export function ReadoutStrip({ children, className, cols = 'grid-cols-2 lg:grid-cols-4' }: { children: ReactNode; className?: string; cols?: string }) {
  return <div className={cn('grid gap-px overflow-hidden rounded-md border border-line bg-line-soft', cols, className)}>{children}</div>
}

interface ReadoutSlotProps {
  legend: ReactNode
  value: ReactNode
  sub?: ReactNode
  loading?: boolean
  size?: 'md' | 'lg'
  className?: string
  aside?: ReactNode
}

export function ReadoutSlot({ legend, value, sub, loading = false, size = 'md', className, aside }: ReadoutSlotProps) {
  return (
    <div className={cn('flex min-w-0 flex-col justify-between gap-1 bg-panel px-3 py-3 sm:px-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="legend flex items-center gap-1.5">{legend}</span>
        {aside}
      </div>
      {loading ? (
        <>
          <Skeleton className={cn('mt-1', size === 'lg' ? 'h-7 w-40' : 'h-6 w-28')} />
          <Skeleton className="h-3.5 w-24" />
        </>
      ) : (
        <>
          <div className={cn('num truncate text-fg', size === 'lg' ? 'text-xl sm:text-2xl' : 'text-lg sm:text-xl')}>{value}</div>
          <div className="min-h-4 text-xs text-fg-3">
            <Figures>{sub}</Figures>
          </div>
        </>
      )}
    </div>
  )
}
