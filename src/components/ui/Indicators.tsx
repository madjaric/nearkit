import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type LedTone = 'on' | 'off' | 'neg' | 'warn' | 'idle'

const LED: Record<LedTone, string> = {
  on: 'bg-accent',
  off: 'border border-fg-4',
  neg: 'bg-neg',
  warn: 'bg-warn',
  idle: 'bg-fg-4',
}

/** Status dot. Lit = active/connected, outline = off, red = fault, amber = caution. */
export function Led({ tone = 'on', size = 6, className, label }: { tone?: LedTone; size?: 6 | 8; className?: string; label?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('inline-block shrink-0 rounded-full', size === 6 ? 'size-1.5' : 'size-2', LED[tone], className)}
    />
  )
}

export type TagTone = 'neutral' | 'accent' | 'neg' | 'warn' | 'soon' | 'solid'

const TAG: Record<TagTone, string> = {
  neutral: 'border border-line text-fg-2',
  accent: 'border border-accent/35 bg-accent/10 text-accent',
  neg: 'border border-neg/35 bg-neg/10 text-neg',
  warn: 'border border-warn/35 bg-warn/10 text-warn',
  soon: 'border border-dashed border-fg-4 text-fg-2',
  solid: 'bg-raised text-fg-2',
}

/** Small uppercase label. `soon` (dashed) marks anything that is not live yet. */
export function Tag({ tone = 'neutral', children, className, title }: { tone?: TagTone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-[11px] font-semibold uppercase leading-none tracking-[0.06em]',
        TAG[tone],
        className,
      )}
      style={{ fontStretch: '92%' }}
    >
      {children}
    </span>
  )
}

export function ComingSoon({ className, label = 'Coming soon' }: { className?: string; label?: string }) {
  return (
    <Tag tone="soon" className={className}>
      {label}
    </Tag>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-grid h-5 min-w-5 place-items-center rounded-xs border border-line bg-raised/60 px-1 font-mono text-[10.5px] leading-none text-fg-3', className)}>
      {children}
    </kbd>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('block animate-ghost rounded-sm bg-raised', className)} />
}
