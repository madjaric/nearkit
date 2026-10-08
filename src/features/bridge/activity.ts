import { bridgeChain, type BridgeChain } from '@/config/bridge'
import { bridgeHeadline } from '@/lib/bridge/progress'
import type { BridgeOrderView } from '@/lib/bridge/types'
import type { ActivityItem, ActivityStatus } from '@/types/domain'
import { orderSummary } from './format'

/**
 * A Bridge & Buy order in Activity: "Bridge & Buy · 1 SOL → 123,456 KITS · Solana → NEAR ·
 * Completed", linked to the order's own page. Its status is the order's: success only once $KITS
 * arrived.
 */

const STATUS = (o: BridgeOrderView): ActivityStatus =>
  o.status === 'complete' ? 'success' : o.status === 'buy-needed' ? 'partial' : o.status === 'refunded' || o.status === 'failed' || o.status === 'expired' ? 'failed' : 'pending'

export function bridgeActivity(o: BridgeOrderView): ActivityItem {
  const chain = bridgeChain(o.chain) as BridgeChain
  return {
    id: `bridge:${o.id}`,
    kind: 'bridge',
    title: 'Bridge & Buy',
    detail: `${orderSummary(o)} · ${chain.name} → NEAR · ${bridgeHeadline(o)}`,
    at: o.createdAt,
    origin: 'nearkit',
    status: STATUS(o),
    network: 'mainnet',
    accountId: o.destination.accountId,
    txHashes: [...(o.depositTx ? [o.depositTx.hash] : []), ...(o.delivered?.txs.map((t) => t.hash) ?? []), ...(o.kits?.txs.map((t) => t.hash) ?? [])],
    href: `/bridge?order=${encodeURIComponent(o.id)}`,
  }
}

/** The activity list with Bridge & Buy orders in it, newest first, at most `limit`. */
export function withBridgeActivity(items: readonly ActivityItem[], orders: readonly BridgeOrderView[], limit: number): ActivityItem[] {
  return [...items, ...orders.map(bridgeActivity)].sort((a, b) => b.at - a.at).slice(0, limit)
}
