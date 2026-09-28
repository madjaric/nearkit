import { cn } from '@/lib/cn'

/** The NearKit mark: an instrument screen with the wordmark's slash as its trace. */
export function LogoMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className={cn('shrink-0', className)}>
      <rect x="0.5" y="0.5" width="19" height="19" rx="3" className="fill-panel stroke-line-strong" />
      <path d="M6.2 14.6 13.8 5.4" className="stroke-accent" strokeWidth="2.3" strokeLinecap="square" />
    </svg>
  )
}

/** Text wordmark: NEAR/KIT, set extended like a silkscreened panel name. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex select-none items-baseline text-[15px] font-bold leading-none tracking-[0.07em] text-fg', className)}
      style={{ fontStretch: '118%' }}
      aria-label="NearKit"
    >
      <span aria-hidden="true">NEAR</span>
      <span aria-hidden="true" className="mx-[1px] text-accent">
        /
      </span>
      <span aria-hidden="true">KIT</span>
    </span>
  )
}
