import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Led, Skeleton, Tag } from '@/components/ui/Indicators'
import { formatAgo } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import type { ActivityItem } from '@/types/domain'

/** Event log: newest first, simulated entries lit, demo history dim. */
export function ActivityList({ items, loading = false }: { items: ActivityItem[]; loading?: boolean }) {
  const now = useNow(30_000)
  if (loading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="mt-1.5 size-1.5" />
            <div className="flex-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-1.5 h-3 w-56" />
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (items.length === 0) {
    return <EmptyState title="No activity yet">Trades, transfers and saved rules show up here as you use the tools.</EmptyState>
  }
  return (
    <ol className="divide-y divide-line-soft" aria-label="Recent activity">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-3 px-4 py-2.5">
          <Led tone={item.origin === 'simulated' ? 'on' : 'idle'} className="mt-[7px]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm text-fg">{item.title}</p>
              {item.origin === 'simulated' && <Tag tone="accent">This session</Tag>}
            </div>
            <p className="truncate text-xs text-fg-3">
              <Figures>{item.detail}</Figures>
            </p>
          </div>
          <time dateTime={new Date(item.at).toISOString()} className="shrink-0 pt-0.5 text-xs text-fg-3">
            <Figures>{formatAgo(item.at, now)}</Figures>
          </time>
        </li>
      ))}
    </ol>
  )
}
