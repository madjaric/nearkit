import { cn } from '@/lib/cn'

/** The NEARKITS mark: an instrument screen with an accent slash as its trace. */
export function LogoMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className={cn('shrink-0', className)}>
      <rect x="0.5" y="0.5" width="19" height="19" rx="3" className="fill-panel stroke-line-strong" />
      <path d="M6.2 14.6 13.8 5.4" className="stroke-accent" strokeWidth="2.3" strokeLinecap="square" />
    </svg>
  )
}

/** Text wordmark: NEARKITS, set extended like a silkscreened panel name; the mark beside it carries the accent. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex select-none items-baseline text-[15px] font-bold leading-none tracking-[0.07em] text-fg', className)}
      style={{ fontStretch: '118%' }}
      aria-label="NEARKITS"
    >
      <span aria-hidden="true">NEARKITS</span>
    </span>
  )
}
