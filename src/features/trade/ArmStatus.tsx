import { SimulationNote } from '@/components/domain/Status'
import { Figures } from '@/components/ui/Figures'
import { cn } from '@/lib/cn'
import { ARM_MS } from './useArm'

/**
 * Under the fire key: a draining bar while armed; otherwise the reason the key
 * is blocked, if it is, above the standing simulation note.
 */
export function ArmStatus({ id, armedAt, tone, blocked, onCancel }: { id?: string; armedAt: number | null; tone: 'buy' | 'sell'; blocked?: string; onCancel: () => void }) {
  return (
    <div id={id} aria-live="polite" className="flex min-h-4 flex-col gap-1.5">
      {armedAt !== null ? (
        <div className="flex items-center gap-2 text-xs text-fg-3">
          <span className="relative h-1 flex-1 overflow-hidden rounded-[1px] bg-line-soft">
            <span
              key={armedAt}
              className={cn('absolute inset-0 origin-left animate-drain', tone === 'buy' ? 'bg-accent' : 'bg-neg')}
              style={{ animationDuration: `${ARM_MS}ms` }}
            />
          </span>
          <span>Armed. Press again to confirm</span>
          <button type="button" onClick={onCancel} className="text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg">
            Cancel
          </button>
        </div>
      ) : (
        <>
          {blocked && (
            <p className="text-xs leading-4 text-fg-3">
              <Figures>{blocked}</Figures>
            </p>
          )}
          <SimulationNote />
        </>
      )}
    </div>
  )
}
