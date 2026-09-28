import { Tip } from '@/components/ui/Floating'
import { cn } from '@/lib/cn'

/**
 * Marks a figure that exists only in the simulation. Used wherever a pre-launch
 * token ($KIT) shows a price, entry or exit, so it never reads as market data.
 */
export function SimMark({ className }: { className?: string }) {
  return (
    <Tip content="Simulated figure. $KIT has not launched, so it has no market price." className={cn('ml-1 align-middle', className)}>
      <span
        tabIndex={0}
        aria-label="Simulated figure"
        className="inline-flex h-[14px] items-center rounded-[2px] border border-dashed border-fg-4 px-[3px] font-sans text-[9px] font-semibold uppercase leading-none tracking-[0.06em] text-fg-3"
      >
        sim
      </span>
    </Tip>
  )
}
