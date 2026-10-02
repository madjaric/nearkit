import { Led } from '@/components/ui/Indicators'
import { cn } from '@/lib/cn'
import { useNow } from '@/lib/hooks'
import { useBalanceRefresh } from '@/services/queries'

/** How long "Balances may lag" stays up after the last try. */
const STALE_NOTICE_MS = 60_000
/** How long "Balances updated" stays up. */
const DONE_NOTICE_MS = 4_000

/**
 * The post-trade balance refresh, in a few words: "Updating balances…" while NearKit
 * asks the chain again, "Balances updated" once they show the trade, or "Balances may
 * lag" when the readers still hadn't caught up after the last try. Never a page reload.
 */
export function BalanceRefreshStatus({ className, terse = false }: { className?: string; terse?: boolean }) {
  const status = useBalanceRefresh()
  const now = useNow(1000)
  // `terse`: where a phone has no room for the words (the top bar), the lamp says it; the words stay for screen readers.
  const words = terse ? 'max-sm:sr-only' : undefined
  if (status.state === 'updating')
    return (
      <span role="status" className={cn('flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-3', className)}>
        <Led tone="on" className="animate-pulse" /> <span className={words}>Updating balances…</span>
      </span>
    )
  if (status.state === 'updated' && now - status.at < DONE_NOTICE_MS)
    return (
      <span role="status" className={cn('flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-3', className)}>
        <Led tone="on" /> <span className={words}>Balances updated</span>
      </span>
    )
  if (status.state === 'stale' && now - status.at < STALE_NOTICE_MS)
    return (
      <span
        role="status"
        title="The trade is confirmed on chain. The balance readers hadn't caught up yet; they refresh on their own."
        className={cn('flex items-center gap-1.5 whitespace-nowrap text-[11px] text-warn', className)}
      >
        <Led tone="warn" /> <span className={words}>Balances may lag</span>
      </span>
    )
  return null
}
