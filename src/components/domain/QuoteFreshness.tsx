import { InfoTip } from '@/components/ui/Help'
import { cn } from '@/lib/cn'
import { useNow } from '@/lib/hooks'

/**
 * Quote age as a draining bar: the price you see has a shelf life. When it runs
 * out the figures above it fade until the refreshed quote lands.
 */
export function QuoteFreshness({ quotedAt, expiresAt, fetching, className }: { quotedAt?: number; expiresAt?: number; fetching: boolean; className?: string }) {
  const now = useNow(500)
  if (!quotedAt || !expiresAt) {
    return (
      <div className={cn('flex items-center gap-2 text-xs text-fg-4', className)}>
        <span className="legend">Quote</span>
        <span className="h-1 flex-1 rounded-[1px] bg-line-soft" />
        <span className="num w-20 text-right">—</span>
      </div>
    )
  }
  const total = expiresAt - quotedAt
  const left = Math.max(0, expiresAt - now)
  const stale = left <= 0 || fetching
  return (
    <div className={cn('flex items-center gap-2 text-xs', className)}>
      <span className="legend flex items-center gap-1">
        Quote <InfoTip term="quoteAge" />
      </span>
      <span className="relative h-1 flex-1 overflow-hidden rounded-[1px] bg-line-soft">
        <span key={quotedAt} className="absolute inset-0 origin-left animate-drain bg-fg-3" style={{ animationDuration: `${total}ms` }} />
      </span>
      <span className={cn('w-20 text-right', stale ? 'text-fg-4' : 'num text-fg-3')} aria-live="off">
        {stale ? 'refreshing' : `${Math.ceil(left / 1000)}s`}
      </span>
    </div>
  )
}
