import { bridgeChain, type BridgeChain } from '@/config/bridge'
import { bridgeHeadline } from '@/lib/bridge/progress'
import type { BridgeOrderView } from '@/lib/bridge/types'
import type { ActivityItem, ActivityStatus } from '@/types/domain'
import { orderSummary } from './format'

/**
 * A bridge order in Activity, titled by its product: "Bridge & Buy · 1 SOL → 123,456 KITS · Solana →
 * NEAR · Completed", or "Bridge · 0.06 SOL → 1.42 NEAR · Solana → NEAR · Completed", linked to the
 * order's own page. Its status is the order's: success only once $KITS (Bridge & Buy) or the NEAR
 * (Bridge) arrived; partial when it bridged but stopped short ($KITS not bought, wNEAR not unwrapped).
 */

const STATUS = (o: BridgeOrderView): ActivityStatus =>
  o.status === 'complete'
    ? 'success'
    : o.status === 'buy-needed' || o.status === 'unwrap-needed'
      ? 'partial'
      : o.status === 'refunded' || o.status === 'failed' || o.status === 'expired'
        ? 'failed'
        : 'pending'

/** Where an order's own page is: Bridge & Buy on /bridge, the Bridge on /bridge-near. */
export const orderHref = (o: Pick<BridgeOrderView, 'id' | 'product'>) => `${o.product === 'bridge' ? '/bridge-near' : '/bridge'}?order=${encodeURIComponent(o.id)}`

export function bridgeActivity(o: BridgeOrderView): ActivityItem {
  const chain = bridgeChain(o.chain) as BridgeChain
  return {
    id: `bridge:${o.id}`,
    kind: 'bridge',
    title: o.product === 'bridge' ? 'Bridge' : 'Bridge & Buy',
    detail: `${orderSummary(o)} · ${chain.name} → NEAR · ${bridgeHeadline(o)}`,
    at: o.createdAt,
    origin: 'nearkit',
    status: STATUS(o),
    network: 'mainnet',
    accountId: o.destination.accountId,
    txHashes: [
      ...(o.depositTx ? [o.depositTx.hash] : []),
      ...(o.delivered?.txs.map((t) => t.hash) ?? []),
      ...(o.kits?.txs.map((t) => t.hash) ?? []),
      ...(o.unwrapped?.txs.map((t) => t.hash) ?? []),
    ],
    href: orderHref(o),
  }
}

/** The activity list with bridge orders (both products) in it, newest first, at most `limit`. */
export function withBridgeActivity(items: readonly ActivityItem[], orders: readonly BridgeOrderView[], limit: number): ActivityItem[] {
  return [...items, ...orders.map(bridgeActivity)].sort((a, b) => b.at - a.at).slice(0, limit)
}
