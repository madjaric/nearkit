import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Figures } from './Figures'

/** A module on the front panel: one bordered surface, never nested inside another. */
export function Panel({ className, children, ...rest }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <section className={cn('min-w-0 rounded-md border border-line bg-panel', className)} {...rest}>
      {children}
    </section>
  )
}

interface PanelHeaderProps {
  title: ReactNode
  /** Counter or unit printed after the title. */
  meta?: ReactNode
  actions?: ReactNode
  className?: string
  id?: string
}

export function PanelHeader({ title, meta, actions, className, id }: PanelHeaderProps) {
  return (
    <header className={cn('flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line-soft px-4 py-2', className)}>
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 id={id} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-legend text-fg-2" style={{ fontStretch: '88%' }}>
          <span aria-hidden="true" className="h-2 w-1.5 shrink-0 border-l border-t border-line-strong" />
          {title}
        </h2>
        {meta !== undefined && meta !== null && meta !== false && (
          <span className="text-xs text-fg-3">
            <Figures>{meta}</Figures>
          </span>
        )}
      </div>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
    </header>
  )
}

export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-4', className)}>{children}</div>
}

/**
 * Key/value line used in summaries: label left, measurement right. A text value
 * sets its figures in mono and its words in sans; `mono` forces one face.
 */
export function Line({ label, children, className, emphasis = false, mono }: { label: ReactNode; children: ReactNode; className?: string; emphasis?: boolean; mono?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 py-1 group-data-[dense]/lines:py-0', className)}>
      <dt className={cn('flex min-w-0 items-center gap-1.5 text-sm', emphasis ? 'text-fg' : 'text-fg-3')}>
        <Figures>{label}</Figures>
      </dt>
      <dd className={cn('min-w-0 text-right text-sm', (mono ?? typeof children !== 'string') && 'num', emphasis ? 'text-fg' : 'text-fg-2')}>
        {typeof children === 'string' && mono === undefined ? <Figures>{children}</Figures> : children}
      </dd>
    </div>
  )
}

/** Stack of Lines. `dense` drops the row padding for tickets that must fit above the fold. */
export function Lines({ children, className, dense = false }: { children: ReactNode; className?: string; dense?: boolean }) {
  return (
    <dl data-dense={dense || undefined} className={cn('group/lines flex flex-col', className)}>
      {children}
    </dl>
  )
}

/** Hairline with a silkscreen legend, used to group controls inside a panel. */
export function Legend({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="legend shrink-0">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-line-soft" />
      {action}
    </div>
  )
}
