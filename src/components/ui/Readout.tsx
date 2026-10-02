import { createContext, useContext, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Figures } from './Figures'
import { Skeleton } from './Indicators'

const InsetContext = createContext(false)

/**
 * A row of stats. On the page it is a row of cards: each a bordered surface with a plain label,
 * a large mono value and a caption. Inside a panel (`inset`) the same slots are flat cells
 * divided by hairlines, so a card never sits inside a card.
 */
export function ReadoutStrip({
  children,
  className,
  cols = 'grid-cols-2 lg:grid-cols-4',
  inset = false,
}: {
  children: ReactNode
  className?: string
  cols?: string
  inset?: boolean
}) {
  return (
    <InsetContext.Provider value={inset}>
      <div className={cn('grid', inset ? 'overflow-hidden' : 'gap-3', cols, className)}>{children}</div>
    </InsetContext.Provider>
  )
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
  /** Printed after the value in the UI face (NEAR), when there is room for it. */
  unit?: ReactNode
  /** Drawn at the slot's right edge, beside the value (a sparkline), when there is room for it. */
  trace?: ReactNode
}

/**
 * The value sizes to its slot (a share of the slot's width, between a floor and the display
 * size), so a figure of up to eleven characters fits at any width and digits never shift.
 */
const VALUE_SIZE = {
  md: 'text-[length:clamp(1.125rem,14cqi,1.75rem)] leading-[1.2]',
  lg: 'text-[length:clamp(1.25rem,15cqi,2rem)] leading-[1.2]',
}

export function ReadoutSlot({ legend, value, sub, loading = false, size = 'md', className, aside, unit, trace }: ReadoutSlotProps) {
  const inset = useContext(InsetContext)
  return (
    <div
      className={cn(
        '@container flex min-w-0 flex-col gap-2',
        // Inset cells draw their right and bottom rules one pixel past the strip, which clips its outer edge.
        inset ? '-mb-px -mr-px border-b border-r border-line-soft px-4 py-3.5' : 'justify-between rounded-lg border border-line bg-panel px-4 py-4',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-fg-3">{legend}</span>
        {aside && <span className="shrink-0 text-fg-3">{aside}</span>}
      </div>
      {loading ? (
        <>
          <Skeleton className={cn('mt-1', size === 'lg' ? 'h-8 w-40' : 'h-7 w-28')} />
          <Skeleton className="h-3.5 w-24" />
        </>
      ) : (
        <div className="min-w-0">
          {/* The value comes first: a unit or a trace prints only if it fits beside it. What doesn't fit wraps to a second line, which this row's height clips. */}
          <div className={cn('num flex h-[1.2em] flex-wrap content-start items-baseline gap-x-2 overflow-hidden text-fg', VALUE_SIZE[size])}>
            <div className="max-w-full truncate">{value}</div>
            {unit && <div className="font-sans text-base font-medium text-fg-3">{unit}</div>}
            {trace && <div className="ml-auto hidden h-[1.2em] items-center self-start pl-1 text-fg-4 @[17rem]:flex">{trace}</div>}
          </div>
          <div className="mt-1 min-h-4 text-xs text-fg-3">
            <Figures>{sub}</Figures>
          </div>
        </div>
      )}
    </div>
  )
}
