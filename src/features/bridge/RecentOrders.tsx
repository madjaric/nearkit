import { ChevronRight } from 'lucide-react'
import { ChainMark } from '@/components/brand/ChainMark'
import { Figures } from '@/components/ui/Figures'
import { Tag } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { bridgeChain, type BridgeChain } from '@/config/bridge'
import { bridgeHeadline, bridgeTone } from '@/lib/bridge/progress'
import type { BridgeOrderView } from '@/lib/bridge/types'
import { cn } from '@/lib/cn'
import { formatAgo } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { orderSummary } from './format'

const TONE = { accent: 'accent', warn: 'warn', danger: 'neg', neutral: 'neutral' } as const

export function RecentOrders({ orders, current, onOpen }: { orders: BridgeOrderView[]; current: string | null; onOpen: (id: string) => void }) {
  const now = useNow(30_000)
  if (!orders.length) return null
  return (
    <Panel aria-label="Your Bridge & Buy orders">
      <PanelHeader title="Your Bridge & Buy orders" meta={orders.length} />
      <ul className="divide-y divide-line-soft">
        {orders.slice(0, 8).map((o) => (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onOpen(o.id)}
              aria-current={o.id === current ? 'true' : undefined}
              className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised', o.id === current && 'bg-raised')}
            >
              <ChainMark chain={o.chain} size={22} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">
                  <Figures>{orderSummary(o)}</Figures>
                </span>
                <span className="block truncate text-xs text-fg-3">
                  <span className="sm:hidden">{bridgeHeadline(o)} · </span>
                  {(bridgeChain(o.chain) as BridgeChain).name} → NEAR · {o.destination.name ?? o.destination.accountId}
                </span>
              </span>
              <span className="hidden shrink-0 sm:block">
                <Tag tone={TONE[bridgeTone(o.status)]}>{bridgeHeadline(o)}</Tag>
              </span>
              <time dateTime={new Date(o.createdAt).toISOString()} className="shrink-0 text-xs text-fg-3">
                {formatAgo(o.createdAt, now)}
              </time>
              <ChevronRight size={14} className="shrink-0 text-fg-3" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
