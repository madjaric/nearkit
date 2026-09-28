import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Figures } from './Figures'

/** A tiny scope screen with a flat trace: "no signal yet", drawn on purpose. */
function Flatline() {
  const cols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  return (
    <svg width="132" height="44" viewBox="0 0 132 44" aria-hidden="true" className="shrink-0">
      <rect x="0.5" y="0.5" width="131" height="43" rx="3" className="fill-well stroke-line" />
      {cols.map((c) => (
        <line key={`v${c}`} x1={12 * c + 6} y1="4" x2={12 * c + 6} y2="40" className="stroke-line-soft" strokeWidth="1" />
      ))}
      {[1, 2].map((r) => (
        <line key={`h${r}`} x1="4" y1={14 * r + 1} x2="128" y2={14 * r + 1} className="stroke-line-soft" strokeWidth="1" />
      ))}
      <line x1="8" y1="22" x2="124" y2="22" className="stroke-fg-4" strokeWidth="1.5" />
      <rect x="119" y="19.5" width="5" height="5" rx="1" className="fill-fg-4" />
    </svg>
  )
}

interface EmptyStateProps {
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  graphic?: boolean
  className?: string
}

/** Empty states teach the next step instead of saying "nothing here". */
export function EmptyState({ title, children, action, graphic = true, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
      {graphic && <Flatline />}
      <div className="max-w-sm">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children && (
          <div className="mt-1 text-sm text-fg-3">
            <Figures>{children}</Figures>
          </div>
        )}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  )
}
